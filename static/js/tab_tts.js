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
import { actionButton } from '/static/js/actions.js';
import { applySocketStatus, el, state } from '/static/js/app.js';
import { buildInstruction } from '/static/js/instruct.js';
import { nextSeed, resolveSeed } from '/static/js/seed_policy.js';
import { createScriptBox } from '/static/js/script_box.js';
import { aiConfigured, createTagTagger, fillSelect, openHelp, renderPresets, syncTagActions } from '/static/js/tag_dialog.js';
import { hasAnyTag, stripKnownTags } from '/static/js/tag_rules.js';

const SAMPLE_RATE = 22050;
const MAX_RECORDS = 30;
const MODEL_STORAGE_KEY = 'tts.tagModel';

// Undo covers every change this tab makes to the script box, not just the AI
// one: 去标签, applying tags, and clearing. Shared with the clone-preview tab so
// the two cannot drift; see script_box.js.
const scriptBox = createScriptBox({
  textarea: el('tts-text'),
  undoButton: el('tts-undo'),
});

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

function renderTagChips() {
  const panel = el('tts-tags');
  const supported = tagModelActive();
  panel.hidden = !supported;

  if (!supported) {
    // Switching to a model that ignores tags would have them read aloud, so
    // drop them from the script rather than let it fail downstream. Deliberately
    // not undoable: the tags are gone because the model cannot say them, and
    // offering a way back would only invite the same failure again.
    const textarea = el('tts-text');
    if (textarea.value.trim() && hasTags(textarea.value)) {
      scriptBox.setText(stripTags(textarea.value));
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
      chip.addEventListener('click', () => scriptBox.insertTag(item.tag));
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
  scriptBox.push(textarea.value);
  scriptBox.setText(stripTags(textarea.value));
}

/** Keeps the 去标签 button honest: disabled while there is nothing to remove. */
function syncStripButton() {
  el('tts-tag-strip').disabled = !hasTags(el('tts-text').value);
}

// ---- script text: AI tagging, local rules, undo ----------------------------

/** This tab's slice of the shared AI dialog; see tag_dialog.js. */
const tagger = createTagTagger({
  textarea: el('tts-text'),
  scriptBox,
  supportsTags: tagModelActive,
  readOptions: tagOptions,
  report: tagStatus,
  label: '文本框',
});

function tagOptions() {
  return {
    model: el('tts-tag-model').value,
    density: el('tts-tag-density').value || 'normal',
    rich_level: el('tts-tag-rich').value || 'light',
  };
}

function tagStatus(message) {
  el('tts-status').textContent = message;
  el('tts-status').className = 'status err';
}

/** The 标注参数 row; the presets inside the dialog belong to tag_dialog.js. */
function renderTagOptions() {
  const tagger_ = state.config.llm || {};
  const tags = state.config.tags || {};

  let preferred = '';
  try {
    preferred = localStorage.getItem(MODEL_STORAGE_KEY) || '';
  } catch (_) {
    /* private mode; the server default is fine */
  }
  fillSelect(el('tts-tag-model'), tagger_.models || [], preferred || tagger_.default_model || '');
  fillSelect(el('tts-tag-density'), tags.densities || [], 'normal');
  fillSelect(el('tts-tag-rich'), tags.rich_levels || [], tags.default_rich_level || 'light');
  renderPresets();
}

/** Grey out the AI buttons when no provider is configured or tags are moot. */
function syncTagActionsForThisTab() {
  syncTagActions({
    ids: { ai: 'tts-tag-ai', fast: 'tts-tag-fast', write: 'tts-tag-write', note: 'tts-tag-note' },
    supported: tagModelActive(),
    configured: aiConfigured(),
    // 去标签 needs neither, but there is nothing to strip on a tag-less model:
    // renderTagChips() has already removed them, and it fires `input`.
    syncStrip: syncStripButton,
  });
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

  // Not just a guard against a misclick: clearing mid-generation empties
  // `records`, and finishCurrent() then writes the record that was still in
  // flight back into IndexedDB -- so it reappears on the next page load, with no
  // way to get rid of it.
  el('tts-clear-history').disabled = Boolean(busyRecord);

  el('tts-count').textContent = records.length ? `（${records.length} 条）` : '';

  if (!records.length) {
    box.innerHTML = '<p class="muted">还没有生成记录。输入文本后点“生成”，每次生成都会新增一条。</p>';
    return;
  }

  for (const record of records) {
    box.appendChild(renderCard(record));
  }
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
    actionButton('播放', { onClick: () => playRecord(record), disabled: done === 0 || isBusy }),
    actionButton('下载', { className: '', onClick: () => downloadRecord(record), disabled: done === 0 || isBusy }),
    actionButton('重新生成', { onClick: () => generateRecord(record, true), disabled: isBusy }),
    actionButton(expandLabel, {
      onClick() {
        if (openIds.has(record.id)) openIds.delete(record.id);
        else openIds.add(record.id);
        renderHistory();
      },
    }),
    actionButton('删除', { className: 'ghost danger', onClick: () => removeRecord(record) })
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
    actionButton('重新生成', {
      className: '',
      disabled: isBusy,
      // Was previously passed as a 7th argument the old helper never read, so
      // the tooltip never appeared.
      title: sentence.seed == null
        ? '换一个种子重新生成这一句'
        : `本句种子 ${sentence.seed}，点击会换一个`,
      onClick: () => generateSentence(record, index),
    }),
    actionButton('播放', {
      disabled: !sentence.pcm,
      onClick: () => playSentence(sentence),
    }),
    actionButton('下载', {
      disabled: !sentence.pcm,
      onClick: () => {
        saveBlobOne(pcmToWavBlob([sentence.pcm], SAMPLE_RATE), `语音-${index + 1}.wav`);
      },
    }),
    actionButton('删除', {
      className: 'ghost danger',
      disabled: isBusy,
      onClick: () => removeSentence(record, index),
    })
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
    // Every record carries its generated audio; there is no undo for this and no
    // way to synthesise it again without paying for it a second time.
    const confirmed = window.confirm(
      `清空 ${records.length} 条历史记录？\n\n` +
      '每条记录里的音频都会一起删掉，删了找不回来。文本框里的稿子不受影响。'
    );
    if (!confirmed) return;
    records = [];
    openIds.clear();
    renderHistory();
    await clearTtsRecords().catch(() => {});
  });

  el('tts-instruct-kind').addEventListener('change', refreshInstructionOptions);
  el('tag-help-btn').addEventListener('click', openHelp);

  el('tts-tag-ai').addEventListener('click', tagger.openTags);
  el('tts-tag-fast').addEventListener('click', tagger.openFast);
  el('tts-tag-write').addEventListener('click', tagger.openScript);
  el('tts-tag-strip').addEventListener('click', stripScriptTags);
  el('tts-undo').addEventListener('click', () => scriptBox.undo());
  el('tts-clear-text').addEventListener('click', () => scriptBox.clear());
  // Keeps 去标签 disabled until the script actually holds a tag, and picks up
  // the strip renderTagChips() performs when switching to a tag-less model.
  el('tts-text').addEventListener('input', syncStripButton);

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
    syncTagActionsForThisTab();
  });
  renderTagChips();
  syncTagActionsForThisTab();
  loadHistory();
}