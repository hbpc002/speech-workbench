// Enrollment clip inspection and trimming.
//
// These are the checks that stand between "I clicked 复刻" and a voice that
// actually works. create_voice accepts anything and returns a voice_id, so
// every one of these conditions otherwise shows up much later as a preview
// that just sounds wrong, with nothing pointing back at the sample.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_SECONDS,
  MIN_SECONDS,
  SAMPLE_RATE,
  TARGET_SECONDS,
  analyze,
  assess,
  frameRms,
  peakOf,
  rmsOf,
  speechFloor,
  trimSilence,
} from '../../static/js/clip_check.js';

/** A window of `seconds` at full-ish scale, i.e. clearly speech. */
function speech(samples, seconds = 1, level = 0.3, sampleRate = SAMPLE_RATE) {
  const out = new Int16Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) {
    // A few harmonics rather than a DC tone, so RMS and peak differ.
    const t = i / sampleRate;
    out[i] = Math.round(
      32768 * level * (Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 440 * t))
    );
  }
  return out;
}

function silence(samples, seconds, sampleRate = SAMPLE_RATE) {
  return new Int16Array(Math.round(seconds * sampleRate));
}

function join(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe('rmsOf', () => {
  it('is zero for an empty range', () => {
    assert.equal(rmsOf(new Int16Array(10), 0, 0), 0);
  });

  it('is zero for digital silence', () => {
    assert.equal(rmsOf(silence(null, 1), 0, SAMPLE_RATE), 0);
  });

  it('scales with amplitude', () => {
    const quiet = rmsOf(speech(null, 1, 0.1), 0, SAMPLE_RATE);
    const loud = rmsOf(speech(null, 1, 0.5), 0, SAMPLE_RATE);
    assert.ok(loud > quiet, `${loud} should exceed ${quiet}`);
  });

  it('honours the from/to window', () => {
    const clip = join(speech(null, 1), silence(null, 1));
    const head = rmsOf(clip, 0, SAMPLE_RATE);
    const all = rmsOf(clip, 0, clip.length);
    assert.ok(head > all, 'the silent tail should drag the whole-clip RMS down');
  });
});

describe('peakOf', () => {
  it('finds the largest magnitude', () => {
    assert.equal(peakOf(new Int16Array([100, -32000, 5])), 32000 / 32768);
  });

  it('is zero for silence', () => {
    assert.equal(peakOf(new Int16Array(4)), 0);
  });
});

describe('frameRms', () => {
  it('splits into 20 ms frames', () => {
    assert.equal(frameRms(speech(null, 1)).length, 50);
  });

  it('reports absolute levels, not normalised ones', () => {
    // An absolute dBFS threshold only means something if these are absolute.
    const loud = frameRms(speech(null, 1, 0.5));
    const quiet = frameRms(speech(null, 1, 0.05));
    assert.ok(loud[0] > quiet[0] * 5, `${loud[0]} should dwarf ${quiet[0]}`);
  });

  it('is all zero for digital silence', () => {
    assert.deepEqual(frameRms(silence(null, 1)), new Array(50).fill(0));
  });
});

describe('speechFloor', () => {
  it('keeps an absolute floor so digital silence is silence', () => {
    // Every frame is equally quiet here, so a purely relative threshold would
    // find nothing standing out and call the whole clip one long syllable.
    assert.ok(speechFloor(new Array(50).fill(0)) > 0);
  });

  it('scales with a louder clip', () => {
    const quiet = speechFloor(frameRms(speech(null, 2, 0.02)));
    const loud = speechFloor(frameRms(speech(null, 2, 0.5)));
    assert.ok(loud > quiet, `${loud} should exceed ${quiet}`);
  });
});

describe('analyze', () => {
  it('reports duration from the sample count', () => {
    const stats = analyze(speech(null, 3));
    assert.ok(Math.abs(stats.seconds - 3) < 1e-9);
  });

  it('reports a mostly-speech clip as such', () => {
    const stats = analyze(join(speech(null, 8), silence(null, 2)));
    assert.ok(stats.voiceRatio > 0.7, `voiceRatio was ${stats.voiceRatio}`);
  });

  it('reports a mostly-silent clip as such', () => {
    const stats = analyze(join(silence(null, 8), speech(null, 2)));
    assert.ok(stats.voiceRatio < 0.3, `voiceRatio was ${stats.voiceRatio}`);
  });

  it('voice and silent ratios add up', () => {
    const stats = analyze(join(speech(null, 3), silence(null, 3)));
    assert.ok(Math.abs(stats.voiceRatio + stats.silentRatio - 1) < 1e-9);
  });

  it('flags clipping as a ratio', () => {
    const hot = new Int16Array(1000);
    hot.fill(32767);
    const stats = analyze(hot);
    assert.equal(stats.clippedSamples, 1000);
    assert.equal(stats.clipRatio, 1);
    // Int16 tops out at 32767, so full scale is that, not 1.0.
    assert.ok(Math.abs(stats.peak - 32767 / 32768) < 1e-12);
  });

  it('calls digital silence silence rather than speech', () => {
    const stats = analyze(silence(null, 10));
    assert.equal(stats.voiceRatio, 0);
  });

  it('still hears speech in a very low gain recording', () => {
    // The case an absolute dBFS threshold gets backwards.
    const stats = analyze(speech(null, 8, 0.004));
    assert.ok(stats.voiceRatio > 0.9, `voiceRatio was ${stats.voiceRatio}`);
  });

  it('does not flag a clean recording as clipped', () => {
    assert.equal(analyze(speech(null, 1)).clippedSamples, 0);
  });

  it('handles an empty clip without NaN', () => {
    const stats = analyze(new Int16Array(0));
    assert.equal(stats.seconds, 0);
    assert.equal(stats.silentRatio, 1);
    assert.ok(Number.isFinite(stats.rms));
  });
});

describe('assess', () => {
  it('passes a clean 10 second clip', () => {
    const result = assess(analyze(speech(null, 10)));
    assert.equal(result.level, 'ok', JSON.stringify(result.issues));
    assert.equal(result.ok, true);
  });

  it('rejects a clip shorter than the minimum', () => {
    const result = assess(analyze(speech(null, 1)));
    assert.equal(result.level, 'error');
    assert.match(result.issues[0].text, new RegExp(`${MIN_SECONDS}`));
  });

  it('warns rather than blocks on a shortish clip', () => {
    const result = assess(analyze(speech(null, 5)));
    assert.equal(result.level, 'warn');
    assert.equal(result.ok, false);
  });

  it('rejects a clip that is mostly silence', () => {
    const result = assess(analyze(join(silence(null, 8), speech(null, 2))));
    assert.equal(result.level, 'error');
    assert.match(result.issues[0].text, /人声/);
  });

  it('warns about leading and trailing silence', () => {
    const result = assess(analyze(join(silence(null, 4), speech(null, 5), silence(null, 1))));
    assert.equal(result.level, 'warn');
  });

  it('rejects a clip that is entirely silent', () => {
    const result = assess(analyze(silence(null, 10)));
    assert.equal(result.level, 'error');
    assert.ok(result.issues.some((i) => /人声/.test(i.text)));
  });

  it('warns about a clipped recording', () => {
    const hot = new Int16Array(Math.round(10 * SAMPLE_RATE));
    hot.fill(32767);
    const result = assess(analyze(hot));
    assert.equal(result.level, 'warn');
    assert.ok(result.issues.some((i) => /削顶|削波/.test(i.text)));
  });

  it('warns when the whole clip is very quiet but audible', () => {
    // Low gain yet still real speech: warn about level, do not call it silence.
    const result = assess(analyze(speech(null, 10, 0.005)));
    assert.ok(result.issues.some((i) => /音量偏低/.test(i.text)), JSON.stringify(result.issues));
  });

  it('warns about a long clip', () => {
    const result = assess(analyze(speech(null, MAX_SECONDS + 5)));
    assert.equal(result.level, 'warn');
  });

  it('respects a custom target', () => {
    const result = assess(analyze(speech(null, 3)), { targetSeconds: 30 });
    assert.equal(result.level, 'warn');
  });

  it('escalates to error when something hard-fails', () => {
    // A short clip is only a warning on its own; a mostly-silent one is fatal
    // and must not be reported as merely 'warn'.
    const result = assess(analyze(join(silence(null, 2), speech(null, 0.5))));
    assert.equal(result.level, 'error');
  });

  it('uses the same silence threshold for analysis as for reporting', () => {
    assert.equal(TARGET_SECONDS, 10);
  });
});

describe('trimSilence', () => {
  it('cuts leading and trailing silence and keeps the speech', () => {
    const padded = join(silence(null, 2), speech(null, 6), silence(null, 2));
    const result = trimSilence(padded, SAMPLE_RATE);
    assert.equal(result.trimmed, true);
    const kept = result.samples.length / SAMPLE_RATE;
    assert.ok(kept < 7, `kept ${kept}s, expected well under the original 10s`);
    assert.ok(kept > 5, `kept ${kept}s, the speech itself should survive`);
  });

  it('leaves an already-tight clip alone', () => {
    const tight = speech(null, 6);
    const result = trimSilence(tight, SAMPLE_RATE);
    assert.equal(result.trimmed, false);
    assert.equal(result.samples, tight);
  });

  it('keeps a little padding so it does not start abruptly', () => {
    const padded = join(silence(null, 2), speech(null, 6));
    const result = trimSilence(padded, SAMPLE_RATE);
    // The cut must land before the first speech sample, not on it.
    assert.ok(result.startSec > 1.5, `startSec was ${result.startSec}`);
  });

  it('refuses to trim an all-silent clip away', () => {
    // Trimming here would produce an empty clip; assess() reports it instead.
    const dead = silence(null, 5);
    const result = trimSilence(dead, SAMPLE_RATE);
    assert.equal(result.trimmed, false);
    assert.equal(result.samples.length, dead.length);
  });

  it('never returns something longer than it was given', () => {
    const result = trimSilence(join(silence(null, 3), speech(null, 2), silence(null, 3)));
    assert.ok(result.samples.length <= 8 * SAMPLE_RATE);
  });

  it('caps a very long clip at maxSeconds', () => {
    const long = join(speech(null, 40), speech(null, 40));
    const result = trimSilence(long, SAMPLE_RATE, { maxSeconds: 15 });
    assert.ok(result.samples.length / SAMPLE_RATE <= 15);
  });

  it('trims from a recording whose silence is not digital zero', () => {
    // Real rooms have a noise floor. A threshold relative to the clip's own
    // envelope is what makes this work; an absolute one would cut the speech.
    const floor = new Int16Array(Math.round(2 * SAMPLE_RATE));
    for (let i = 0; i < floor.length; i++) {
      floor[i] = Math.round((Math.random() * 2 - 1) * 60);
    }
    const result = trimSilence(join(floor, speech(null, 5)), SAMPLE_RATE);
    assert.equal(result.trimmed, true);
    assert.ok(result.samples.length / SAMPLE_RATE < 6);
  });

  it('handles an empty clip', () => {
    const result = trimSilence(new Int16Array(0), SAMPLE_RATE);
    assert.equal(result.trimmed, false);
  });
});

describe('trimSilence', () => {
  it('ignores samples below -1 dBFS when judging clipping', () => {
    const soft = new Int16Array(100);
    soft.fill(Math.round(32768 * 0.5));
    assert.equal(analyze(soft).clippedSamples, 0);
  });
});