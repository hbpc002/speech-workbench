// The 生成视频 dialog, shared by the synthesis and voice-clone tabs.
//
// Both tabs keep finished audio and both want to turn it into a video, so the
// dialog lives here rather than being duplicated. It was originally inside
// tab_tts.js, which is why the clone tab had no button at all: the git history
// is a tab-local implementation that never got generalised.
//
// Callers normalise their own records into `{ text, sentences: [{ text, pcm }] }`
// and pass a sample rate; everything below the dialog is shape-agnostic.

import { el } from '/static/js/dom.js';
import { fillSelect } from '/static/js/tag_dialog.js';
import {
  DEFAULT_PRESET,
  PRESETS,
  buildTimeline,
  durationOf,
  extensionOf,
  fileNameFor,
  presetOf,
} from './video_timeline.js';
import { paintFrame, renderVideo } from './video_render.js';
import {
  DEFAULT_ROTATE_MODE,
  DEFAULT_ROTATE_SECONDS,
  ROTATE_MODES,
  ROTATE_SECONDS_STEPS,
  backgroundIndexAt,
} from './video_rotation.js';
import {
  MAX_ASSET_BYTES,
  acceptFor,
  deleteAsset,
  formatBytes,
  kindOfFile,
  loadAssets,
  rejectionFor,
  saveAsset,
  totalBytes,
} from './video_assets.js';
import {
  CAPTION_ANIMATIONS,
  CAPTION_POSITIONS,
  CAPTION_STYLES,
  DEFAULT_CAPTION_ANIMATION,
  DEFAULT_CAPTION_STYLE,
  DEFAULT_POSITION,
  DEFAULT_SIZE,
  DEFAULT_THEME,
  SIZE_STEPS,
  THEMES,
  normalizeOptions,
} from './video_theme.js';

/** What the dialog is rendering; null when it is closed or idle. */
let job = null;
let wired = false;

/** Background assets held in IndexedDB, loaded once per dialog open. */
let assets = [];
/** Loaded backgrounds, one entry per checked asset, in rotation order. */
let backgroundPool = [];
/**
 * The instant the preview pretends to be at, and which cue is on screen.
 *
 * The preview has no clock of its own -- it draws one representative frame -- so
 * these come from the cue it chose to show. Rotation reads them instead of a
 * frame counter, which keeps the preview honest: what it shows is what the
 * export draws at that same second.
 */
let previewSeconds = 0;
let previewCueIndex = -1;
/**
 * Ids of the checked backgrounds, in the order they will rotate.
 *
 * A list rather than one id because the rotation modes need an ordered pool.
 * Kept as ids, not elements: the elements are rebuilt on every reopen and the
 * ids are what survives in memory across a re-render of the list.
 */
let chosenBg = new Set();
/** Id of the chosen music track, or '' for none. */
let chosenMusic = '';
/** Cached decoded music buffers, keyed by asset id. */
const musicBuffers = new Map();

/** Music volume steps. Fixed rather than a slider: three audible levels are enough. */
const MUSIC_GAINS = [
  { id: '0.08', name: '轻（8%）' },
  { id: '0.18', name: '中（18%）' },
  { id: '0.32', name: '重（32%）' },
  { id: '0.5', name: '最重（50%）' },
];
const DEFAULT_MUSIC_GAIN = '0.18';

/** Scrim steps. 0 is offered for artwork that is already dark. */
const SCRIMS = [
  { id: '0', name: '不压暗' },
  { id: '0.2', name: '轻微' },
  { id: '0.35', name: '标准' },
  { id: '0.5', name: '较重' },
  { id: '0.7', name: '很重' },
];
const DEFAULT_SCRIM = '0.35';

/**
 * Draw the preview frame for the chosen canvas size.
 *
 * The preview canvas is the same size as the recorded one. Scaling it in CSS
 * rather than rendering at preview size keeps one layout path: a preview drawn
 * to different dimensions would not be a preview of the export at all.
 */
function paintPreview() {
  const canvas = el('tts-video-preview');
  const preset = presetOf(el('tts-video-preset').value);
  canvas.width = preset.width;
  canvas.height = preset.height;
  const ctx = canvas.getContext('2d');

  const timeline = buildTimeline(job.sentences, job.sampleRate);
  // The preview shows the second cue when there is one: the first often starts
  // at 0:00 with a very short line, and it hides whether the layout holds for a
  // wrapping caption.
  const cue = timeline.cues[1] || timeline.cues[0] || null;
  // The instant the preview draws. Also what the background rotation is resolved
  // against, so the picture and the caption always agree on which moment this is.
  const elapsed = cue ? cue.start + (cue.end - cue.start) * 0.4 : 0;
  previewSeconds = elapsed;
  previewCueIndex = cue ? cue.index - 1 : -1;
  paintFrame(ctx, {
    width: preset.width,
    height: preset.height,
    cue,
    title: currentOptions().title,
    progress: 0,
    elapsed,
    options: currentOptions(),
    background: previewBackground(timeline),
  });

  el('tts-video-meta').textContent = timeline.duration
    ? `${timeline.sentences.length} 个分段 · ${durationOf(timeline.duration)} · ${timeline.cues.length} 条字幕`
    : '这条记录还没有生成任何语音。';
  return timeline;
}

/** Read every control into one normalised options object. */
function currentOptions() {
  return normalizeOptions({
    theme: el('tts-video-theme').value,
    position: el('tts-video-position').value,
    style: el('tts-video-style').value,
    size: el('tts-video-size').value,
    title: el('tts-video-title').value,
    motion: el('tts-video-motion').checked,
    progressBar: el('tts-video-progressbar').checked,
    scrim: Number(el('tts-video-scrim').value),
    animation: el('tts-video-animation').value,
  });
}

/**
 * Fill the option selects, keeping whatever was chosen last time.
 *
 * `fillSelect` resets to the first option, which is not the documented default
 * (`SIZE_STEPS[0]` is 小, not 标准). Reading the current value first makes
 * re-opening the dialog stable instead of quietly changing the operator's
 * settings back.
 */
function fillOptions() {
  const keep = (id, fallback) => {
    const node = el(id);
    return node.value || fallback;
  };
  fillSelect(
    el('tts-video-theme'),
    THEMES.map((t) => ({ id: t.id, name: t.label })),
    keep('tts-video-theme', DEFAULT_THEME)
  );
  fillSelect(
    el('tts-video-size'),
    SIZE_STEPS.map((s) => ({ id: s.id, name: s.label })),
    keep('tts-video-size', DEFAULT_SIZE)
  );
  fillSelect(
    el('tts-video-style'),
    CAPTION_STYLES.map((s) => ({ id: s.id, name: s.label })),
    keep('tts-video-style', DEFAULT_CAPTION_STYLE)
  );
  fillSelect(
    el('tts-video-position'),
    CAPTION_POSITIONS.map((p) => ({ id: p.id, name: p.label })),
    keep('tts-video-position', DEFAULT_POSITION)
  );
  fillSelect(
    el('tts-video-animation'),
    CAPTION_ANIMATIONS.map((a) => ({ id: a.id, name: a.label })),
    keep('tts-video-animation', DEFAULT_CAPTION_ANIMATION)
  );
  fillSelect(
    el('tts-video-rotate'),
    ROTATE_MODES.map((m) => ({ id: m.id, name: m.label })),
    keep('tts-video-rotate', DEFAULT_ROTATE_MODE)
  );
  fillSelect(
    el('tts-video-rotatehold'),
    ROTATE_SECONDS_STEPS.map((s) => ({ id: s.id, name: s.label })),
    keep('tts-video-rotatehold', DEFAULT_ROTATE_SECONDS)
  );
}

/** Background-capable assets, in the order they were added. */
function bgAssets() {
  return assets.filter((a) => a.kind === 'image' || a.kind === 'video');
}

function musicAssets() {
  return assets.filter((a) => a.kind === 'music');
}

/** The checked backgrounds, in list order (which is also rotation order). */
function chosenBackgrounds() {
  return bgAssets().filter((asset) => chosenBg.has(asset.id));
}

/**
 * One row per stored asset, music included.
 *
 * A checkbox per row rather than a `<select multiple>`: the native multi-select
 * requires ctrl-click, shows nothing useful on a trackpad, and gives no room for
 * a size or a delete button. The checkbox is also what makes "which ones will
 * actually be drawn" visible at a glance, which a selected-row highlight does
 * not do once the list scrolls.
 */
function renderAssetList() {
  const list = el('tts-video-assetlist');
  list.textContent = '';

  for (const asset of assets) {
    const isMusic = asset.kind === 'music';
    const row = document.createElement('li');
    row.className = `asset-row${isMusic ? ' is-music' : ''}`;

    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = isMusic ? chosenMusic === asset.id : chosenBg.has(asset.id);
    box.addEventListener('change', () => {
      if (isMusic) {
        // Music is single-choice; ticking one unticks the rest, which is what a
        // radio would do but without a separate widget for two kinds in one list.
        chosenMusic = box.checked ? asset.id : '';
        for (const other of list.querySelectorAll('input[data-music]')) {
          if (other !== box) other.checked = false;
        }
      } else if (box.checked) {
        chosenBg.add(asset.id);
      } else {
        chosenBg.delete(asset.id);
      }
      void applyBackgroundChoice();
      syncRotateControls();
    });
    if (isMusic) box.dataset.music = '1';

    const name = document.createElement('span');
    name.className = 'asset-name';
    name.textContent = asset.name;
    name.title = asset.name;

    const meta = document.createElement('span');
    meta.className = 'asset-meta';
    meta.textContent = `${kindLabel(asset.kind)} · ${formatBytes(asset.bytes)}`;

    label.append(box, name, meta);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ghost danger';
    remove.textContent = '删除';
    remove.addEventListener('click', () => void removeAsset(asset));

    row.append(label, remove);
    list.append(row);
  }

  el('tts-video-assetinfo').textContent = assets.length
    ? `${assets.length} 个素材 · 共 ${formatBytes(totalBytes(assets))} · 存在本机浏览器，不上传服务器`
    : `还没有素材。单文件上限 ${formatBytes(MAX_ASSET_BYTES)}，只存在本机浏览器。`;
}

function kindLabel(kind) {
  return kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音乐';
}

/**
 * Show the rotation controls only when they can matter.
 *
 * With one background there is nothing to rotate and an enabled dropdown would
 * be a control that does nothing. The hold interval additionally only applies to
 * the two time-based modes.
 */
function syncRotateControls() {
  const count = chosenBg.size;
  const mode = el('tts-video-rotate').value;
  el('tts-video-rotate').disabled = count < 2;
  const timed = mode === 'time' || mode === 'random';
  el('tts-video-rotatehold-label').hidden = !timed || count < 2;
}

/**
 * Load every checked background into an element, ready for drawImage.
 *
 * All of them, not just the one on screen: rotation switches mid-render and
 * waiting for `loadeddata` then would stall the draw loop in the middle of a
 * recording. A background that fails to decode is dropped from the pool rather
 * than aborting the export -- the remaining ones still make a usable video, and
 * the theme gradient covers the case where none survive.
 */
async function loadBackgrounds() {
  await teardownBackgrounds();
  const pool = [];
  for (const asset of chosenBackgrounds()) {
    const element = asset.kind === 'video' ? document.createElement('video') : new Image();
    element.src = asset.url;
    if (asset.kind === 'video') {
      // Muted + inline: browsers refuse to play unmuted video without a gesture,
      // and a background video has no sound of its own to keep.
      element.muted = true;
      element.loop = true;
      element.playsInline = true;
    }
    try {
      await new Promise((resolve, reject) => {
        element.addEventListener(asset.kind === 'video' ? 'loadeddata' : 'load', resolve, { once: true });
        element.addEventListener('error', () => reject(new Error(asset.name)), { once: true });
      });
    } catch (error) {
      setStatus(`背景「${error.message}」无法解码，已跳过。`, { progress: null });
      continue;
    }
    if (asset.kind === 'video') element.play().catch(() => {});
    pool.push({ kind: asset.kind, element });
  }
  backgroundPool = pool;
  return pool;
}

async function teardownBackgrounds() {
  for (const item of backgroundPool) {
    if (item.kind === 'video') item.element.pause();
    // Dropping the src releases the decoder; without it a long dialog session
    // keeps every background it ever previewed alive.
    item.element.removeAttribute?.('src');
    item.element.src = '';
  }
  backgroundPool = [];
}

/**
 * Decode the chosen music into an AudioBuffer.
 *
 * Cached by asset id: re-decoding on every preview repaint would stall the
 * dialog for a second on a long track, and the buffer is immutable.
 */
async function loadMusic(context) {
  const asset = musicAssets().find((a) => a.id === chosenMusic);
  if (!asset) return null;
  if (musicBuffers.has(asset.id)) return musicBuffers.get(asset.id);

  try {
    const bytes = await asset.blob.arrayBuffer();
    const buffer = await context.decodeAudioData(bytes);
    musicBuffers.set(asset.id, buffer);
    return buffer;
  } catch (error) {
    setStatus(`背景音乐无法解码：${error.message}`, { progress: null });
    return null;
  }
}

/** Re-read the store and rebuild the list. */
async function refreshAssets() {
  try {
    assets = await loadAssets();
  } catch (error) {
    assets = [];
    setStatus(`读取素材失败：${error.message}`, { progress: null });
  }
  // Selections can only refer to assets that still exist.
  const ids = new Set(assets.map((a) => a.id));
  chosenBg = new Set([...chosenBg].filter((id) => ids.has(id)));
  if (chosenMusic && !ids.has(chosenMusic)) chosenMusic = '';
  renderAssetList();
  syncRotateControls();
}

/** Accept one or more dropped/selected files into the store. */
async function addFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;

  const accepted = [];
  const rejected = [];
  for (const file of files) {
    const reason = rejectionFor(file, { usedBytes: totalBytes(assets) + totalBytes(accepted) });
    if (reason) rejected.push(`${file.name}：${reason}`);
    else accepted.push(file);
  }

  for (const file of accepted) {
    try {
      await saveAsset(file, kindOfFile(file));
    } catch (error) {
      // QuotaExceededError names nothing useful on its own.
      rejected.push(
        `${file.name}：写入失败（${error.name === 'QuotaExceededError' ? '浏览器存储已满' : error.message}）`
      );
    }
  }

  await refreshAssets();

  // Newly added backgrounds are ticked automatically: uploading three photos
  // and then having to tick each one is the step this saves, and rotation is
  // the whole point of having several.
  const added = assets.filter((a) => accepted.some((f) => f.name === a.name));
  for (const asset of added) {
    if (asset.kind === 'music') chosenMusic = chosenMusic || asset.id;
    else chosenBg.add(asset.id);
  }
  renderAssetList();
  syncRotateControls();

  setStatus(
    rejected.length
      ? `已添加 ${accepted.length} 个，${rejected.length} 个被拒绝：${rejected[0]}`
      : `已添加 ${accepted.length} 个素材`,
    { progress: null }
  );
  if (accepted.length) await applyBackgroundChoice();
}

/** Delete one asset, whatever is selected. */
async function removeAsset(asset) {
  try {
    await deleteAsset(asset.id);
    URL.revokeObjectURL(asset.url);
  } catch (error) {
    setStatus(`删除失败：${error.message}`, { progress: null });
    return;
  }
  chosenBg.delete(asset.id);
  if (chosenMusic === asset.id) chosenMusic = '';
  musicBuffers.delete(asset.id);
  await refreshAssets();
  setStatus(`已删除「${asset.name}」`, { progress: null });
  await applyBackgroundChoice();
}

/** Delete whichever asset the list has ticked, if exactly one is ticked. */
async function removeSelectedAsset() {
  const picked = chosenBackgrounds();
  const target = picked.length === 1 ? picked[0] : musicAssets().find((a) => a.id === chosenMusic);
  if (!target) {
    setStatus('先勾选一个素材，再点删除。', { progress: null });
    return;
  }
  await removeAsset(target);
}

/** The background to paint right now, according to the rotation settings. */
function previewBackground(timeline) {
  if (!backgroundPool.length) return null;
  const index = backgroundIndexAt({
    count: backgroundPool.length,
    mode: el('tts-video-rotate').value,
    seconds: previewSeconds,
    cueIndex: previewCueIndex,
    holdSeconds: Number(el('tts-video-rotatehold').value),
    seed: rotationSeed(),
  });
  return backgroundPool[index < 0 ? 0 : index]?.element || null;
}

/** Stable per-dialog seed, so a preview matches what the export will do. */
let seedValue = 1;
function rotationSeed() {
  return seedValue;
}

/** Apply the current background selection and repaint. */
async function applyBackgroundChoice() {
  await loadBackgrounds();
  if (job) {
    paintPreview();
    attachBackgroundPlayback();
  }
}

/**
 * Keep background videos playing across preview repaints.
 *
 * A repaint does not stop the elements, but `paintPreview` can be reached before
 * `loadeddata` has fired, so this is where playback is re-asserted.
 */
function attachBackgroundPlayback() {
  for (const item of backgroundPool) {
    if (item.kind === 'video' && item.element.paused) item.element.play().catch(() => {});
  }
}

/**
 * One AudioContext for the dialog, reused by music decoding and recording.
 *
 * An AudioBuffer can only be played by a context with a matching sample rate
 * without resampling, and decoding against a throwaway context then rendering
 * in another one is exactly how background music ends up pitched wrong. Browsers
 * also cap the number of contexts per page, so leaking one per export would
 * eventually silence the tab.
 */
let audioContext = null;
function sharedAudioContext(sampleRate) {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
  }
  return audioContext;
}

function setStatus(text, { progress = null, busy = false } = {}) {
  el('tts-video-status').textContent = text;
  if (progress !== null) {
    el('tts-video-fill').style.width = `${Math.round(progress * 100)}%`;
  }
  el('tts-video-start').disabled = busy;
  el('tts-video-close').disabled = busy;
  for (const id of [
    'tts-video-preset',
    'tts-video-theme',
    'tts-video-size',
    'tts-video-style',
    'tts-video-position',
    'tts-video-title',
    'tts-video-motion',
    'tts-video-progressbar',
    'tts-video-animation',
    'tts-video-rotate',
    'tts-video-rotatehold',
    'tts-video-music',
    'tts-video-musicgain',
    'tts-video-scrim',
    'tts-video-upload',
    'tts-video-assetdel',
  ]) {
    el(id).disabled = busy;
  }
  el('tts-video-cancel').hidden = !busy;
}

/** Release everything the job holds. Safe to call when there is no job. */
function releaseJob() {
  if (job?.controller) job.controller.abort();
  // The blob URL is revoked on close: it pins the whole video in memory, and
  // the download has either happened or is no longer possible.
  if (job?.url) URL.revokeObjectURL(job.url);
  job = null;
}

function closeDialog() {
  releaseJob();
  const dialog = el('tts-video');
  if (dialog.open) dialog.close();
}

async function startRender() {
  if (!job) return;
  const preset = presetOf(el('tts-video-preset').value);
  const timeline = buildTimeline(job.sentences, job.sampleRate);

  if (!timeline.duration) {
    setStatus('这条记录没有可用的语音。', { progress: 0 });
    return;
  }

  const controller = new AbortController();
  job.controller = controller;
  setStatus('正在生成… 0%', { progress: 0, busy: true });

  // Music is decoded against the context renderVideo will use, at the same
  // sample rate, so it does not get resampled twice.
  const music = await loadMusic(sharedAudioContext(job.sampleRate));

  try {
    const { blob, mimeType } = await renderVideo({
      timeline,
      sentences: job.sentences,
      sampleRate: job.sampleRate,
      width: preset.width,
      height: preset.height,
      title: currentOptions().title,
      options: currentOptions(),
      monitor: el('tts-video-monitor').checked,
      backgrounds: backgroundPool,
      rotation: {
        mode: el('tts-video-rotate').value,
        holdSeconds: Number(el('tts-video-rotatehold').value),
        seed: rotationSeed(),
      },
      music,
      musicGain: Number(el('tts-video-musicgain').value),
      // The context the music was decoded in, so nothing is resampled twice.
      audioContext: sharedAudioContext(job.sampleRate),
      signal: controller.signal,
      onProgress: (fraction) => {
        setStatus(`正在生成… ${Math.round(fraction * 100)}%`, { progress: fraction, busy: true });
      },
    });

    if (!job) return;
    if (job.url) URL.revokeObjectURL(job.url);
    job.url = URL.createObjectURL(blob);

    const link = el('tts-video-download');
    link.href = job.url;
    link.download = fileNameFor(job.text, extensionOf(mimeType));
    link.hidden = false;

    // Play it back in place. Downloading to check the result is the loop this
    // replaces: the file is already in memory, and reopening the dialog rebuilds
    // it from the same inputs anyway.
    const player = el('tts-video-player');
    player.src = job.url;
    player.hidden = false;
    player.load();
    setStatus(`生成完成 · ${(blob.size / 1024 / 1024).toFixed(1)} MB`, { progress: 1 });
  } catch (error) {
    // An abort is the operator's own doing, not a failure to report as one.
    const cancelled = error?.message === '已取消' || controller.signal.aborted;
    setStatus(cancelled ? '已取消' : `生成失败：${error.message}`, { progress: null });
  } finally {
    if (job) job.controller = null;
  }
}

/** Wire the dialog's controls once, no matter how many tabs call this. */
export function initVideoDialog() {
  if (wired) return;
  wired = true;
  el('tts-video-close').addEventListener('click', closeDialog);
  el('tts-video-cancel').addEventListener('click', () => job?.controller?.abort());
  el('tts-video-start').addEventListener('click', startRender);
  for (const id of [
    'tts-video-preset',
    'tts-video-theme',
    'tts-video-size',
    'tts-video-style',
    'tts-video-position',
    'tts-video-animation',
    'tts-video-motion',
    'tts-video-progressbar',
  ]) {
    el(id).addEventListener('change', () => {
      if (job) paintPreview();
    });
  }
  el('tts-video-title').addEventListener('input', () => {
    if (job) paintPreview();
  });

  fillSelect(el('tts-video-musicgain'), MUSIC_GAINS, DEFAULT_MUSIC_GAIN);
  fillSelect(el('tts-video-scrim'), SCRIMS, DEFAULT_SCRIM);

  for (const id of ['tts-video-rotate', 'tts-video-rotatehold']) {
    el(id).addEventListener('change', () => {
      syncRotateControls();
      if (job) paintPreview();
    });
  }

  el('tts-video-music').addEventListener('change', () => {
    // Changing the track only affects the next export, not the frame on screen.
    if (job) setStatus('背景音乐已更换', { progress: null });
  });
  el('tts-video-scrim').addEventListener('change', () => {
    if (job) paintPreview();
  });

  el('tts-video-upload').addEventListener('change', (event) => {
    void addFiles(event.target.files);
    // Clearing lets the same file be picked again after a rejection.
    event.target.value = '';
  });

  el('tts-video-assetdel').addEventListener('click', () => {
    void removeSelectedAsset();
  });
  // Esc closes the dialog without going through the button, which would leave
  // the recorder running and the blob URL unreleased. Only release here --
  // calling closeDialog() would re-enter through this same event.
  el('tts-video').addEventListener('close', () => {
    releaseJob();
    void teardownBackgrounds();
    // The object URLs pinned the blobs; the list is re-read on next open.
    for (const asset of assets) URL.revokeObjectURL(asset.url);
    assets = [];
    musicBuffers.clear();
    const player = el('tts-video-player');
    player.pause();
    player.removeAttribute('src');
    player.hidden = true;
  });
}

/**
 * Open the dialog for one record.
 *
 * `sentences` is `[{ text, pcm }]`; `pcm` may be an Int16Array or base64.
 * The dialog is opened *before* the preview is painted: painting reads the
 * record's audio, and when that threw (a shape mismatch that shipped once) the
 * dialog silently never appeared and the button looked dead. An empty preview
 * is recoverable; a button that does nothing is not.
 */
export function openVideoDialog({ text = '', sentences = [], sampleRate = 22050 }) {
  releaseJob();
  job = { text, sentences, sampleRate, controller: null, url: null };

  fillSelect(el('tts-video-preset'), PRESETS.map((p) => ({ id: p.id, name: p.label })), DEFAULT_PRESET);
  fillOptions();
  // A title defaulted from the script saves the operator from retyping the
  // first line, and is short enough to fit one line at every preset.
  el('tts-video-title').value = String(text || '').trim().slice(0, 24);
  el('tts-video-download').hidden = true;
  const player = el('tts-video-player');
  player.hidden = true;
  player.removeAttribute('src');
  seedValue = Math.floor(Math.random() * 100000) + 1;
  setStatus('准备就绪', { progress: 0 });

  const dialog = el('tts-video');
  if (!dialog.open) dialog.showModal();

  // The asset list is re-read on every open rather than cached at module load:
  // another tab may have added or deleted assets while this dialog was closed.
  void refreshAssets().then(() => applyBackgroundChoice());

  try {
    paintPreview();
  } catch (error) {
    // Keep the dialog up with the reason on it. Closing here would reproduce
    // the original "click does nothing" symptom.
    console.error('视频预览绘制失败', error);
    setStatus(`无法预览这条记录：${error.message}`, { progress: 0 });
  }
}
