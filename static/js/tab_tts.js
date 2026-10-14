// Tab 3 - speech synthesis workbench.
//
// Every click on 生成 appends a new record to a history list; nothing is ever
// overwritten in place. Inside a record the text is split into sentences that
// are generated independently, so any single one can be re-generated without
// touching the others, and the record downloads as one complete WAV made of
// its generated sentences.
//
// Records are persisted to IndexedDB so a refresh keeps the history.

import {
  PcmPlayer,
  ResilientSocket,
  clearTtsRecords,
  deleteTtsRecord,
  loadTtsRecords,
  pcmToWavBlob,
  saveTtsRecord,
  segmentKey,
  splitSentences,
} from '/static/js/audio.js';
import { api, applySocketStatus, el, state } from '/static/js/app.js';
import { buildInstruction } from '/static/js/instruct.js';
import { nextSeed, resolveSeed } from '/static/js/seed_policy.js';
import { applyRules, hasAnyTag, stripKnownTags } from '/static/js/tag_rules.js';
import { VOICEOVER_PROMPT } from '/static/js/voiceover_prompt.js';

const SAMPLE_RATE = 22050;
const MAX_RECORDS = 30;
const MODEL_STORAGE_KEY = 'tts.tagModel';
const TEXT_UNDO_LIMIT = 20;   // a 2000-char script x 20 is still trivial to hold

let socket = null;
let player = null;
let records = [];          // newest first
let openIds = new Set();   // records whose sentence list is expanded
let busyRecord = null;     // record currently generating
let pendingResolve = null;

// ---- settings -------------------------------------------------------------

function activeModel() {
  const id = el('tts-model').value;
  return (state.config.tts_models || []).find((m) => m.id === id) || null;
}

function currentParams() {
  const model = activeModel();
  const params = {
    model: model ? model.id : undefined,
    volume: Number(el('tts-volume').value),
    speech_rate: Number(el('tts-rate').value),
    pitch_rate: Number(el('tts-pitch').value),
  };

  // Always sent, even when the field is left blank: resolveSeed picks one and
  // records it, so "随机" means reproducible-by-recording rather than "whatever
  // the model felt like this time".
  params.seed = resolveSeed(el('tts-seed').value);

  const kind = el('tts-instruct-kind').value;
  // Shared with the voice-clone tab so the two cannot drift; see instruct.js.
  const instruction = buildInstruction(
    kind,
    kind === 'custom' ? '' : el('tts-instruct-value').value,
    el('tts-instruct-custom').value
  );
  if (instruction) params.instruction = instruction;
  return params;
}

function currentVoiceId() {
  return el('tts-voice').value;
}

/** Verified values for the selected kind, taken from the voice's profile. */
function instructionValues() {
  const kind = el('tts-instruct-kind').value;
  if (!kind || kind === 'custom') return [];
  const profiles = state.config.instruct_profiles || {};
  const voice = currentVoiceId();
  // The profile map only carries kind metadata, so the values come from the
  // matching catalogue entry on the client side.
  const catalogue = state.config.instruct_value_map || {};
  return catalogue[`${voice}|${kind}`] || [];
}

// ---- emotion tags ---------------------------------------------------------

/** Models that understand inline [tags]; cosyvoice ignores or rejects them. */
function tagModelActive() {
  const model = activeModel();
  return !!(model && (state.config.tag_models || []).includes(model.id));
}

function insertTag(tag) {
  const textarea = el('tts-text');
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  textarea.value = textarea.value.slice(0, start) + tag + textarea.value.slice(end);
  const caret = start + tag.length;
  textarea.focus();
  textarea.setSelectionRange(caret, caret);
}

function renderTagChips() {
  const panel = el('tts-tags');
  const supported = tagModelActive();
  panel.hidden = !supported;

  if (!supported) {
    // Switching to a model that ignores tags would have them read aloud, so
    // drop them from the script rather than let it fail downstream.
    const textarea = el('tts-text');
    if (textarea.value.trim() && hasTags(textarea.value)) {
      textarea.value = stripTags(textarea.value);
      textarea.dispatchEvent(new Event('input'));
    }
    return;
  }

  const fill = (node, items, cls) => {
    node.innerHTML = '';
    for (const item of items) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `tag-chip ${cls}`;
      chip.textContent = item.name;
      chip.title = item.tag;
      chip.addEventListener('click', () => insertTag(item.tag));
      node.appendChild(chip);
    }
  };
  fill(el('tts-control-tags'), state.config.control_tags || [], '');
  fill(el('tts-rich-tags'), state.config.rich_tags || [], 'rich');
}

function lastControlTag(text) {
  const tags = state.config.control_tags || [];
  let found = '';
  let position = -1;
  for (const item of tags) {
    const at = text.lastIndexOf(item.tag);
    if (at > position) {
      position = at;
      found = item.tag;
    }
  }
  return found;
}

/** All tags the current config knows about, as literal strings. */
function allTags() {
  const control = (state.config.control_tags || []).map((t) => t.tag);
  const rich = (state.config.rich_tags || []).map((t) => t.tag);
  return [...control, ...rich].sort((a, b) => b.length - a.length);
}

/** Removes recognised emotion tags from `text`; other brackets are left alone. */
function stripTags(text) {
  return stripKnownTags(text, allTags());
}

function hasTags(text) {
  return hasAnyTag(text, allTags());
}

/** One-click "remove all tags" over the current script, undoable like the rest. */
function stripScriptTags() {
  const textarea = el('tts-text');
  if (!hasTags(textarea.value)) return;
  pushUndo(textarea.value);
  setScriptText(stripTags(textarea.value));
}

/** Keeps the 去标签 button honest: disabled while there is nothing to remove. */
function syncStripButton() {
  el('tts-tag-strip').disabled = !hasTags(el('tts-text').value);
}

// ---- script text: AI tagging, local rules, undo ----------------------------

/** What the dialog is currently previewing. */
let pendingResult = null;

// Which button opened the dialog. The 返回 step only makes sense for the
// script form (写稿 → 生成 → 改参数重来); the two tagging entries have no
// earlier screen, so they must not offer a way back into the script form.
let dialogOrigin = null;

// Undo covers every change this tab makes to the script box, not just the AI
// one: applying tags, and clearing. A stack rather than a single slot, so
// "tag, then clear" can be walked back one step at a time.
let textUndo = [];

function syncUndoButton() {
  el('tts-undo').disabled = textUndo.length === 0;
}

function pushUndo(text) {
  textUndo.push(text);
  if (textUndo.length > TEXT_UNDO_LIMIT) textUndo.shift();
  syncUndoButton();
}

function setScriptText(text) {
  const textarea = el('tts-text');
  textarea.value = text;
  textarea.dispatchEvent(new Event('input'));
}

function undoText() {
  if (!textUndo.length) return;
  setScriptText(textUndo.pop());
  syncUndoButton();
}

function clearText() {
  const textarea = el('tts-text');
  if (!textarea.value) return;
  pushUndo(textarea.value);
  setScriptText('');
  textarea.focus();
}

function tagOptions() {
  return {
    model: el('tts-tag-model').value,
    density: el('tts-tag-density').value || 'normal',
    rich_level: el('tts-tag-rich').value || 'light',
  };
}

/** Local rules only understand the on/off distinction, not the budget. */
function richAllowed() {
  return tagOptions().rich_level !== 'off';
}

/** Sentinel option value meaning "let me type my own". */
const CUSTOM = '__custom__';

/**
 * Fill a `<select>` from a preset list.
 *
 * `allowCustom` appends a 自定义… escape hatch. The model picker must not have
 * one -- the server validates model ids against a whitelist, so a free-text
 * option would only ever be rejected -- but 时长/语气/听众 are prompt fragments,
 * and locking users into a preset list would strand anyone with an unusual
 * audience.
 */
function fill(node, items, selected, allowCustom = false) {
  node.innerHTML = '';
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name;
    node.appendChild(option);
  }
  if (allowCustom) {
    const option = document.createElement('option');
    option.value = CUSTOM;
    option.textContent = '自定义…';
    node.appendChild(option);
  }
  const ids = items.map((item) => item.id);
  const wanted = selected && ids.includes(selected) ? selected : ids[0];
  node.value = wanted || CUSTOM;
}

function renderTagOptions() {
  const tagger = state.config.llm || {};
  const tags = state.config.tags || {};

  let preferred = '';
  try {
    preferred = localStorage.getItem(MODEL_STORAGE_KEY) || '';
  } catch (_) {
    /* private mode; the server default is fine */
  }
  fill(el('tts-tag-model'), tagger.models || [], preferred || tagger.default_model || '');
  fill(el('tts-tag-density'), tags.densities || [], 'normal');
  fill(el('tts-tag-rich'), tags.rich_levels || [], tags.default_rich_level || 'light');

  fill(el('tts-ai-duration'), tags.durations || [], '60 秒', true);
  fill(el('tts-ai-tone'), tags.tones || [], '亲切自然', true);
  fill(el('tts-ai-audience'), tags.audiences || [], '宝妈', true);

  const hints = el('tts-ai-topic-hints');
  hints.innerHTML = '';
  for (const hint of tags.topic_hints || []) {
    const option = document.createElement('option');
    option.value = hint;
    hints.appendChild(option);
  }

  // Reveal the free-text box only while 自定义… is selected.
  for (const [selectId, wrapId] of [
    ['tts-ai-duration', 'tts-ai-duration-wrap'],
    ['tts-ai-tone', 'tts-ai-tone-wrap'],
    ['tts-ai-audience', 'tts-ai-audience-wrap'],
  ]) {
    const select = el(selectId);
    const wrap = el(wrapId);
    const sync = () => {
      wrap.hidden = select.value !== CUSTOM;
    };
    select.addEventListener('change', sync);
    sync();
  }
}

/** The preset, or whatever the user typed when they picked 自定义…. */
function scriptField(selectId, inputId) {
  const select = el(selectId);
  return select.value === CUSTOM ? el(inputId).value.trim() : select.value;
}

function aiConfigured() {
  // Absent `llm` means the server predates this feature; treat it as
  // unconfigured rather than letting the button hit a 404.
  const tagger = state.config.llm;
  return !!(tagger && tagger.configured);
}

function closeTagDialog() {
  const dialog = el('tts-ai');
  if (dialog.open) dialog.close();
  pendingResult = null;
  dialogOrigin = null;
}

/** showModal() throws if the dialog is already up, which 返回 would otherwise hit. */
function showTagDialog() {
  const dialog = el('tts-ai');
  if (!dialog.open) dialog.showModal();
}

/** Open the dialog on the loading screen, then fill it once `promise` settles. */
async function withLoading(title, promise) {
  el('tts-ai-title').textContent = title;
  el('tts-ai-form').hidden = true;
  el('tts-ai-result').hidden = false;
  el('tts-ai-compare').hidden = true;
  el('tts-ai-warnings').hidden = true;
  const error = el('tts-ai-error');
  error.hidden = true;
  el('tts-ai-summary').textContent = '模型正在处理…';
  showTagDialog();

  try {
    showResult(await promise);
  } catch (err) {
    error.hidden = false;
    error.textContent = err.message || String(err);
    el('tts-ai-summary').textContent = '';
  }
}

function showResult(payload) {
  pendingResult = payload;
  el('tts-ai-summary').textContent = `已插入 ${payload.inserted} 个标签`;

  const warnings = el('tts-ai-warnings');
  warnings.innerHTML = '';
  const list = payload.warnings || [];
  warnings.hidden = list.length === 0;
  for (const item of list) {
    const li = document.createElement('li');
    li.textContent = item;
    warnings.appendChild(li);
  }

  // Script mode invents the text, so there is no "before" to compare against.
  const compare = el('tts-ai-compare');
  compare.hidden = !payload.before;
  el('tts-ai-before').value = payload.before || '';
  el('tts-ai-after').value = payload.text || '';

  // Only the script form sits behind this result screen.
  el('tts-ai-back').hidden = dialogOrigin !== 'script';
}

function tagStatus(message) {
  el('tts-status').textContent = message;
  el('tts-status').className = 'status err';
}

async function requestTags() {
  const text = el('tts-text').value.trim();
  if (!text) {
    tagStatus('请先输入文本');
    return;
  }
  const options = tagOptions();
  dialogOrigin = 'tag';
  await withLoading('AI 加情感标签', api('/api/tts/tag', {
    method: 'POST',
    body: JSON.stringify({ text, ...options }),
  }).then((body) => ({ ...body, before: text })));
}

async function requestScript() {
  const topic = el('tts-ai-topic').value.trim();
  if (!topic) {
    el('tts-ai-error').hidden = false;
    el('tts-ai-error').textContent = '请填写主题';
    return;
  }
  const options = tagOptions();
  await withLoading('AI 写口播稿', api('/api/tts/script', {
    method: 'POST',
    body: JSON.stringify({
      topic,
      duration: scriptField('tts-ai-duration', 'tts-ai-duration-custom'),
      tone: scriptField('tts-ai-tone', 'tts-ai-tone-custom'),
      audience: scriptField('tts-ai-audience', 'tts-ai-audience-custom'),
      ...options,
    }),
  }).then((body) => ({ ...body, before: '' })));
}

/** The offline path: same preview, no network. */
function requestFastTags() {
  const text = el('tts-text').value;
  if (!text.trim()) {
    tagStatus('请先输入文本');
    return;
  }
  const { density } = tagOptions();
  const { text: tagged, inserted } = applyRules(text, splitSentences(text), density, richAllowed());
  el('tts-ai-title').textContent = '快速标注';
  el('tts-ai-form').hidden = true;
  el('tts-ai-result').hidden = false;
  el('tts-ai-error').hidden = true;
  dialogOrigin = 'fast';
  showTagDialog();
  showResult({ text: tagged, before: text, inserted, warnings: [] });
}

function applyTagResult() {
  if (!pendingResult) return;
  const textarea = el('tts-text');
  // The model may have been switched while the dialog was open, in which case
  // the tags would be read aloud verbatim.
  if (!tagModelActive()) {
    closeTagDialog();
    tagStatus('当前模型不支持情感标签，未应用');
    return;
  }

  pushUndo(textarea.value);
  textarea.value = pendingResult.text;
  textarea.dispatchEvent(new Event('input'));
  closeTagDialog();
}

function openScriptDialog() {
  dialogOrigin = 'script';
  el('tts-ai-title').textContent = 'AI 写口播稿';
  el('tts-ai-form').hidden = false;
  el('tts-ai-result').hidden = true;
  el('tts-ai-error').hidden = true;
  showTagDialog();
  el('tts-ai-topic').focus();
}

/** 返回 only rewinds to the brief; anything else just dismisses. */
function backFromResult() {
  if (dialogOrigin === 'script') openScriptDialog();
  else closeTagDialog();
}

/** Grey out the AI buttons when no provider is configured or tags are moot. */
function syncTagActions() {
  const supported = tagModelActive();
  const ready = supported && aiConfigured();
  for (const id of ['tts-tag-ai', 'tts-tag-write']) {
    el(id).disabled = !ready;
  }
  // The local rules need no provider, so only the tag support matters.
  el('tts-tag-fast').disabled = !supported;
  // 去标签 needs neither, but there is nothing to strip on a tag-less model:
  // renderTagChips() has already removed them, and it fires `input`.
  syncStripButton();

  const note = el('tts-tag-note');
  if (!supported) {
    note.hidden = false;
    note.textContent = '当前模型不支持情感标签';
  } else if (!aiConfigured()) {
    note.hidden = false;
    note.textContent = '未配置 LLM_API_KEY，AI 功能不可用';
  } else {
    note.hidden = true;
  }
}

// ---- help dialog ---------------------------------------------------------

function openTagHelp() {
  const dialog = el('tag-help');
  el('tag-help-body').value = VOICEOVER_PROMPT;
  el('tag-help-status').textContent = '';
  dialog.showModal();
}

async function copyTagHelp() {
  const body = el('tag-help-body');
  const status = el('tag-help-status');
  try {
    await navigator.clipboard.writeText(body.value);
    status.textContent = '已复制到剪贴板';
  } catch (_) {
    // Clipboard API needs a secure context; fall back to manual selection.
    body.select();
    status.textContent = '请手动复制（已全选）';
  }
}

function voiceLabel(voiceId, modelId) {
  const catalogue = (state.config.tts_models || []).find((m) => m.id === modelId);
  const voice = (catalogue?.voices || []).find((v) => v.id === voiceId);
  return voice ? `${voice.name} · ${voice.trait}` : voiceId;
}

// ---- helpers --------------------------------------------------------------

function secondsOf(pcm) {
  return pcm ? pcm.length / 2 / SAMPLE_RATE : 0;
}

function recordDuration(record) {
  return record.sentences.reduce((sum, s) => sum + secondsOf(s.pcm), 0);
}

function generatedSentences(record) {
  return record.sentences.filter((s) => s.pcm);
}

function statusOf(record) {
  if (record.error) return { cls: 'err', label: '失败' };
  if (busyRecord && busyRecord.id === record.id) return { cls: 'warn', label: '生成中' };
  if (record.sentences.some((s) => s.status === 'error')) {
    return { cls: 'err', label: `${record.sentences.filter((s) => s.status === 'error').length} 句失败` };
  }
  if (record.sentences.every((s) => s.pcm)) return { cls: 'ok', label: `${record.sentences.length} 句` };
  return { cls: '', label: `${generatedSentences(record).length}/${record.sentences.length} 句` };
}

function clockOf(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---- rendering ------------------------------------------------------------

function renderHistory() {
  const box = el('tts-history');
  box.innerHTML = '';

  el('tts-count').textContent = records.length ? `（${records.length} 条）` : '';

  if (!records.length) {
    box.innerHTML = '<p class="muted">还没有生成记录。输入文本后点“生成”，每次生成都会新增一条。</p>';
    return;
  }

  for (const record of records) {
    box.appendChild(renderCard(record));
  }
}

function button(label, short, cls, handler, disabled, title) {
  const node = document.createElement('button');
  node.className = cls || 'ghost';
  node.textContent = label;
  node.dataset.short = short || label;
  node.disabled = Boolean(disabled);
  if (title) node.title = title;
  node.addEventListener('click', handler);
  return node;
}

function renderCard(record) {
  const card = document.createElement('div');
  card.className = 'hcard';
  if (busyRecord && busyRecord.id === record.id) card.classList.add('busy');

  const head = document.createElement('div');
  head.className = 'hhead';

  const meta = document.createElement('div');
  meta.className = 'hmeta';

  const title = document.createElement('div');
  title.className = 'htitle';
  title.textContent = record.text;
  title.title = record.text;

  const sub = document.createElement('div');
  sub.className = 'hsub';
  const voice = document.createElement('span');
  voice.className = 'hvoice';
  voice.textContent = voiceLabel(record.voice, record.model);
  // The baseline seed: what the first pass used. Re-generations roll new seeds,
  // which is what makes each attempt traceable.
  const summary = ` · ${record.model} · ${clockOf(record.createdAt)}`;
  sub.append(voice, record.params?.seed == null
    ? summary
    : `${summary} · 种子 ${record.params.seed}`);

  meta.append(title, sub);

  const tags = document.createElement('div');
  tags.className = 'htags';
  const info = statusOf(record);
  const badge = document.createElement('span');
  badge.className = `hbadge ${info.cls}`;
  badge.textContent = info.label;
  const length = document.createElement('span');
  length.className = 'hbadge';
  length.textContent = `${recordDuration(record).toFixed(1)}s`;
  tags.append(badge, length);

  const actions = document.createElement('div');
  actions.className = 'hactions';
  const isBusy = busyRecord && busyRecord.id === record.id;

  const done = generatedSentences(record).length;
  const expandLabel = openIds.has(record.id) ? '收起分段' : '分段';

  actions.append(
    button('播放', '播放', 'ghost', () => playRecord(record), done === 0 || isBusy),
    button('下载', '下载', '', () => downloadRecord(record), done === 0 || isBusy),
    button('重新生成', '重生', 'ghost', () => generateRecord(record, true), isBusy),
    button(expandLabel, openIds.has(record.id) ? '收起' : '分段', 'ghost', () => {
      if (openIds.has(record.id)) openIds.delete(record.id);
      else openIds.add(record.id);
      renderHistory();
    }, false),
    button('删除', '删除', 'ghost danger', () => removeRecord(record), false)
  );

  head.append(meta, tags, actions);
  card.appendChild(head);

  if (openIds.has(record.id)) {
    const body = document.createElement('div');
    body.className = 'hbody';
    record.sentences.forEach((sentence, index) => {
      body.appendChild(renderSentence(record, sentence, index));
    });
    card.appendChild(body);
  }

  return card;
}

function renderSentence(record, sentence, index) {
  const row = document.createElement('div');
  row.className = `seg ${sentence.status}`;

  const badge = document.createElement('span');
  badge.className = 'seg-index';
  badge.textContent = sentence.pcm ? '✓' : String(index + 1);

  const text = document.createElement('span');
  text.className = 'seg-text';
  text.textContent = sentence.error ? `${sentence.text} —— ${sentence.error}` : sentence.text;

  const duration = document.createElement('span');
  duration.className = 'seg-duration';
  duration.textContent = sentence.pcm
    ? `${secondsOf(sentence.pcm).toFixed(1)}s`
    : sentence.status === 'busy'
      ? '生成中…'
      : '';

  const actions = document.createElement('span');
  actions.className = 'seg-actions';
  const isBusy = busyRecord && busyRecord.id === record.id;

  actions.append(
    button('重新生成', '重生', '', () => generateSentence(record, index), isBusy, false,
      sentence.seed == null
        ? '换一个种子重新生成这一句'
        : `本句种子 ${sentence.seed}，点击会换一个`),
    button('播放', '播放', 'ghost', () => playSentence(sentence), !sentence.pcm),
    button('下载', '下载', 'ghost', () => {
      saveBlobOne(pcmToWavBlob([sentence.pcm], SAMPLE_RATE), `语音-${index + 1}.wav`);
    }, !sentence.pcm),
    button('删除', '删除', 'ghost danger', () => removeSentence(record, index), isBusy)
  );

  row.append(badge, text, duration, actions);
  return row;
}

function saveBlobOne(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---- playback / download --------------------------------------------------

function playSentence(sentence) {
  if (!sentence?.pcm) return;
  player.clear();
  player.push(sentence.pcm);
}

function playRecord(record) {
  const ready = generatedSentences(record);
  if (!ready.length) return;
  player.clear();
  for (const sentence of ready) player.push(sentence.pcm);
}

function downloadRecord(record) {
  // Always one complete WAV in reading order, even if only some sentences
  // have been regenerated.
  const ready = generatedSentences(record);
  if (!ready.length) return;
  saveBlobOne(
    pcmToWavBlob(ready.map((s) => s.pcm), SAMPLE_RATE),
    `语音合成-${clockOf(record.createdAt).replace(/:/g, '')}.wav`
  );
}

// ---- synthesis ------------------------------------------------------------

function ensureSocket() {
  if (socket) return socket;
  player = player || new PcmPlayer(SAMPLE_RATE);
  socket = new ResilientSocket('/ws/tts', {
    onOpen: () => applySocketStatus('tts-status', 'connected'),
    onBinary: (buffer) => {
      if (!busyRecord) return;
      const sentence = busyRecord.sentences.find((s) => s.status === 'busy');
      if (sentence) sentence.chunks.push(new Int16Array(buffer));
    },
    onMessage(raw) {
      const event = JSON.parse(raw);
      if (event.type === 'tts.done') finishCurrent(null);
      else if (event.type === 'error') finishCurrent(event.error?.message || '生成失败', busyRecord && busyRecord.params);
    },
    onStatus: (raw) => applySocketStatus('tts-status', raw),
  });
  socket.open();
  return socket;
}

function mergeChunks(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const merged = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function finishCurrent(error, params) {
  const record = busyRecord;
  if (record) {
    const sentence = record.sentences.find((s) => s.status === 'busy');
    if (sentence) {
      if (error) {
        sentence.status = 'error';
        sentence.error = describeError(error, params);
        sentence.pcm = null;
      } else if (sentence.chunks.length) {
        sentence.pcm = mergeChunks(sentence.chunks);
        sentence.status = 'done';
        sentence.error = null;
      } else {
        sentence.status = 'error';
        sentence.error = '没有返回音频';
        sentence.pcm = null;
      }
    }
    busyRecord = null;
    persist(record);
    renderHistory();
  }
  if (pendingResolve) {
    const resolve = pendingResolve;
    pendingResolve = null;
    resolve();
  }
}

/** Sends one sentence and waits for the server to report completion. */
async function runSentence(record, index) {
  const sentence = record.sentences[index];
  if (!sentence) return;

  const active = ensureSocket();
  // The socket connects asynchronously; sending before it is open is dropped
  // silently and this promise would never settle.
  await active.whenOpen();
  await player.resume();

  sentence.status = 'busy';
  sentence.error = null;
  sentence.chunks = [];
  sentence.pcm = null;
  busyRecord = record;
  openIds.add(record.id);
  // Re-generating reuses record.params verbatim, which would make the button a
  // no-op: same seed plus same text gives byte-identical audio. A fresh seed
  // per attempt is what "再来一条" actually means.
  sentence.seed = nextSeed(record, sentence);
  renderHistory();

  active.send({
    type: 'tts.synthesize',
    text: sentence.text,
    voice: record.voice,
    params: { ...record.params, seed: sentence.seed },
  });

  await new Promise((resolve) => {
    pendingResolve = resolve;
  });
}

async function generateSentence(record, index) {
  if (busyRecord) return;
  await runSentence(record, index);
}

/**
 * Fills in every sentence that has no audio yet. `force` discards what is
 * already there, which is what "重新生成" on the card means.
 */
async function generateRecord(record, force = false) {
  if (busyRecord) return;
  if (force) {
    for (const sentence of record.sentences) {
      sentence.pcm = null;
      sentence.error = null;
      sentence.status = 'idle';
    }
  }
  for (let i = 0; i < record.sentences.length; i++) {
    if (!record.sentences[i].pcm) await runSentence(record, i);
  }
}

// ---- record lifecycle -----------------------------------------------------

function createRecord() {
  const text = el('tts-text').value.trim();
  if (!text) return null;
  const model = activeModel();
  const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  // A control tag applies for the rest of one synthesis request, but each
  // sentence is synthesised separately here, so carry it forward. Without this
  // only the first sentence would keep the requested emotion.
  const parts = splitSentences(text);
  const sentences = [];
  let carried = '';
  parts.forEach((sentenceText, index) => {
    let finalText = sentenceText;
    if (carried && !sentenceText.trimStart().startsWith('[')) {
      finalText = `${carried}${sentenceText}`;
    }
    const tag = lastControlTag(finalText);
    if (tag) carried = tag;
    sentences.push({
      key: segmentKey(id, index),
      text: finalText,
      pcm: null,
      chunks: [],
      status: 'idle',
      error: null,
      // null == 还没生成过, so the first attempt takes the record's seed.
      // Declared explicitly because this object goes through IndexedDB.
      seed: null,
    });
  });
  return {
    id,
    createdAt: Date.now(),
    text,
    model: model ? model.id : undefined,
    voice: el('tts-voice').value,
    params: currentParams(),
    sentences,
  };
}

function persist(record) {
  saveTtsRecord(record).catch((error) => console.warn('保存失败', error));
}

async function removeRecord(record) {
  records = records.filter((r) => r.id !== record.id);
  openIds.delete(record.id);
  renderHistory();
  deleteTtsRecord(record.id).catch(() => {});
}

async function removeSentence(record, index) {
  record.sentences[index].pcm = null;
  record.sentences[index].status = 'idle';
  record.sentences[index].error = null;
  persist(record);
  renderHistory();
}

async function loadHistory() {
  try {
    const stored = await loadTtsRecords();
    records = stored.map((record) => ({
      ...record,
      sentences: (record.sentences || []).map((s) => ({ ...s, chunks: [] })),
    }));
  } catch (error) {
    console.warn('读取历史失败', error);
    records = [];
  }
  // Guard against unbounded growth in storage.
  if (records.length > MAX_RECORDS) {
    for (const stale of records.slice(MAX_RECORDS)) deleteTtsRecord(stale.id).catch(() => {});
    records = records.slice(0, MAX_RECORDS);
  }
  renderHistory();
}

// ---- wiring ---------------------------------------------------------------

function refreshInstructionOptions() {
  const kind = el('tts-instruct-kind').value;
  const values = instructionValues();
  const select = el('tts-instruct-value');
  const labels = state.config.emotion_labels || {};
  select.innerHTML = '';
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    // Emotion values are English enums; show the Chinese first and keep the
    // English on hover for anyone who needs to know what actually gets sent.
    option.textContent = labels[value] ? `${labels[value]}（${value}）` : value;
    select.appendChild(option);
  }
  el('tts-instruct-value-wrap').hidden = values.length === 0;
  el('tts-instruct-custom-wrap').hidden = kind !== 'custom';

  explainInstructionState(kind);
}

/**
 * Dialect is only accepted by `longanhuan_v3`; every other voice returns
 * error 428 with an opaque message. Switch automatically so the user does not
 * have to know which voice can do what.
 */
/** One short line explaining why an instruction cannot be used. */
function explainInstructionState(kind) {
  const note = el('tts-instruct-note');
  const kinds = [...el('tts-instruct-kind').options].map((o) => o.value).filter(Boolean);

  if (!kinds.length) {
    note.textContent = '该音色不支持指令';
    note.hidden = false;
    return;
  }
  if (kind && !kinds.includes(kind)) {
    note.textContent = '该音色不支持该指令';
    note.hidden = false;
    el('tts-instruct-kind').value = '';
    return;
  }
  note.hidden = true;
  note.textContent = '';
}

/** Turns the raw SDK error into something actionable. */
function describeError(raw, params) {
  const message = String(raw || '');
  if (/428|InvalidParameter/i.test(message) && params?.instruction) {
    const kind = el('tts-instruct-kind').value;
    if (kind === 'dialect') return '该音色不支持方言，请选择「龙安欢(V3)」';
    if (kind === 'scene') return '该音色不支持这个场景，换个场景或换个音色试试';
    return '该音色不支持这条指令，换个音色试试';
  }
  if (/418/.test(message)) return '音色与模型不匹配，切换模型后需要同步换音色';
  return message.length > 160 ? `${message.slice(0, 160)}…` : message;
}

export function init() {
  el('tts-generate').addEventListener('click', async () => {
    const record = createRecord();
    if (!record) return;
    // Append as a new record; earlier ones are never touched.
    records.unshift(record);
    openIds.add(record.id);
    renderHistory();
    persist(record);
    await generateRecord(record);
  });

  el('tts-stop').addEventListener('click', () => {
    if (player) player.clear();
  });

  el('tts-clear-history').addEventListener('click', async () => {
    if (!records.length) return;
    records = [];
    openIds.clear();
    renderHistory();
    await clearTtsRecords().catch(() => {});
  });

  el('tts-instruct-kind').addEventListener('change', refreshInstructionOptions);
  el('tag-help-btn').addEventListener('click', openTagHelp);
  el('tag-help-close').addEventListener('click', () => el('tag-help').close());
  el('tag-help-copy').addEventListener('click', copyTagHelp);

  el('tts-tag-ai').addEventListener('click', requestTags);
  el('tts-tag-fast').addEventListener('click', requestFastTags);
  el('tts-tag-write').addEventListener('click', openScriptDialog);
  el('tts-tag-strip').addEventListener('click', stripScriptTags);
  el('tts-undo').addEventListener('click', undoText);
  el('tts-clear-text').addEventListener('click', clearText);
  // Keeps 去标签 disabled until the script actually holds a tag, and picks up
  // the strip renderTagChips() performs when switching to a tag-less model.
  el('tts-text').addEventListener('input', syncStripButton);
  el('tts-ai-run').addEventListener('click', requestScript);
  el('tts-ai-close').addEventListener('click', closeTagDialog);
  el('tts-ai-cancel').addEventListener('click', closeTagDialog);
  el('tts-ai-apply').addEventListener('click', applyTagResult);
  el('tts-ai-back').addEventListener('click', backFromResult);

  el('tts-tag-model').addEventListener('change', (event) => {
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, event.target.value);
    } catch (_) {
      /* private mode; the choice just will not persist */
    }
  });

  for (const [id, out, digits] of [
    ['tts-rate', 'tts-rate-out', 2],
    ['tts-pitch', 'tts-pitch-out', 2],
    ['tts-volume', 'tts-volume-out', 0],
  ]) {
    const slider = el(id);
    const output = el(out);
    const sync = () => {
      output.textContent = Number(slider.value).toFixed(digits);
    };
    slider.addEventListener('input', sync);
    sync();
  }

  refreshInstructionOptions();
  renderTagOptions();
  // Tag availability is model-specific, so re-render when the model changes.
  window.addEventListener('tts-model-changed', () => {
    renderTagChips();
    syncTagActions();
  });
  renderTagChips();
  syncTagActions();
  loadHistory();
}