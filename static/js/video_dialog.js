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
  // Esc closes the dialog without going through the button, which would leave
  // the recorder running and the blob URL unreleased. Only release here --
  // calling closeDialog() would re-enter through this same event.
  el('tts-video').addEventListener('close', releaseJob);
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

  try {
    paintPreview();
  } catch (error) {
    // Keep the dialog up with the reason on it. Closing here would reproduce
    // the original "click does nothing" symptom.
    console.error('视频预览绘制失败', error);
    setStatus(`无法预览这条记录：${error.message}`, { progress: 0 });
  }
}
