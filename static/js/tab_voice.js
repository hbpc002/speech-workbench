// Tab 4 - voice cloning and voice management.
//
// Three things happen on this tab, and they share a lot of state:
//
//   enroll  - record or upload a sample, check it, submit it
//   preview - synthesise with a cloned voice, with the same parameters and
//             instructions the synthesis tab offers
//   manage  - list, delete, and remember what was made
//
// The preview deliberately mirrors tab 3. A cloned voice is just another
// voice, and the point of cloning is to hear how it reads a script, so the
// controls that shape delivery have to be here too -- otherwise you clone for
// ten minutes and only then find out you cannot adjust anything.
//
// Every synthesis appends a record and nothing is overwritten in place, so a
// clone can be compared across several attempts. Records live in IndexedDB and
// survive a refresh.

import {
  PcmPlayer,
  ResilientSocket,
  VoiceClipRecorder,
  clearVoiceClones,
  clearVoicePreviews,
  decodeToPcm16k,
  deleteVoiceClone,
  deleteVoiceMeta,
  deleteVoicePreview,
  loadVoiceClones,
  loadVoiceMeta,
  loadVoicePreviews,
  pcmToWavBlob,
  saveBlob,
  saveVoiceClone,
  saveVoiceMeta,
  saveVoicePreview,
} from '/static/js/audio.js';
import { actionButton } from '/static/js/actions.js';
import { api, applySocketStatus, el, log, state } from '/static/js/app.js';
import { buildInstruction, instructionValues, isVoiceDependent } from '/static/js/instruct.js';
import { nextSeed, resolveSeed } from '/static/js/seed_policy.js';
import { MAX_SECONDS, SAMPLE_RATE, TARGET_SECONDS, analyze, assess, trimSilence } from '/static/js/clip_check.js';
import { allKnownTags, hasTags, insertAtCaret, renderChips, stripTags, tagChips } from '/static/js/tag_input.js';

const MAX_PREVIEWS = 30;
const MAX_CLONE_LOGS = 50;

/** Instruction kinds a cloned voice can plausibly take.
 *
 * The per-voice capability table in server/voices.py only covers built-in
 * voices; a cloned id is generated at runtime and is not in it. Emotion is a
 * model-level enum so it is safe. Scene and dialect are per-voice -- the API
 * rejects a combination it does not like with a bare 428 -- so they are offered
 * with a warning rather than hidden, matching how voices.py documents the
 * trade-off. Role and identity are left out entirely: they are the two kinds
 * the published tables get most wrong.
 */
const CLONE_INSTRUCT_KINDS = [
  { id: '', label: '无' },
  { id: 'emotion', label: '情感' },
  { id: 'scene', label: '场景 + 情感' },
  { id: 'dialect', label: '方言' },
  { id: 'custom', label: '自定义' },
];

let recorder = null;
let clip = null;          // Blob actually sent to the server
let clipStats = null;     // analysis of the current clip
let previewSocket = null;
let previewPlayer = null;
let previews = [];        // newest first
let cloneLogs = [];       // newest first
let busyPreview = null;
let pendingResolve = null;
/** voice_id -> target_model, derived from the id because list_voice omits it. */
let voiceModels = new Map();
/** voice_id -> { alias, tags } from IndexedDB. Local only; upstream has neither. */
let voiceMeta = new Map();
/** The tag currently filtering the list, or '' for all. */
let filterTag = '';

/** Display name: the operator's alias if they set one, else the id. */
function labelFor(voiceId) {
  const alias = (voiceMeta.get(voiceId)?.alias || '').trim();
  return alias || voiceId;
}

function tagsFor(voiceId) {
  return voiceMeta.get(voiceId)?.tags || [];
}

/** Every tag in use, for the filter dropdown. */
function allTagsInUse() {
  const seen = new Set();
  for (const entry of voiceMeta.values()) {
    for (const tag of entry.tags || []) {
      const trimmed = String(tag).trim();
      if (trimmed) seen.add(trimmed);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'zh'));
}

async function setVoiceMeta(voiceId, patch) {
  const next = { id: voiceId, ...(voiceMeta.get(voiceId) || {}), ...patch };
  next.alias = (next.alias || '').trim();
  next.tags = (next.tags || []).map((t) => String(t).trim()).filter(Boolean);
  voiceMeta.set(voiceId, next);
  await saveVoiceMeta(next).catch(() => {});
  return next;
}

/**
 * Upstream has no rename: `update_voice` replaces the sample audio, and the
 * voice_id is the identity the model is bound to. So this sets a local alias,
 * and says so, rather than pretending the id changed.
 */
function renameVoice(voiceId) {
  const current = voiceMeta.get(voiceId)?.alias || '';
  const next = window.prompt(
    '起个本地别名，方便在列表和试听下拉里认出来。\n' +
    '不会改上游的音色 ID —— 上游没有改名接口，别名只存在这台设备上。',
    current
  );
  if (next === null) return;
  setVoiceMeta(voiceId, { alias: next }).then(() => {
    log('voice-status', `已把 ${voiceId} 命名为「${next.trim() || voiceId}」`, 'system');
    refreshVoices();
  });
}

function editTags(voiceId) {
  const current = tagsFor(voiceId).join('、');
  const next = window.prompt('给这个音色打几个标签，用、分隔。用于筛选。', current);
  if (next === null) return;
  setVoiceMeta(voiceId, { tags: next.split(/[、,，]/).map((t) => t.trim()).filter(Boolean) }).then(() => {
    log('voice-status', `已更新 ${voiceId} 的标签`, 'system');
    refreshVoices();
  });
}

// ---- helpers ---------------------------------------------------------------

function clockOf(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

function secondsOf(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  return total / SAMPLE_RATE;
}

// ---- enrollment clip -------------------------------------------------------

/**
 * Re-encode the samples after analysis, optionally trimming, and publish the
 * verdict. Everything downstream -- the WAV we send, the download button, the
 * numbers on screen -- reads from the same PCM, so what the user is told about
 * is what the server actually receives.
 */
function publishClip(samples, label) {
  const result = el('voice-trim').checked
    ? trimSilence(samples, SAMPLE_RATE, { maxSeconds: MAX_SECONDS })
    : { samples, trimmed: false };
  const finalSamples = result.samples;
  const stats = analyze(finalSamples, SAMPLE_RATE);
  const verdict = assess(stats);

  clipStats = { ...verdict, stats };
  // Array-wrapped: pcmToWavBlob takes a list of chunks.
  clip = pcmToWavBlob([finalSamples], SAMPLE_RATE);

  const panel = el('voice-clip-panel');
  panel.hidden = false;
  panel.classList.toggle('warn', verdict.level === 'warn');
  panel.classList.toggle('err', verdict.level === 'error');

  el('voice-clip-stats').innerHTML = '';
  const chips = [
    `${stats.seconds.toFixed(1)} 秒`,
    `人声 ${Math.round(stats.voiceRatio * 100)}%`,
    `峰值 ${(stats.peak * 100).toFixed(0)}%`,
    '16 kHz 单声道',
  ];
  if (result.trimmed) {
    chips.unshift(`已裁掉首尾静音 ${result.startSec.toFixed(1)}–${stats.seconds.toFixed(1)}s`);
  }
  for (const text of chips) {
    const chip = document.createElement('span');
    chip.className = 'clip-stat';
    chip.textContent = text;
    el('voice-clip-stats').appendChild(chip);
  }

  el('voice-clip-issues').innerHTML = '';
  for (const issue of verdict.issues) {
    const item = document.createElement('li');
    item.className = `sev-${issue.severity}`;
    item.textContent = issue.text;
    el('voice-clip-issues').appendChild(item);
  }
  if (!verdict.issues.length) {
    const item = document.createElement('li');
    item.textContent = `样本可用。${label}`;
    el('voice-clip-issues').appendChild(item);
  }

  el('voice-clone').disabled = false;
  log('voice-status', `已就绪：${label}（${stats.seconds.toFixed(1)} 秒）`, 'system');
}

/** Recompute after the trim checkbox is toggled, from the same source samples. */
let currentSamples = null;
let currentLabel = '';

function reapplyTrim() {
  if (!currentSamples) return;
  const before = currentSamples;
  publishClip(before, currentLabel);
}

async function acceptFile(file) {
  log('voice-status', '正在解码…', 'system');
  try {
    const decoded = await decodeToPcm16k(file);
    currentSamples = decoded.samples;
    currentLabel = file.name;
    const note = decoded.wasResampled
      ? `（原始 ${(decoded.sourceSampleRate / 1000).toFixed(1)}kHz ${decoded.sourceChannels === 1 ? '单声道' : '立体声'}，已转 16kHz 单声道）`
      : '';
    publishClip(currentSamples, file.name + note);
  } catch (error) {
    clip = null;
    el('voice-clip-panel').hidden = true;
    el('voice-clone').disabled = true;
    log('voice-status', `无法解码 ${file.name}：${error.message}`, 'error');
  }
}

function downloadClip() {
  if (!clip) return;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  saveBlob(clip, `voice-sample-${stamp}.wav`);
}

// ---- voice list ------------------------------------------------------------

/**
 * The model a cloned voice belongs to.
 *
 * Sending a cloned voice to config.TTS_MODEL is wrong for anything cloned
 * against a qwen target -- the voice is bound to the model it was enrolled
 * with and the service answers 418. The list already carries target_model; it
 * just was not being used.
 */
function modelFor(voiceId) {
  return voiceModels.get(voiceId) || state.config.tts_default_model;
}

function noteModelSelection() {
  const voice = el('voice-play-select').value;
  const note = el('voice-model-note');
  if (!voice) {
    note.textContent = '';
    renderTagPanel();
    return;
  }
  const known = voiceModels.get(voice);
  note.textContent = known
    ? `该音色复刻自 ${known}，试听会按这个模型合成。`
    : '未查到该音色的复刻模型，将按默认模型合成。';
  renderTagPanel();
}

/** Does the selected voice's model understand inline `[tags]`? */
function tagsSupported() {
  const voice = el('voice-play-select').value;
  const model = voiceModels.get(voice);
  if (!model) return false;
  return (state.config.tag_models || []).includes(model);
}

/**
 * Show or hide the tag panel for the selected voice.
 *
 * A tag sent to a model that does not understand it is read out as literal
 * text, so the panel is hidden rather than the tags being stripped silently:
 * on cosyvoice the operator is better served by the instruction dropdown.
 */
function renderTagPanel() {
  const panel = el('voice-tags');
  const textarea = el('voice-play-text');
  const supported = tagsSupported();
  panel.hidden = !supported;

  if (!supported) {
    if (hasTags(textarea.value, state.config)) {
      textarea.value = stripTags(textarea.value, state.config);
    }
    el('voice-tag-strip').disabled = true;
    return;
  }

  renderChips(el('voice-control-tags'), tagChips(state.config), {
    create: (tag) => document.createElement(tag),
    onPick: (tag) => insertAtCaret(textarea, tag),
  });
  renderChips(el('voice-rich-tags'), tagChips(state.config, { rich: true }), {
    create: (tag) => document.createElement(tag),
    onPick: (tag) => insertAtCaret(textarea, tag),
  });
  syncStripButton();
}

function syncStripButton() {
  el('voice-tag-strip').disabled = !hasTags(el('voice-play-text').value, state.config);
}

function renderTagFilter() {
  const select = el('voice-filter-tag');
  const tags = allTagsInUse();
  const previous = filterTag;
  select.innerHTML = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = tags.length ? '全部标签' : '全部';
  select.appendChild(all);
  for (const tag of tags) {
    const option = document.createElement('option');
    option.value = tag;
    option.textContent = tag;
    select.appendChild(option);
  }
  // A tag can vanish when the last voice carrying it is renamed or deleted.
  select.value = tags.includes(previous) ? previous : '';
  filterTag = select.value;
}

function matchesFilter(entry) {
  if (!filterTag) return true;
  return tagsFor(entry.voice_id || entry.voiceId || String(entry)).includes(filterTag);
}

async function refreshVoices() {
  const container = el('voice-list');
  const select = el('voice-play-select');
  try {
    const { voices } = await api('/api/voices');
    const list = Array.isArray(voices) ? voices : [];
    const previous = select.value;
    container.innerHTML = '';
    select.innerHTML = '';
    voiceModels = new Map();

    renderTagFilter();

    if (!list.length) {
      container.innerHTML = '<p class="muted">还没有复刻过音色。</p>';
      el('voice-list-count').textContent = '';
      noteModelSelection();
      return;
    }

    const visible = list.filter(matchesFilter);
    el('voice-list-count').textContent = visible.length
      ? `${visible.length} / ${list.length} 个`
      : '';

    if (!visible.length) {
      container.innerHTML = `<p class="muted">没有带「${filterTag}」标签的音色。</p>`;
    }

    for (const entry of visible) {
      const voiceId = entry.voice_id || entry.voiceId || String(entry);
      if (entry.target_model) voiceModels.set(voiceId, entry.target_model);

      const row = document.createElement('div');
      row.className = 'voice-row';

      const label = document.createElement('span');
      label.className = 'voice-id';
      const alias = voiceMeta.get(voiceId)?.alias;
      label.textContent = alias || voiceId;
      if (alias) {
        const real = document.createElement('span');
        real.className = 'voice-real-id';
        real.textContent = voiceId;
        label.appendChild(real);
      }
      // The server derives these from the id and the upstream status field.
      if (entry.target_model) {
        const tag = document.createElement('span');
        tag.className = 'voice-tag';
        tag.textContent = entry.target_model;
        label.appendChild(tag);
      }
      if (entry.status_label) {
        const badge = document.createElement('span');
        badge.className = `hbadge ${entry.status_class || ''}`;
        badge.textContent = entry.status_label;
        badge.title =
          entry.status === 'DEPLOYING'
            ? '音色创建后要经过审核，通过后才能合成'
            : entry.status === 'UNDEPLOYED'
              ? '审核未通过，这个音色无法用于合成'
              : '';
        label.appendChild(badge);
      }
      for (const tag of tagsFor(voiceId)) {
        const chip = document.createElement('span');
        chip.className = 'voice-meta-tag';
        chip.textContent = tag;
        label.appendChild(chip);
      }

      const created = document.createElement('span');
      created.className = 'voice-created';
      created.textContent = entry.gmt_create ? entry.gmt_create.slice(0, 10) : '';
      created.title = entry.gmt_create ? `创建于 ${entry.gmt_create}` : '';

      const preview = actionButton('试音', {
        onClick: () => {
          select.value = voiceId;
          noteModelSelection();
          startPreview(voiceId, currentParams());
        },
      });

      const rename = actionButton('改名', {
        className: 'ghost',
        onClick: () => renameVoice(voiceId),
      });

      const tagButton = actionButton('标签', {
        className: 'ghost',
        onClick: () => editTags(voiceId),
      });

      const remove = actionButton('删除', {
        className: 'ghost danger',
        onClick: () => deleteOne(voiceId, remove),
      });

      row.append(label, created, preview, rename, tagButton, remove);
      container.appendChild(row);

      const option = document.createElement('option');
      option.value = voiceId;
      option.textContent = alias ? `${alias}（${voiceId}）` : voiceId;
      select.appendChild(option);
    }

    // Keep the operator on whatever they had selected; a clone that just
    // succeeded should become the active voice.
    if (previous && voiceModels.has(previous)) select.value = previous;
    noteModelSelection();
  } catch (error) {
    log('voice-status', `读取音色列表失败：${error.message}`, 'error');
  }
}

async function deleteOne(voiceId, button) {
  const alias = voiceMeta.get(voiceId)?.alias;
  const confirmed = window.confirm(
    `删除音色 ${alias ? `「${alias}」` : ''}（${voiceId}）？\n\n` +
    '删除不可撤销：上游没有改名以外的恢复手段，重新复刻会得到一个新的音色 ID，' +
    '绑定的模型也可能要重新选。'
  );
  if (!confirmed) return;

  if (button) button.disabled = true;
  try {
    await api(`/api/voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE' });
    log('voice-status', `已删除 ${labelFor(voiceId)}`, 'system');
    // The alias and tags pointed at an id that no longer exists.
    voiceMeta.delete(voiceId);
    await deleteVoiceMeta(voiceId).catch(() => {});
    await recordClone({ voiceId, action: 'delete', ok: true });
    await refreshVoices();
  } catch (error) {
    if (button) button.disabled = false;
    log('voice-status', `删除 ${voiceId} 失败：${error.message}`, 'error');
  }
}

async function clearAll() {
  const { voices } = await api('/api/voices').catch(() => ({ voices: [] }));
  const list = Array.isArray(voices) ? voices : [];
  if (!list.length) {
    log('voice-status', '没有可清理的音色', 'system');
    return;
  }
  // Voice quota is limited and this cannot be undone, so name what is about to
  // go and require a second click. The operator may have cloned something they
  // still want and not have looked at this tab in weeks.
  const confirmed = window.confirm(
    `将删除全部 ${list.length} 个复刻音色，此操作不可撤销：\n\n` +
    list.map((entry) => `  ${entry.voice_id || entry.voiceId || entry}`).join('\n')
  );
  if (!confirmed) return;

  let failed = 0;
  for (const entry of list) {
    const voiceId = entry.voice_id || entry.voiceId || String(entry);
    const ok = await api(`/api/voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE' })
      .then(() => true)
      .catch(() => false);
    if (!ok) failed++;
  }
  log(
    'voice-status',
    failed ? `已清理 ${list.length - failed} 个，${failed} 个失败` : `已清理 ${list.length} 个音色`,
    failed ? 'error' : 'system'
  );
  if (failed) log('voice-status', '失败的可以单独重试，配额未回收干净', 'error');
  // Their aliases and tags referenced ids that are gone.
  for (const entry of list) {
    const voiceId = entry.voice_id || entry.voiceId || String(entry);
    if (voiceMeta.has(voiceId)) {
      voiceMeta.delete(voiceId);
      deleteVoiceMeta(voiceId).catch(() => {});
    }
  }
  await recordClone({ action: 'clearAll', count: list.length - failed, failed, ok: failed === 0 });
  await refreshVoices();
}

// ---- cloning ---------------------------------------------------------------

async function clone() {
  if (!clip) return;
  const prefix = el('voice-prefix').value.trim();
  const targetModel = el('voice-model').value;
  const startedAt = Date.now();
  const base = { prefix, model: targetModel, seconds: clipStats?.stats?.seconds ?? null };

  const form = new FormData();
  form.append('audio', clip, 'sample.wav');
  form.append('prefix', prefix);
  form.append('target_model', targetModel);

  el('voice-clone').disabled = true;
  log('voice-status', '正在复刻，通常需要几秒…', 'system');

  try {
    const { voice_id: voiceId } = await api('/api/voices', { method: 'POST', body: form });
    log('voice-status', `复刻成功：${voiceId}`, 'system');
    await recordClone({ ...base, voiceId, ok: true, elapsed: Date.now() - startedAt });
    await refreshVoices();
    el('voice-play-select').value = voiceId;
    noteModelSelection();
  } catch (error) {
    log('voice-status', `复刻失败：${error.message}`, 'error');
    // Failures are the half of this log that is actually useful: they are how
    // you notice you have been recording 2-second clips all afternoon.
    await recordClone({ ...base, ok: false, error: error.message });
  } finally {
    el('voice-clone').disabled = !clip;
  }
}

async function toggleRecording() {
  const button = el('voice-record');

  if (recorder) {
    const active = recorder;
    recorder = null;
    button.textContent = '开始录音';
    el('voice-level').style.width = '0';
    currentSamples = active.samples();
    currentLabel = `录音 ${active.seconds.toFixed(1)}s`;
    publishClip(currentSamples, currentLabel);
    return;
  }

  try {
    recorder = new VoiceClipRecorder(TARGET_SECONDS, (level) => {
      el('voice-level').style.width = `${Math.min(100, level * 320)}%`;
    });
    await recorder.start();
    button.textContent = '停止录音';
    log('voice-status', '录音中…', 'system');
  } catch (error) {
    recorder = null;
    log('voice-status', `无法访问麦克风：${error.message}`, 'error');
  }
}

// ---- preview synthesis -----------------------------------------------------

/** Scenes and dialects worth offering for a cloned voice.
 *
 * The per-voice tables in server/voices.py do not cover a runtime-generated
 * cloned id, so these are the common set. They are a starting point, not a
 * guarantee: the API rejects a combination the specific voice does not accept
 * and the result is surfaced rather than hidden.
 */
const CLONE_SCENES = ['闲聊对话', '新闻播报', '广告促销', '深夜电台广播', '剧情解说', '诗歌朗诵', '产品推广'];
const CLONE_DIALECTS = ['粤语', '四川话', '上海话', '闽南语', '东北话', '河南话', '天津话'];

function cloneInstructionValues(kind) {
  return instructionValues(kind, {
    emotionValues: Object.keys(state.config.emotion_labels || {}),
    sceneValues: CLONE_SCENES,
    dialectValues: CLONE_DIALECTS,
    labels: state.config.emotion_labels || {},
  });
}

function currentParams() {
  const voice = el('voice-play-select').value;
  const params = {
    // Bound to the model the voice was enrolled against; see modelFor().
    model: modelFor(voice),
    volume: Number(el('voice-volume').value),
    speech_rate: Number(el('voice-rate').value),
    pitch_rate: Number(el('voice-pitch').value),
  };
  // Always sent, so "随机" means reproducible-by-record rather than "whatever
  // the model felt like this time".
  params.seed = resolveSeed(el('voice-seed').value);

  const kind = el('voice-instruct-kind').value;
  const instruction = buildInstruction(
    kind,
    el('voice-instruct-value').value,
    el('voice-instruct-custom').value
  );
  if (instruction) params.instruction = instruction;
  return params;
}

function refreshInstructOptions() {
  const kind = el('voice-instruct-kind').value;
  const select = el('voice-instruct-value');
  select.innerHTML = '';
  const values = cloneInstructionValues(kind);
  for (const item of values) {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    select.appendChild(option);
  }
  el('voice-instruct-value-wrap').hidden = values.length === 0;
  el('voice-instruct-custom-wrap').hidden = kind !== 'custom';

  const note = el('voice-instruct-note');
  if (isVoiceDependent(kind)) {
    // The capability table has no entry for a cloned id, so this cannot be
    // predicted -- only warned about.
    note.textContent = '复刻音色不在能力表里，场景和方言取决于该音色是否支持，被拒时下方会显示原因。';
    note.hidden = false;
  } else {
    note.hidden = true;
    note.textContent = '';
  }
}

function ensureSocket() {
  if (previewSocket) return previewSocket;
  previewPlayer = new PcmPlayer(state.config.tts_sample_rate);
  previewSocket = new ResilientSocket('/ws/tts', {
    onOpen: () => applySocketStatus('voice-status', 'connected'),
    onBinary: (buffer) => {
      const chunk = new Int16Array(buffer);
      previewPlayer.push(chunk);
      if (busyPreview) busyPreview.chunks.push(chunk);
    },
    onMessage(raw) {
      // Without this the await below never returns: completion is signalled by
      // a text frame, not by the binary stream ending.
      let event;
      try {
        event = JSON.parse(raw);
      } catch (_) {
        return;
      }
      if (event.type === 'tts.done') finishPreview(null);
      else if (event.type === 'error') {
        finishPreview(event.error?.message || '生成失败');
      }
    },
    onStatus: (raw) => applySocketStatus('voice-status', raw),
  });
  previewSocket.open();
  return previewSocket;
}

function mergeChunks(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Settle the in-flight preview and release whoever is awaiting it. */
function finishPreview(error) {
  const record = busyPreview;
  if (record) {
    record.error = error;
    record.seconds = secondsOf(record.chunks);
    if (!error && !record.chunks.length) record.error = '没有返回音频';
    busyPreview = null;
    saveVoicePreview(record).catch(() => {});
    renderHistory();
  }
  if (pendingResolve) {
    const resolve = pendingResolve;
    pendingResolve = null;
    resolve();
  }
}

async function startPreview(voiceId, params) {
  const text = el('voice-play-text').value.trim() || '这是用复刻音色合成的语音。';
  if (!voiceId) return;

  const record = {
    id: `vp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    text,
    voice: voiceId,
    model: params.model,
    params,
    chunks: [],
    seconds: 0,
    error: null,
  };
  previews.unshift(record);
  if (previews.length > MAX_PREVIEWS) previews.length = MAX_PREVIEWS;
  busyPreview = record;
  renderHistory();
  saveVoicePreview(record).catch(() => {});

  const socket = ensureSocket();
  await socket.whenOpen();
  await previewPlayer.resume();
  previewPlayer.clear();

  const done = new Promise((resolve) => {
    pendingResolve = resolve;
  });
  socket.send({ type: 'tts.synthesize', text, voice: voiceId, params });
  await done;
}

function playRecord(record) {
  if (!record.chunks.length) return;
  if (previewPlayer) previewPlayer.clear();
  previewPlayer = previewPlayer || new PcmPlayer(state.config.tts_sample_rate);
  previewPlayer.push(mergeChunks(record.chunks));
  previewPlayer.resume();
}

function downloadRecord(record) {
  if (!record.chunks.length) return;
  const blob = pcmToWavBlob([mergeChunks(record.chunks)], state.config.tts_sample_rate);
  const stamp = new Date(record.createdAt).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  saveBlob(blob, `voice-preview-${stamp}.wav`);
}

async function removePreview(record) {
  previews = previews.filter((item) => item.id !== record.id);
  renderHistory();
  await deleteVoicePreview(record.id).catch(() => {});
}

function regenerate(record) {
  // A new seed, not the same one: re-running an identical request returns
  // identical audio, which looks like the button is broken.
  const params = { ...record.params, seed: nextSeed(record.params?.seed) };
  el('voice-play-select').value = record.voice;
  startPreview(record.voice, params);
}

// ---- preview history -------------------------------------------------------

function previewStatus(record) {
  if (busyPreview && busyPreview.id === record.id) return { cls: '', label: '生成中' };
  if (record.error) return { cls: 'err', label: '失败' };
  if (!record.chunks.length) return { cls: 'warn', label: '无音频' };
  return { cls: 'ok', label: '完成' };
}

function renderHistory() {
  const box = el('voice-history');
  box.innerHTML = '';
  el('voice-count').textContent = previews.length ? `（${previews.length} 条）` : '';

  if (!previews.length) {
    box.innerHTML = '<p class="muted">还没有试听记录。选一个复刻音色后点“朗读”，每次都会新增一条。</p>';
    return;
  }

  for (const record of previews) {
    const card = document.createElement('div');
    card.className = 'hcard';
    if (busyPreview && busyPreview.id === record.id) card.classList.add('busy');

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
    voice.textContent = record.voice;
    const summary = ` · ${record.model} · ${clockOf(record.createdAt)}`;
    sub.append(voice, record.params?.seed == null ? summary : `${summary} · 种子 ${record.params.seed}`);
    if (record.params?.instruction) {
      const instr = document.createElement('span');
      instr.className = 'muted';
      instr.textContent = ` · 指令 ${record.params.instruction}`;
      sub.appendChild(instr);
    }
    meta.append(title, sub);

    const tags = document.createElement('div');
    tags.className = 'htags';
    const info = previewStatus(record);
    const badge = document.createElement('span');
    badge.className = `hbadge ${info.cls}`;
    badge.textContent = info.label;
    const length = document.createElement('span');
    length.className = 'hbadge';
    length.textContent = `${(record.seconds || 0).toFixed(1)}s`;
    tags.append(badge, length);

    const actions = document.createElement('div');
    actions.className = 'hactions';
    const busy = Boolean(busyPreview && busyPreview.id === record.id);
    actions.append(
      actionButton('播放', { onClick: () => playRecord(record), disabled: !record.chunks.length || busy }),
      actionButton('下载', { className: '', onClick: () => downloadRecord(record), disabled: !record.chunks.length || busy }),
      actionButton('重新生成', { onClick: () => regenerate(record), disabled: busy }),
      actionButton('删除', { className: 'ghost danger', onClick: () => removePreview(record) })
    );

    head.append(meta, tags, actions);
    card.appendChild(head);
    if (record.error) {
      const body = document.createElement('div');
      body.className = 'hbody';
      const line = document.createElement('div');
      line.className = 'sev-error';
      line.textContent = describeError(record.error, record.params);
      body.appendChild(line);
      card.appendChild(body);
    }
    box.appendChild(card);
  }
}

/** Turns the raw SDK error into something actionable. */
function describeError(raw, params) {
  const message = String(raw || '');
  if (/428|InvalidParameter/i.test(message) && params?.instruction) {
    if (el('voice-instruct-kind').value === 'dialect') {
      return '该复刻音色不接受方言，换一条指令或重新录一段样本试试';
    }
    if (el('voice-instruct-kind').value === 'scene') {
      return '该复刻音色不接受这个场景，换个场景或去掉指令';
    }
    return '该复刻音色不接受这条指令，换个音色或去掉指令';
  }
  if (/418/.test(message)) return '音色与模型不匹配，刷新列表后重试';
  return message.length > 160 ? `${message.slice(0, 160)}…` : message;
}

// ---- clone log -------------------------------------------------------------

async function recordClone(entry) {
  const record = { id: `vc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, attemptedAt: Date.now(), ...entry };
  cloneLogs.unshift(record);
  if (cloneLogs.length > MAX_CLONE_LOGS) cloneLogs.length = MAX_CLONE_LOGS;
  renderCloneLog();
  await saveVoiceClone(record).catch(() => {});
  return record;
}

function renderCloneLog() {
  const box = el('voice-clone-log');
  box.innerHTML = '';
  el('voice-clone-count').textContent = cloneLogs.length ? `（${cloneLogs.length} 条）` : '';

  if (!cloneLogs.length) {
    box.innerHTML = '<p class="muted">还没有复刻记录。音色配额有限，这里会记下每次复刻的结果。</p>';
    return;
  }

  for (const record of cloneLogs) {
    const card = document.createElement('div');
    card.className = 'hcard';

    const head = document.createElement('div');
    head.className = 'hhead';

    const meta = document.createElement('div');
    meta.className = 'hmeta';
    const title = document.createElement('div');
    title.className = 'htitle';
    title.textContent = record.ok ? (record.voiceId || record.action) : `${record.prefix || ''} 复刻失败`;
    title.title = title.textContent;
    const sub = document.createElement('div');
    sub.className = 'hsub';
    const bits = [clockOf(record.attemptedAt)];
    if (record.model) bits.push(record.model);
    if (record.seconds != null) bits.push(`${record.seconds.toFixed(1)}s 样本`);
    if (record.elapsed) bits.push(`${(record.elapsed / 1000).toFixed(1)}s`);
    if (record.action === 'clearAll') bits.push(`清理 ${record.count} 个`);
    sub.textContent = bits.join(' · ');
    meta.append(title, sub);

    const tags = document.createElement('div');
    tags.className = 'htags';
    const badge = document.createElement('span');
    badge.className = `hbadge ${record.ok ? 'ok' : 'err'}`;
    badge.textContent = record.ok ? '成功' : '失败';
    tags.appendChild(badge);

    const actions = document.createElement('div');
    actions.className = 'hactions';
    actions.appendChild(actionButton('删除', {
      className: 'ghost danger',
      async onClick() {
        cloneLogs = cloneLogs.filter((item) => item.id !== record.id);
        renderCloneLog();
        await deleteVoiceClone(record.id).catch(() => {});
      },
    }));

    head.append(meta, tags, actions);
    card.appendChild(head);

    if (!record.ok && record.error) {
      const body = document.createElement('div');
      body.className = 'hbody';
      const line = document.createElement('div');
      line.className = 'sev-error';
      line.textContent = record.error;
      body.appendChild(line);
      card.appendChild(body);
    }
    box.appendChild(card);
  }
}

// ---- wiring ----------------------------------------------------------------

function syncOutputs() {
  el('voice-rate-out').textContent = Number(el('voice-rate').value).toFixed(2);
  el('voice-pitch-out').textContent = Number(el('voice-pitch').value).toFixed(2);
  el('voice-volume-out').textContent = el('voice-volume').value;
}

export function init() {
  el('voice-record').addEventListener('click', toggleRecording);
  el('voice-clone').addEventListener('click', clone);
  el('voice-download').addEventListener('click', downloadClip);
  el('voice-refresh').addEventListener('click', refreshVoices);
  el('voice-clear').addEventListener('click', clearAll);
  el('voice-stop').addEventListener('click', () => previewPlayer && previewPlayer.clear());

  el('voice-play').addEventListener('click', () => {
    startPreview(el('voice-play-select').value, currentParams());
  });

  el('voice-clear-history').addEventListener('click', async () => {
    if (!previews.length) return;
    previews = [];
    renderHistory();
    await clearVoicePreviews().catch(() => {});
  });

  el('voice-file').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (file) acceptFile(file);
  });

  for (const id of ['voice-rate', 'voice-pitch', 'voice-volume']) {
    el(id).addEventListener('input', syncOutputs);
  }
  el('voice-instruct-kind').addEventListener('change', refreshInstructOptions);
  el('voice-play-select').addEventListener('change', noteModelSelection);
  el('voice-trim').addEventListener('change', reapplyTrim);
  el('voice-play-text').addEventListener('input', syncStripButton);
  el('voice-filter-tag').addEventListener('change', (event) => {
    filterTag = event.target.value;
    refreshVoices();
  });
  el('voice-tag-strip').addEventListener('click', () => {
    const textarea = el('voice-play-text');
    if (!hasTags(textarea.value, state.config)) return;
    textarea.value = stripTags(textarea.value, state.config);
    syncStripButton();
  });

  const kindSelect = el('voice-instruct-kind');
  for (const kind of CLONE_INSTRUCT_KINDS) {
    const option = document.createElement('option');
    option.value = kind.id;
    option.textContent = kind.label;
    kindSelect.appendChild(option);
  }
  refreshInstructOptions();
  syncOutputs();

  loadVoicePreviews()
    .then((rows) => {
      previews = rows.slice(0, MAX_PREVIEWS);
      renderHistory();
    })
    .catch(() => {});

  loadVoiceClones()
    .then((rows) => {
      cloneLogs = rows.slice(0, MAX_CLONE_LOGS);
      renderCloneLog();
    })
    .catch(() => {});

  loadVoiceMeta()
    .then((rows) => {
      voiceMeta = new Map((rows || []).map((row) => [row.id, row]));
      return refreshVoices();
    })
    .catch(() => refreshVoices());

  renderHistory();
  renderCloneLog();
}