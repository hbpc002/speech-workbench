// Rotating among several backgrounds, and the caption entrance animations.
//
// Both are resolved from a clock rather than from a mutable cursor, and that is
// the property worth testing: the preview and the export ask for the same
// instant independently, and the recorder replays frames when it stutters. A
// counter would silently desynchronise those two, and the symptom (a slideshow
// that skips or repeats) looks like a design choice rather than a bug.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_ROTATE_MODE,
  ROTATE_MODES,
  backgroundIdAt,
  backgroundIndexAt,
  randomIndex,
} from '../../static/js/video_rotation.js';
import {
  CAPTION_ANIMATIONS,
  DEFAULT_CAPTION_ANIMATION,
  animationOf,
  animationProgress,
  captionTransform,
  normalizeOptions,
} from '../../static/js/video_theme.js';

describe('backgroundIndexAt', () => {
  it('returns -1 when nothing is chosen, so the theme gradient shows', () => {
    assert.equal(backgroundIndexAt({ count: 0 }), -1);
    assert.equal(backgroundIndexAt({ count: 0, mode: 'cue', cueIndex: 3 }), -1);
  });

  it('always picks the only background when there is one', () => {
    for (const mode of ['single', 'cue', 'time', 'random']) {
      assert.equal(backgroundIndexAt({ count: 1, mode, seconds: 99, cueIndex: 9 }), 0);
    }
  });

  it('locks to the first in single mode', () => {
    assert.equal(backgroundIndexAt({ count: 4, mode: 'single', seconds: 100, cueIndex: 7 }), 0);
  });

  it('follows the caption in cue mode', () => {
    const at = (cueIndex) => backgroundIndexAt({ count: 3, mode: 'cue', cueIndex });
    assert.deepEqual([0, 1, 2, 3, 4].map(at), [0, 1, 2, 0, 1]);
  });

  it('shows the first background before the first cue', () => {
    // The opening frames have no sentence on screen; showing nothing would mean
    // a flash of the theme gradient at the start of every export.
    assert.equal(backgroundIndexAt({ count: 3, mode: 'cue', cueIndex: -1 }), 0);
  });

  it('advances on wall time in time mode', () => {
    const at = (seconds) => backgroundIndexAt({ count: 3, mode: 'time', seconds, holdSeconds: 5 });
    assert.deepEqual([0, 4.9, 5, 9.9, 10, 15].map(at), [0, 0, 1, 1, 2, 0]);
  });

  it('honours the hold interval in time mode', () => {
    assert.equal(backgroundIndexAt({ count: 2, mode: 'time', seconds: 7, holdSeconds: 8 }), 0);
    assert.equal(backgroundIndexAt({ count: 2, mode: 'time', seconds: 8, holdSeconds: 8 }), 1);
  });

  it('never divides by a zero or negative hold', () => {
    // A cleared <select> yields NaN here; without the clamp every frame would
    // land in slot NaN and draw the same picture forever.
    for (const hold of [0, -5, NaN, undefined]) {
      const index = backgroundIndexAt({ count: 3, mode: 'time', seconds: 12, holdSeconds: hold });
      assert.ok(index >= 0 && index < 3, `hold=${hold} gave ${index}`);
    }
  });

  it('is deterministic in random mode', () => {
    const pick = (seed) =>
      [0, 1, 2, 3, 4, 5, 6, 7].map((slot) =>
        backgroundIndexAt({ count: 5, mode: 'random', seconds: slot * 5, holdSeconds: 5, seed })
      );
    assert.deepEqual(pick(7), pick(7));
  });

  it('gives different seeds different orders', () => {
    const pick = (seed) =>
      [0, 1, 2, 3, 4, 5].map((slot) =>
        backgroundIndexAt({ count: 6, mode: 'random', seconds: slot * 5, holdSeconds: 5, seed })
      ).join(',');
    assert.notEqual(pick(1), pick(2));
  });

  it('stays in range for random mode at any slot', () => {
    for (const count of [2, 3, 7, 13]) {
      for (let slot = 0; slot < 60; slot++) {
        const index = randomIndex(slot, count, 42);
        assert.ok(index >= 0 && index < count, `count=${count} slot=${slot} -> ${index}`);
      }
    }
  });

  it('treats an unknown mode as the default rather than returning -1', () => {
    const index = backgroundIndexAt({ count: 3, mode: 'nonsense', seconds: 0, cueIndex: 1 });
    assert.ok(index >= 0 && index < 3);
  });

  it('is a pure function of its inputs', () => {
    const args = { count: 4, mode: 'random', seconds: 12, holdSeconds: 5, seed: 3, cueIndex: 2 };
    const first = backgroundIndexAt(args);
    for (let i = 0; i < 5; i++) assert.equal(backgroundIndexAt(args), first);
  });
});

describe('backgroundIdAt', () => {
  const assets = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('resolves the index against the pool', () => {
    assert.equal(backgroundIdAt(assets, { mode: 'cue', cueIndex: 1 }), 'b');
  });

  it('returns an empty id for an empty pool', () => {
    assert.equal(backgroundIdAt([], { mode: 'cue', cueIndex: 0 }), '');
  });
});

describe('rotation menu', () => {
  it('offers the four modes and defaults to following the caption', () => {
    assert.deepEqual(ROTATE_MODES.map((m) => m.id), ['single', 'cue', 'time', 'random']);
    assert.equal(DEFAULT_ROTATE_MODE, 'cue');
  });
});

describe('caption animations', () => {
  it('defaults to none, because an entrance on every cue is exhausting', () => {
    assert.equal(DEFAULT_CAPTION_ANIMATION, 'none');
    assert.equal(normalizeOptions({}).animation, 'none');
    assert.equal(normalizeOptions({}).animationDuration, 0);
  });

  it('offers more than one choice', () => {
    assert.ok(CAPTION_ANIMATIONS.length >= 5);
  });

  it('resolves an unknown id to the default', () => {
    assert.equal(animationOf('nope').id, DEFAULT_CAPTION_ANIMATION);
    assert.equal(normalizeOptions({ animation: 'nope' }).animation, 'none');
  });

  it('carries the duration into the options, since the renderer reads it', () => {
    const options = normalizeOptions({ animation: 'rise' });
    assert.equal(options.animation, 'rise');
    assert.ok(options.animationDuration > 0);
  });

  it('completes instantly when there is no duration', () => {
    assert.equal(animationProgress(0, 1, 0), 1);
    assert.deepEqual(captionTransform('none', 0), { alpha: 1, dx: 0, dy: 0, scale: 1 });
  });

  it('reaches full opacity at the end of every animation', () => {
    for (const { id } of CAPTION_ANIMATIONS) {
      const end = captionTransform(id, 1);
      assert.equal(end.alpha, 1, `${id} did not settle to opaque`);
      // + 0 normalises -0, which assert.equal distinguishes under strict mode.
      assert.equal(end.dx + 0, 0, `${id} did not settle horizontally`);
      assert.equal(end.dy + 0, 0, `${id} did not settle vertically`);
      assert.equal(end.scale, 1, `${id} did not settle at full size`);
    }
  });

  it('starts transparent so the cue does not pop in', () => {
    for (const id of ['fade', 'rise', 'drop', 'zoom', 'slide']) {
      assert.equal(captionTransform(id, 0).alpha, 0, `${id} popped in`);
    }
  });

  it('never scales to zero, which would be an invisible first frame', () => {
    assert.ok(captionTransform('zoom', 0).scale >= 0.8);
  });

  it('eases out rather than linearly', () => {
    // easeOutCubic is past halfway at the midpoint; a linear ramp would be
    // exactly 0.5 there. The difference is what stops the motion reading as
    // mechanical next to the eased background glow.
    assert.ok(animationProgress(0.16, 1, 0.32) > 0.6);
    assert.ok(animationProgress(0.16, 1, 0.32) < 1);
    assert.ok(animationProgress(0.01, 1, 0.32) < 0.2);
  });

  it('clamps the animation to the cue so a short cue still finishes', () => {
    // A 0.2 s cue cannot fit a 0.34 s slide; without the clamp the caption would
    // be half-visible for its entire time on screen.
    assert.equal(animationProgress(0.2, 0.2, 0.34), 1);
  });

  it('does not animate before the cue starts', () => {
    // A negative local elapsed happens when a frame lands a hair before the cue
    // boundary; progress must be 0, not a wrapped-around value.
    assert.equal(animationProgress(-0.5, 1, 0.32), 0);
  });

  it('moves in the direction the name promises', () => {
    assert.ok(captionTransform('rise', 0, 720).dy > 0, '上浮 should start below');
    assert.ok(captionTransform('drop', 0, 720).dy < 0, '下落 should start above');
    assert.ok(captionTransform('slide', 0, 720).dx !== 0, '侧滑 should start offset');
  });

  it('scales its offsets with the frame, so one layout fits every preset', () => {
    const small = captionTransform('rise', 0, 720).dy;
    const large = captionTransform('rise', 0, 1280).dy;
    assert.ok(large > small);
  });
});
