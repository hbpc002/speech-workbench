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
  CAPTION_POSITIONS,
  CAPTION_STYLES,
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
/** The decoded background music for the current selection, cached by asset id. */
let musicCache = { id: '', buffer: null };
/** The loaded background element (image or video) for the selection. */
let background = null;

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
  paintFrame(ctx, {
    width: preset.width,
    height: preset.height,
    cue,
    title: currentOptions().title,
    progress: 0,
    elapsed: cue ? cue.start + (cue.end - cue.start) * 0.4 : 0,
    options: currentOptions(),
    background: background?.element || null,
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
}

/** The asset currently chosen in a select, or null for 无. */
function selectedAsset(selectId) {
  const id = el(selectId).value;
  return assets.find((asset) => asset.id === id) || null;
}

/**
 * Refill the background and music selects from `assets`.
 *
 * Backgrounds and music share one store but not one list: picking a song as a
 * background must not be possible, so each select only offers its own kind.
 * The current choice survives the refill so uploading a second asset does not
 * reset the first one that was already chosen.
 */
function fillAssetSelects() {
  const backgrounds = assets.filter((a) => a.kind === 'image' || a.kind === 'video');
  const music = assets.filter((a) => a.kind === 'music');

  const bgKeep = el('tts-video-bg').value;
  const muKeep = el('tts-video-music').value;
  fillSelect(
    el('tts-video-bg'),
    [{ id: '', name: '无（用主题背景）' }, ...backgrounds.map((a) => ({ id: a.id, name: assetLabel(a) }))],
    backgrounds.some((a) => a.id === bgKeep) ? bgKeep : ''
  );
  fillSelect(
    el('tts-video-music'),
    [{ id: '', name: '无' }, ...music.map((a) => ({ id: a.id, name: assetLabel(a) }))],
    music.some((a) => a.id === muKeep) ? muKeep : ''
  );

  el('tts-video-assetinfo').textContent = assets.length
    ? `${assets.length} 个素材 · 共 ${formatBytes(totalBytes(assets))} · 存在本机浏览器，不上传服务器`
    : `还没有素材。单文件上限 ${formatBytes(MAX_ASSET_BYTES)}，只存在本机浏览器。`;
}

/** `度假.mp4 · 12.3 MB`, so the select shows size without a second line. */
function assetLabel(asset) {
  const kind = asset.kind === 'image' ? '图' : asset.kind === 'video' ? '视频' : '音乐';
  return `${asset.name} · ${kind} · ${formatBytes(asset.bytes)}`;
}

/**
 * Load the chosen background into an element, ready for drawImage.
 *
 * Returns null and clears the status on failure: a background that will not
 * decode must degrade to the theme gradient, not abort the export after the
 * operator has waited through it.
 */
async function loadBackground() {
  const asset = selectedAsset('tts-video-bg');
  await teardownBackground();
  if (!asset) return null;

  const element = asset.kind === 'video' ? document.createElement('video') : new Image();
  element.src = asset.url;
  if (asset.kind === 'video') {
    // Muted + inline: browsers refuse to play unmuted video without a gesture,
    // and a background video has no sound of its own to keep.
    element.muted = true;
    element.loop = true;
    element.playsInline = true;
    element.crossOrigin = 'anonymous';
  }

  try {
    await new Promise((resolve, reject) => {
      const done = () => resolve();
      element.addEventListener(asset.kind === 'video' ? 'loadeddata' : 'load', done, { once: true });
      element.addEventListener('error', () => reject(new Error('这个素材无法解码')), { once: true });
    });
  } catch (error) {
    setStatus(`背景素材加载失败：${error.message}`, { progress: null });
    return null;
  }

  if (asset.kind === 'video') {
    // Playing it here is what makes the frames advance; the draw loop only
    // samples whatever the element currently shows.
    element.play().catch(() => {});
  }
  background = { kind: asset.kind, element };
  return background;
}

async function teardownBackground() {
  if (background?.kind === 'video') {
    background.element.pause();
  }
  if (background?.element) {
    // Dropping the src releases the decoder; without it a long dialog session
    // keeps every background it ever previewed alive.
    background.element.removeAttribute?.('src');
    background.element.src = '';
  }
  background = null;
}

/**
 * Decode the chosen music into an AudioBuffer.
 *
 * Decoding is per selection and cached by asset id: re-decoding on every
 * preview repaint would stall the dialog for a second on a long track.
 */
async function loadMusic(context) {
  const asset = selectedAsset('tts-video-music');
  if (!asset) {
    musicCache = { id: '', buffer: null };
    return null;
  }
  if (musicCache.id === asset.id) return musicCache.buffer;

  try {
    const bytes = await asset.blob.arrayBuffer();
    const buffer = await context.decodeAudioData(bytes);
    musicCache = { id: asset.id, buffer };
    return buffer;
  } catch (error) {
    setStatus(`背景音乐无法解码：${error.message}`, { progress: null });
    musicCache = { id: '', buffer: null };
    return null;
  }
}

/** Re-read the store and refresh both selects. */
async function refreshAssets() {
  try {
    assets = await loadAssets();
  } catch (error) {
    assets = [];
    setStatus(`读取素材失败：${error.message}`, { progress: null });
  }
  fillAssetSelects();
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
      // QuotaExceededError arrives here, and it names nothing useful on its own.
      rejected.push(`${file.name}：写入失败（${error.name === 'QuotaExceededError' ? '浏览器存储已满' : error.message}）`);
    }
  }

  await refreshAssets();
  // The newest asset is almost always the one being added, so select it: making
  // the operator find it in a list of twenty is the step this saves.
  const newest = assets[0];
  if (newest && accepted.length) {
    const target = newest.kind === 'music' ? 'tts-video-music' : 'tts-video-bg';
    el(target).value = newest.id;
  }
  setStatus(
    rejected.length
      ? `已添加 ${accepted.length} 个，${rejected.length} 个被拒绝：${rejected[0]}`
      : `已添加 ${accepted.length} 个素材`,
    { progress: null }
  );
  if (accepted.length) await applyBackgroundChoice();
}

/**
 * Delete the asset currently chosen in the background select.
 *
 * Deletes whichever select holds a real asset, background first: the delete
 * button sits next to both, and doing nothing because two selects exist would
 * be the confusing outcome. Rendered videos do not reference assets by id (the
 * video is already baked), so nothing else has to be cleaned up.
 */
async function removeSelectedAsset() {
  const asset = selectedAsset('tts-video-bg') || selectedAsset('tts-video-music');
  if (!asset) {
    setStatus('先在「背景」或「背景音乐」里选一个素材，再删除。', { progress: null });
    return;
  }
  try {
    await deleteAsset(asset.id);
    URL.revokeObjectURL(asset.url);
  } catch (error) {
    setStatus(`删除失败：${error.message}`, { progress: null });
    return;
  }
  await refreshAssets();
  setStatus(`已删除「${asset.name}」`, { progress: null });
  await applyBackgroundChoice();
}

/** Apply the current background selection and repaint. */
async function applyBackgroundChoice() {
  await loadBackground();
  if (job) {
    paintPreview();
    attachBackgroundPlayback();
  }
}

/**
 * Keep the background video playing across preview repaints.
 *
 * A repaint does not stop the element, but `paintPreview` can be reached before
 * the video has started (the `loadeddata` await is asynchronous), so this is
 * where playback is re-asserted.
 */
function attachBackgroundPlayback() {
  if (background?.kind === 'video' && background.element.paused) {
    background.element.play().catch(() => {});
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
    'tts-video-bg',
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
      background,
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

  el('tts-video-bg').addEventListener('change', () => {
    if (job) void applyBackgroundChoice();
  });
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
    void teardownBackground();
    // The object URLs pinned the blobs; the list is re-read on next open.
    for (const asset of assets) URL.revokeObjectURL(asset.url);
    assets = [];
    musicCache = { id: '', buffer: null };
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
