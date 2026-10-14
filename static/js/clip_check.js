// Enrollment clip inspection and trimming.
//
// Pure functions over Int16 PCM, no DOM and no audio APIs, so the parts that
// are easy to get subtly wrong are unit-testable under `node --test` like
// tag_rules.js and seed_policy.js.
//
// Why this exists: DashScope's create_voice returns a voice_id whether or not
// the sample was any good. A ten-second clip that is mostly silence, or is far
// too short, produces a bad voice with no error anywhere -- the only symptom
// is that the preview sounds wrong minutes later. Telling the user before they
// spend a voice slot (the quota is limited and 清理全部 is irreversible) is
// worth more than any amount of post-hoc diagnosis.
//
// Thresholds are deliberately loose. A borderline clip gets a warning, not a
// block: refusing to clone someone's voice because the RMS was 1 dB low would
// be worse than cloning it.

/** What DashScope is documented to want, mirrored from server/config.py. */
export const TARGET_SECONDS = 10;
export const SAMPLE_RATE = 16000;

// Exported because the UI quotes these numbers back to the user, so the
// thresholds the copy refers to and the ones enforced are the same values.
export const MIN_SECONDS = 3;
export const MAX_SECONDS = 60;

/** Window used for the level envelope. 20 ms is short enough to catch pauses. */
const WINDOW_SECONDS = 0.02;

/**
 * A frame counts as speech when it is audible *relative to the clip's own
 * loudest moment*.
 *
 * An absolute dBFS threshold cannot work here. A recording made at low gain
 * has a noise floor well above digital silence, so "-42 dBFS" would read the
 * whole clip as silence -- exactly backwards for the clips most likely to need
 * the advice. Normalising per clip is the only version that gets a quiet
 * recording and a hot one to agree.
 */
const RELATIVE_SPEECH = 0.06;

/** Absolute floor, used only when a clip is so quiet that relative fails. */
const ABSOLUTE_FLOOR = 0.002;

export function rmsOf(samples, from, to) {
  let sum = 0;
  const n = Math.max(0, to - from);
  for (let i = from; i < to; i++) {
    const v = samples[i] / 32768;
    sum += v * v;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

export function peakOf(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i] / 32768);
    if (v > peak) peak = v;
  }
  return peak;
}

/** Absolute RMS of each 20 ms window. Always absolute, never normalised. */
export function frameRms(samples, sampleRate = SAMPLE_RATE) {
  const size = Math.max(1, Math.round(sampleRate * WINDOW_SECONDS));
  const out = [];
  for (let start = 0; start < samples.length; start += size) {
    out.push(rmsOf(samples, start, Math.min(start + size, samples.length)));
  }
  return out;
}

/** Samples pinned at or near full scale -- input gain was too hot. */
function countClipped(samples) {
  let clipped = 0;
  // -1 dBFS; anything at the rail is almost certainly a clipped recording.
  const ceiling = 32768 * 0.891;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) >= ceiling) clipped++;
  }
  return clipped;
}

/**
 * The level a frame has to beat to count as speech for this particular clip.
 *
 * Both a relative and an absolute term are needed. Relative alone cannot
 * classify digital silence at all -- every frame is equally quiet, so nothing
 * stands out and the whole clip would read as one long syllable.
 */
export function speechFloor(frames) {
  let loudest = 0;
  for (const value of frames) if (value > loudest) loudest = value;
  return Math.max(loudest * RELATIVE_SPEECH, ABSOLUTE_FLOOR);
}

export function analyze(samples, sampleRate = SAMPLE_RATE) {
  const frames = frameRms(samples, sampleRate);
  const floor = speechFloor(frames);
  let voiced = 0;
  for (const value of frames) if (value >= floor) voiced++;
  const clipped = countClipped(samples);

  return {
    seconds: samples.length / sampleRate,
    rms: rmsOf(samples, 0, samples.length),
    peak: peakOf(samples),
    // Fraction of the clip that is speech rather than silence.
    voiceRatio: frames.length ? voiced / frames.length : 0,
    silentRatio: frames.length ? 1 - voiced / frames.length : 1,
    clippedSamples: clipped,
    clipRatio: samples.length ? clipped / samples.length : 0,
  };
}

export function assess(stats, { targetSeconds = TARGET_SECONDS } = {}) {
  const issues = [];
  let level = 'ok';

  const raise = (severity, text) => {
    issues.push({ severity, text });
    if (severity === 'error' || level === 'ok') level = severity;
  };

  if (stats.seconds < MIN_SECONDS) {
    raise('error', `只有 ${stats.seconds.toFixed(1)} 秒，至少要 ${MIN_SECONDS} 秒`);
  } else if (stats.seconds < targetSeconds * 0.6) {
    raise('warn', `只有 ${stats.seconds.toFixed(1)} 秒，建议 ${targetSeconds} 秒左右`);
  } else if (stats.seconds > MAX_SECONDS) {
    raise('warn', `${stats.seconds.toFixed(1)} 秒偏长，建议裁到 ${MAX_SECONDS} 秒以内`);
  }

  if (stats.voiceRatio <= 0) {
    raise('error', '整段几乎没有检测到人声，可能是静音或音量过低');
  } else if (stats.voiceRatio < 0.45) {
    raise(
      'error',
      `只有 ${Math.round(stats.voiceRatio * 100)}% 是人声，其余基本是静音，克隆出的音色会明显发空`
    );
  } else if (stats.voiceRatio < 0.65) {
    raise('warn', `人声占比 ${Math.round(stats.voiceRatio * 100)}%，静音偏多`);
  }

  if (stats.peak > 0.995) {
    raise('warn', '音量已经削顶，重新录一段效果会更好');
  } else if (stats.peak > 0 && stats.rms < 0.02) {
    raise('warn', '整体音量偏低，靠近麦克风一些会更好');
  }

  if (stats.clipRatio > 0.001) {
    raise('warn', '有削波失真的采样点');
  }

  return { level, issues, ok: issues.length === 0 };
}

/**
 * Drop leading and trailing silence, keeping a little padding so the clip does
 * not start or end abruptly.
 *
 * Returns the original array untouched when there is nothing meaningful to cut,
 * so the caller can skip re-encoding a clip that is already tight.
 */
export function trimSilence(
  samples,
  sampleRate = SAMPLE_RATE,
  { threshold = 0.1, padSeconds = 0.15, maxSeconds = MAX_SECONDS } = {}
) {
  const untouched = { samples, trimmed: false, startSec: 0, endSec: samples.length / sampleRate };
  if (!samples.length) return untouched;

  const frames = frameRms(samples, sampleRate);
  if (!frames.length) return untouched;

  // Relative to the clip's loudest window, so a noisy room's floor is trimmed
  // without the speech going with it.
  let loudest = 0;
  for (const value of frames) if (value > loudest) loudest = value;
  const cutoff = loudest * threshold;

  const size = Math.max(1, Math.round(sampleRate * WINDOW_SECONDS));
  let first = -1;
  let last = -1;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i] >= cutoff) {
      if (first === -1) first = i;
      last = i;
    }
  }
  // Nothing above the cutoff: leave it for assess() to reject. Trimming here
  // would hand back an empty clip and the failure would move downstream.
  if (first === -1) return untouched;

  const pad = Math.round(padSeconds * sampleRate);
  const start = Math.max(0, first * size - pad);
  let end = Math.min(samples.length, (last + 1) * size + pad);

  const cap = Math.round(maxSeconds * sampleRate);
  if (end - start > cap) end = start + cap;
  if (end - start >= samples.length) return untouched;

  return {
    samples: samples.slice(start, end),
    trimmed: true,
    startSec: start / sampleRate,
    endSec: end / sampleRate,
  };
}

export { countClipped };