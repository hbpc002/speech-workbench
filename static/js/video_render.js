// Rendering a finished synthesis record to a video file, in the browser.
//
// Why here and not on the server: this app deploys to Vercel, whose function
// filesystem is read-only outside /tmp and which ships no FFmpeg. A server-side
// render would mean either a job queue or a much larger container, for a
// feature whose only inputs are audio the browser already holds.
//
// The mechanism is the standard one -- a canvas captured by `captureStream()`
// and an `AudioContext` graph routed into a `MediaStreamAudioDestinationNode`,
// both fed to one `MediaRecorder`. Two consequences worth knowing:
//
//   * recording happens in real time, so a 3-minute script takes 3 minutes. That
//     is a property of MediaRecorder, not a shortcut taken here.
//   * the clock is the AudioContext's, not `requestAnimationFrame`'s. Frames
//     are drawn to match the audio that is actually playing, so a stutter shows
//     up as a repeated frame rather than as captions drifting out of sync.

import { FPS, activeTokenIndex, pickMimeType, tokensRevealed } from './video_timeline.js';
import { DEFAULT_THEME, captionAnchorY, normalizeOptions, themeOf } from './video_theme.js';

/** Used when a caller passes no options at all, so paintFrame never derefs null. */
const DEFAULT_PALETTE = themeOf(DEFAULT_THEME);

/** Radius as a fraction of the short edge, so one layout fits every preset. */
const PAD = 0.07;

/**
 * Wrap `text` to `maxWidth`, returning lines.
 *
 * Chinese has no spaces, so wrapping falls back to per-character measurement;
 * Latin text then loses the courtesy of a word boundary. When the caller passes
 * tokens, breaks land on token boundaries instead, which is what keeps a
 * highlighted token from being split across two lines.
 */
function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const char of String(text || '')) {
    const next = line + char;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = char;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Paint one frame.
 *
 * Kept as a free function of (ctx, state) rather than closing over the render
 * loop, so the preview canvas and the recorded canvas draw identically -- a
 * preview that differs from the export is worse than no preview.
 *
 * `options` is a normalised object from `normalizeOptions`; every field is
 * optional so an older caller that passes only the original six keys still
 * renders the default theme.
 */
export function paintFrame(ctx, {
  width,
  height,
  cue,
  title,
  progress,
  elapsed = 0,
  options = {},
}) {
  const { palette, position = 'bottom', style = 'plain', sizeScale = 1, motion = true, progressBar = true } = options;
  const theme = palette || DEFAULT_PALETTE;
  const short = Math.min(width, height);

  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, theme.bgTop);
  grad.addColorStop(1, theme.bgBottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // A soft accent glow keeps a mostly-dark frame from looking like a still.
  // With `motion` it drifts, which is the only movement available on a
  // gradient field and costs one sinusoid per frame.
  const drift = motion ? Math.sin(elapsed * 0.35) * short * 0.12 : 0;
  const glow = ctx.createRadialGradient(
    width * 0.5 + drift, height * 0.12, 0,
    width * 0.5 + drift, height * 0.12, short * 0.9
  );
  glow.addColorStop(0, `${theme.accent}22`);
  glow.addColorStop(1, 'transparent');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (title) {
    ctx.fillStyle = theme.muted;
    ctx.font = `500 ${Math.round(short * 0.030)}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    const titleLines = wrapLines(ctx, title, width * (1 - PAD * 2)).slice(0, 2);
    const lineHeight = short * 0.045;
    titleLines.forEach((line, index) => {
      ctx.fillText(line, width / 2, height * PAD + index * lineHeight);
    });
  }

  const captionText = captionFor(cue, style, elapsed);
  if (captionText) {
    const fontSize = Math.round(short * 0.056 * sizeScale);
    ctx.font = `600 ${fontSize}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    const lines = wrapLines(ctx, captionText, width * (1 - PAD * 2)).slice(0, 3);
    const lineHeight = fontSize * 1.35;
    const baseline = height * captionAnchorY(position) - ((lines.length - 1) * lineHeight) / 2;

    // A plate behind the text where the theme asks for one: white-on-dark is
    // fine, but the glow varies and a caption that sometimes sits on a lighter
    // patch is unreadable. The light themes set `plate: 0` and rely on an
    // outline instead, because a dark box over near-white paper reads as a bug.
    if (theme.plate > 0) {
      const widest = Math.max(...lines.map((line) => ctx.measureText(line).width));
      const plateWidth = Math.min(width * (1 - PAD), widest + fontSize * 0.8);
      const plateHeight = lines.length * lineHeight + fontSize * 0.5;
      ctx.fillStyle = `rgba(0, 0, 0, ${theme.plate})`;
      roundRect(
        ctx,
        (width - plateWidth) / 2,
        baseline - plateHeight / 2,
        plateWidth,
        plateHeight,
        fontSize * 0.28
      );
      ctx.fill();
    }

    // Outline first, for the themes without a plate: the same shadow that makes
    // white-on-dark crisp makes black-on-paper legible cream.
    ctx.strokeStyle = theme.plate > 0 ? 'rgba(0, 0, 0, 0.55)' : theme.bgTop;
    ctx.lineWidth = Math.max(2, fontSize * 0.045);
    ctx.lineJoin = 'round';
    lines.forEach((line, index) => {
      const y = baseline + (index - (lines.length - 1) / 2) * lineHeight;
      ctx.strokeText(line, width / 2, y);
    });

    ctx.fillStyle = theme.text;
    lines.forEach((line, index) => {
      const y = baseline + (index - (lines.length - 1) / 2) * lineHeight;
      ctx.fillText(line, width / 2, y);
    });

    // Karaoke repaints the active token over the finished line, in the accent
    // colour. The x offset is measured from the line's own text so the
    // highlight lands on the character being spoken even when the token repeats
    // elsewhere in the cue -- matching by string was the first attempt and it
    // highlighted the wrong `的`.
    if (style === 'karaoke' && cue?.words?.length) {
      const active = activeTokenIndex(cue.words, elapsed);
      const activeWord = active >= 0 ? cue.words[active]?.word : '';
      if (activeWord) {
        ctx.fillStyle = theme.accent;
        lines.forEach((line, index) => {
          const y = baseline + (index - (lines.length - 1) / 2) * lineHeight;
          const at = line.indexOf(activeWord);
          if (at < 0) return;
          const prefix = line.slice(0, at);
          const lineWidth = ctx.measureText(line).width;
          const prefixWidth = ctx.measureText(prefix).width;
          const tokenWidth = ctx.measureText(activeWord).width;
          ctx.fillText(activeWord, width / 2 - lineWidth / 2 + prefixWidth + tokenWidth / 2, y);
        });
      }
    }
  }

  if (progressBar) {
    const barHeight = Math.max(3, Math.round(short * 0.006));
    const barY = height - barHeight * 2;
    ctx.fillStyle = theme.plate > 0 ? 'rgba(255, 255, 255, 0.10)' : 'rgba(0, 0, 0, 0.10)';
    ctx.fillRect(0, barY, width, barHeight);
    ctx.fillStyle = theme.accent;
    ctx.fillRect(0, barY, width * Math.max(0, Math.min(1, progress || 0)), barHeight);
  }
}

/** Caption text for the active style at `elapsed`. */
function captionFor(cue, style, elapsed) {
  if (!cue) return '';
  if (style === 'word_by_word' && cue.words?.length) return tokensRevealed(cue.words, elapsed);
  return cue.text || '';
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

/** The cue visible at `seconds`, or null between cues. */
export function cueAt(cues, seconds) {
  for (const cue of cues || []) {
    if (seconds >= cue.start && seconds < cue.end) return cue;
  }
  return null;
}

/**
 * Concatenate PCM chunks into one Int16Array, in reading order.
 *
 * Accepts the two shapes that reach this function: the `Int16Array` the TTS tab
 * stores, and base64 strings. `atob` on a typed array throws `InvalidCharacterError`,
 * which used to surface as "录制失败" only after the dialog had already opened.
 */
export function joinPcm(chunks) {
  const rows = (chunks || []).filter(Boolean);
  const decoded = rows.map((chunk) => {
    if (typeof chunk !== 'string') {
      return chunk instanceof Int16Array ? chunk : new Int16Array(chunk);
    }
    const binary = atob(chunk);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Int16Array(bytes.buffer);
  });

  const total = decoded.reduce((sum, row) => sum + row.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const row of decoded) {
    out.set(row, offset);
    offset += row.length;
  }
  return out;
}

/**
 * Render `timeline` to a video Blob.
 *
 * `onProgress(fraction)` is called on every frame, which is what the dialog's
 * progress bar reads: with a real-time recorder there is nothing else to report
 * against, and a spinner for three minutes reads as a hang.
 *
 * `signal` is an AbortSignal; aborting stops the recorder and rejects.
 */
export async function renderVideo({
  timeline,
  sentences,
  sampleRate = 22050,
  width = 1280,
  height = 720,
  title = '',
  options: rawOptions = {},
  monitor = true,
  onProgress = () => {},
  signal,
  audioContext: providedContext,
}) {
  if (!timeline || !timeline.duration) throw new Error('没有可用的音频，先生成语音再试。');

  const mimeType = pickMimeType(
    (type) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)
  );
  if (!mimeType) throw new Error('这个浏览器不支持录制视频，请换 Chrome、Edge 或 Safari 最新版。');

  const audioContext =
    providedContext ||
    new (window.AudioContext || window.webkitAudioContext)({ sampleRate });

  // One buffer holding the whole script: pushing sentence by sentence would
  // leave scheduling gaps that the microphone-facing recorder would capture as
  // clicks.
  const pcm = joinPcm(sentences.map((sentence) => sentence.pcm).filter(Boolean));
  const buffer = audioContext.createBuffer(1, pcm.length, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;

  const source = audioContext.createBufferSource();
  source.buffer = buffer;

  const destination = audioContext.createMediaStreamDestination();
  // `monitor` is what the operator hears. The destination node is what gets
  // recorded, and it must be connected either way -- muting the speakers is a
  // property of this graph, not something MediaRecorder can be told later.
  source.connect(destination);
  if (monitor) source.connect(audioContext.destination);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const options = normalizeOptions({ ...rawOptions, title });
  paintFrame(ctx, { width, height, cue: null, title, progress: 0, elapsed: 0, options });

  const stream = canvas.captureStream(FPS);
  for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);

  const recorder = new MediaRecorder(stream, { mimeType });
  const parts = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size) parts.push(event.data);
  };

  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(parts, { type: mimeType }));
    recorder.onerror = (event) => reject(event.error || new Error('录制失败'));
  });

  let frameHandle = 0;
  let settled = false;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    cancelAnimationFrame(frameHandle);
    try {
      source.stop();
    } catch (_) {
      /* already ended */
    }
    stream.getTracks().forEach((track) => track.stop());
  };

  const draw = () => {
    if (settled) return;
    const elapsed = audioContext.currentTime - startedAt;
    paintFrame(ctx, {
      width,
      height,
      cue: cueAt(timeline.cues, elapsed),
      title,
      progress: elapsed / timeline.duration,
      elapsed,
      options,
    });
    onProgress(Math.min(1, elapsed / timeline.duration));
    frameHandle = requestAnimationFrame(draw);
  };

  // A resume() without a user gesture never settles in Chrome, so awaiting it
  // plainly would hang the dialog at 0% with no error to show. Racing it turns
  // an unexplained freeze into a message the operator can act on.
  if (audioContext.state === 'suspended') {
    await Promise.race([
      audioContext.resume(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('浏览器拦下了音频播放，请再点一次「开始生成」')), 4000)
      ),
    ]);
  }
  const startedAt = audioContext.currentTime;

  recorder.start(1000);
  source.start();
  draw();

  try {
    await new Promise((resolve, reject) => {
      source.onended = resolve;
      if (signal) {
        if (signal.aborted) reject(new Error('已取消'));
        signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true });
      }
    });
    // A beat past the last sample so the final caption and the progress bar are
    // actually captured; stopping in the same tick loses the tail.
    await new Promise((resolve) => setTimeout(resolve, 180));
    recorder.stop();
    const blob = await stopped;
    onProgress(1);
    return { blob, mimeType };
  } finally {
    cleanup();
    if (!providedContext) {
      // Owned by this call, so closed here; a caller-supplied context may still
      // be in use by the preview player.
      audioContext.close().catch(() => {});
    }
  }
}
