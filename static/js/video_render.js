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

import { FPS, pickMimeType } from '/static/js/video_timeline.js';

/** Palette, mirrored from the stylesheet's custom properties. */
const COLORS = {
  bgTop: '#171a23',
  bgBottom: '#0f1117',
  text: '#e6e8ee',
  muted: '#8b93a7',
  accent: '#6c8cff',
};

/** Radius as a fraction of the short edge, so one layout fits every preset. */
const PAD = 0.07;

function wrapLines(ctx, text, maxWidth) {
  // Chinese has no spaces, so wrapping has to fall back to per-character
  // measurement; Latin text then loses the courtesy of a word boundary, which
  // is a fair trade for one code path that never splits a CJK caption wrongly.
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
 */
export function paintFrame(ctx, { width, height, cue, title, progress, accent }) {
  const short = Math.min(width, height);

  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, COLORS.bgTop);
  grad.addColorStop(1, COLORS.bgBottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // A soft accent glow keeps a mostly-dark frame from looking like a still.
  const glow = ctx.createRadialGradient(
    width * 0.5, height * 0.12, 0,
    width * 0.5, height * 0.12, short * 0.9
  );
  glow.addColorStop(0, `${accent || COLORS.accent}22`);
  glow.addColorStop(1, 'transparent');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (title) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = `500 ${Math.round(short * 0.030)}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    const titleLines = wrapLines(ctx, title, width * (1 - PAD * 2)).slice(0, 2);
    const lineHeight = short * 0.045;
    titleLines.forEach((line, index) => {
      ctx.fillText(line, width / 2, height * PAD + index * lineHeight);
    });
  }

  if (cue && cue.text) {
    const fontSize = Math.round(short * 0.056);
    ctx.font = `600 ${fontSize}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    const lines = wrapLines(ctx, cue.text, width * (1 - PAD * 2)).slice(0, 3);
    const lineHeight = fontSize * 1.35;
    // Anchored off the progress bar, not the frame edge, so the caption never
    // collides with it on the square preset.
    const baseline = height * 0.86 - ((lines.length - 1) * lineHeight) / 2;

    // A dark plate behind the text: white-on-dark is fine, but the glow varies
    // and a caption that sometimes sits on a lighter patch is unreadable.
    const widest = Math.max(...lines.map((line) => ctx.measureText(line).width));
    const plateWidth = Math.min(width * (1 - PAD), widest + fontSize * 0.8);
    const plateHeight = lines.length * lineHeight + fontSize * 0.5;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    roundRect(
      ctx,
      (width - plateWidth) / 2,
      baseline - plateHeight / 2,
      plateWidth,
      plateHeight,
      fontSize * 0.28
    );
    ctx.fill();

    ctx.fillStyle = COLORS.text;
    lines.forEach((line, index) => {
      ctx.fillText(line, width / 2, baseline + (index - (lines.length - 1) / 2) * lineHeight);
    });
  }

  const barHeight = Math.max(3, Math.round(short * 0.006));
  const barY = height - barHeight * 2;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
  ctx.fillRect(0, barY, width, barHeight);
  ctx.fillStyle = accent || COLORS.accent;
  ctx.fillRect(0, barY, width * Math.max(0, Math.min(1, progress || 0)), barHeight);
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

/** Concatenate base64 PCM chunks into one Int16Array, in reading order. */
export function joinPcm(chunks) {
  let total = 0;
  const decoded = chunks.map((chunk) => {
    const binary = atob(chunk);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    total += bytes.length / 2;
    return new Int16Array(bytes.buffer);
  });

  const out = new Int16Array(total);
  let offset = 0;
  for (const chunk of decoded) {
    out.set(chunk, offset);
    offset += chunk.length;
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
  accent = COLORS.accent,
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
  paintFrame(ctx, { width, height, cue: null, title, progress: 0, accent });

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
      accent,
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
