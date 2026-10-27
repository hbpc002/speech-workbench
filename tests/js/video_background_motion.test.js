// What the background motion does to a still photo.
//
// Two properties matter and both are cheap to state, which is why they are
// asserted rather than eyeballed:
//
// 1. The image always covers the frame. A pan that exposes the gradient behind
//    the photo is the classic Ken Burns bug -- invisible in a still preview,
//    glaring in the export.
// 2. The same instant always yields the same rectangle. The preview canvas and
//    the recorded canvas draw independently, and `renderVideo` replays frames
//    after a stutter; a cursor would make the two disagree.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BACKGROUND_MOTIONS,
  DEFAULT_BACKGROUND_MOTION,
  backgroundMotionOf,
  backgroundSourceRect,
  backgroundTransform,
  breathe,
  cycleProgress,
} from '../../static/js/video_background_motion.js';

const W = 1280;
const H = 720;

/** Every option id that actually moves. */
const MOVING = BACKGROUND_MOTIONS.filter((m) => m.id !== 'none');

/** A spread of awkward source shapes: landscape, portrait, square, extremes. */
const SOURCES = [
  [1920, 1080],
  [1080, 1920],
  [800, 800],
  [4000, 200],
  [200, 4000],
  [W, H],
];

/** A dense sample of the timeline, including both ends. */
function timeline(duration = 60, steps = 240) {
  return Array.from({ length: steps + 1 }, (_, i) => (i / steps) * duration);
}

describe('background motion', () => {
  it('offers a motion for every id it resolves', () => {
    for (const motion of BACKGROUND_MOTIONS) {
      assert.equal(backgroundMotionOf(motion.id).id, motion.id);
    }
    assert.equal(backgroundMotionOf('nonsense').id, DEFAULT_BACKGROUND_MOTION);
    assert.equal(backgroundMotionOf(undefined).id, DEFAULT_BACKGROUND_MOTION);
  });

  it('never shows the canvas edge, for any motion, source and instant', () => {
    // The whole point of the module. Zoom first, then pan within the leftover.
    for (const motion of MOVING) {
      for (const [iw, ih] of SOURCES) {
        for (const t of timeline()) {
          const move = backgroundTransform(motion.id, t, { duration: 60 });
          const rect = backgroundSourceRect(iw, ih, W, H, move);
          const where = `${motion.id} ${iw}x${ih} @${t.toFixed(1)}s`;

          assert.ok(rect.sx >= -1e-9, `左边露出画布: ${where} sx=${rect.sx}`);
          assert.ok(rect.sy >= -1e-9, `上边露出画布: ${where} sy=${rect.sy}`);
          assert.ok(rect.sx + rect.sw <= iw + 1e-9, `右边露出画布: ${where}`);
          assert.ok(rect.sy + rect.sh <= ih + 1e-9, `下边露出画布: ${where}`);
          // Cover means the source region is never larger than the frame's
          // aspect allows: blitting it to the full canvas must not distort.
          assert.ok(rect.sw > 0 && rect.sh > 0, `空矩形: ${where}`);
        }
      }
    }
  });

  it('keeps the aspect ratio of the source region', () => {
    // A source rect with a different aspect than the canvas would stretch the
    // photo, which is a different bug from showing an edge.
    for (const motion of MOVING) {
      for (const [iw, ih] of SOURCES) {
        const move = backgroundTransform(motion.id, 17, { duration: 60 });
        const rect = backgroundSourceRect(iw, ih, W, H, move);
        assert.ok(
          Math.abs(rect.sw / rect.sh - W / H) < 1e-6,
          `${motion.id} ${iw}x${ih}: ${rect.sw}x${rect.sh} 比例不是 ${W}:${H}`
        );
      }
    }
  });

  it('is a pure function of time', () => {
    for (const motion of MOVING) {
      assert.deepEqual(
        backgroundTransform(motion.id, 12.5, { duration: 60 }),
        backgroundTransform(motion.id, 12.5, { duration: 60 })
      );
    }
  });

  it('does nothing when the motion is none', () => {
    const move = backgroundTransform('none', 30, { duration: 60 });
    assert.deepEqual(move, { scale: 1, dx: 0, dy: 0 });
    // At rest the source rect is exactly the cover crop: a same-aspect source
    // is used whole, and a wider one is cropped to the frame's aspect.
    const same = backgroundSourceRect(1920, 1080, W, H, move);
    assert.deepEqual(same, { sx: 0, sy: 0, sw: 1920, sh: 1080 });

    const wide = backgroundSourceRect(3840, 1080, W, H, move);
    assert.equal(wide.sh, 1080, '同比例裁剪应吃掉高度');
    assert.equal(wide.sw, 1920, '宽度按画布比例收缩');
    assert.equal(wide.sx, (3840 - 1920) / 2, '应居中裁剪');
    assert.equal(wide.sy, 0);
  });

  it('moves over the clip for the one-way motions', () => {
    // A push-in that wraps mid-clip snaps back to the start, which is a visible
    // cut; these must travel once and stop.
    const zoom = [0, 0.25, 0.5, 0.75, 1].map(
      (f) => backgroundTransform('zoomIn', f * 60, { duration: 60 }).scale
    );
    for (let i = 1; i < zoom.length; i++) {
      assert.ok(zoom[i] >= zoom[i - 1] - 1e-9, `推近出现回退: ${zoom.join(', ')}`);
    }
    assert.ok(zoom[0] >= 1 && zoom[0] < 1.001, `起始应无缩放: ${zoom[0]}`);
    assert.ok(zoom.at(-1) > 1.05, `结束时应有明显推近: ${zoom.at(-1)}`);
    // And it stays there rather than restarting.
    assert.equal(
      backgroundTransform('zoomIn', 61, { duration: 60 }).scale,
      backgroundTransform('zoomIn', 60, { duration: 60 }).scale
    );
  });

  it('zooms out from wide to rest', () => {
    const start = backgroundTransform('zoomOut', 0, { duration: 60 }).scale;
    const end = backgroundTransform('zoomOut', 60, { duration: 60 }).scale;
    assert.ok(start > end, `拉远应从大变小: ${start} -> ${end}`);
    assert.ok(Math.abs(end - 1) < 1e-9, `结束应回到原大: ${end}`);
  });

  it('pans across the whole slack and back', () => {
    const left = [-1, 1].map((f) => backgroundTransform('panLeft', f * 60, { duration: 60 }).dx);
    assert.ok(left[0] > 0.99, `起始应在最右: ${left[0]}`);
    assert.ok(left[1] < -0.99, `结束应在最左: ${left[1]}`);
    // Midpoint of a smoothstep-passed 0->1 is 0.5, i.e. centred.
    assert.ok(Math.abs(backgroundTransform('panLeft', 30, { duration: 60 }).dx) < 1e-9);
  });

  it('loops only the breathing motion, and seamlessly', () => {
    const period = backgroundMotionOf('breathe').period;
    assert.ok(period > 0);
    const at = (t) => backgroundTransform('breathe', t, { duration: 60 }).scale;
    assert.ok(Math.abs(at(0) - at(period)) < 1e-9, '一个周期后应回到起点');
    // And it actually moves in between, in both directions.
    const mid = at(period / 2);
    assert.ok(mid > at(0) && mid > at(period * 0.9), `呼吸应有一个峰值: ${mid}`);
  });

  it('survives a zero or negative duration without dividing by zero', () => {
    // renderVideo can be asked to draw before the timeline is known, and a test
    // may pass no duration at all.
    for (const motion of MOVING) {
      const move = backgroundTransform(motion.id, 5, { duration: 0 });
      assert.ok(Number.isFinite(move.scale) && Number.isFinite(move.dx), motion.id);
      assert.ok(move.scale >= 1, `${motion.id} 缩放跌破 1: ${move.scale}`);
      const rect = backgroundSourceRect(1920, 1080, W, H, move);
      assert.ok(rect.sx >= -1e-9 && rect.sw > 0, motion.id);
    }
    assert.deepEqual(backgroundTransform('zoomIn', -3, { duration: 60 }), {
      scale: 1,
      dx: 0,
      dy: 0,
    });
  });

  it('clamps a runaway offset instead of sliding off the image', () => {
    // `backgroundTransform` should never produce |dx| > 1, but the rect has to
    // hold even if it does -- this is the last line of defence for the edge.
    const rect = backgroundSourceRect(1920, 1080, W, H, { scale: 1.1, dx: 9, dy: -9 });
    assert.ok(rect.sx >= 0);
    assert.ok(rect.sx + rect.sw <= 1920 + 1e-9);
    assert.ok(rect.sy >= 0);
    assert.ok(rect.sy + rect.sh <= 1080 + 1e-9);
  });

  it('handles a degenerate image size', () => {
    // drawableOf filters these out, but returning NaN would poison the canvas.
    const rect = backgroundSourceRect(0, 0, W, H, { scale: 1.2 });
    assert.ok(Number.isFinite(rect.sx) && Number.isFinite(rect.sw));
  });

  it('staggers two backgrounds by seed without breaking cover', () => {
    const a = backgroundTransform('breathe', 4, { duration: 60, seed: 0 });
    const b = backgroundTransform('breathe', 4, { duration: 60, seed: 7 });
    assert.notEqual(a.scale, b.scale, '不同 seed 应有相位差');
    assert.ok(a.scale >= 1 && b.scale >= 1);
  });

  it('eases the cycle instead of bouncing off the reversal', () => {
    // breathe() is a triangle wave through smoothstep: value and slope both
    // vanish at the ends, so a long clip does not visibly snap direction.
    assert.equal(breathe(0), 0);
    assert.equal(breathe(1), 0);
    assert.ok(breathe(0.5) > 0.99, `中点应为峰值: ${breathe(0.5)}`);
    assert.ok(breathe(0.01) < 0.01, `起点应缓慢起步: ${breathe(0.01)}`);
  });

  it('wraps cycle progress into a single period', () => {
    assert.equal(cycleProgress(0, 10), 0);
    assert.equal(cycleProgress(5, 10), 0.5);
    assert.equal(cycleProgress(10, 10), 0);
    assert.equal(cycleProgress(12.5, 10), 0.25);
    assert.equal(cycleProgress(9, 0), 0);
    assert.equal(cycleProgress(-4, 10), 0);
  });
});
