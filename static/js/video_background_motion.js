// Motion for the background image, so a still photo does not read as a freeze.
//
// The caption has its own entrance animation (video_theme.js); this is the other
// half of the same idea. A frame that is only a static photo looks like a video
// that failed to start, which is why the gradient themes always had a drifting
// glow. A photo needs the same treatment, and more of it.
//
// Two rules shaped the design:
//
// 1. **Never show the canvas edge.** Every transform here enlarges before it
//    moves. A pan applied to a `cover`-fitted image slides one edge inward and
//    exposes the gradient underneath; the leftover band is narrow and easy to
//    miss in a preview, but it is unmistakable in an export. The pan is
//    therefore derived from the room the scale itself creates.
// 2. **Pure functions of time.** The preview canvas and the recorded canvas are
//    asked to draw the same instant independently, and `renderVideo` replays
//    frames after a stutter. A cursor would make the two disagree and make a
//    dropped frame skip part of the move, so every value here is derived from
//    `elapsed` alone.

/**
 * Background motions offered in the dialog.
 *
 * `amount` is the fraction of the frame the move covers: 0.06 means the image
 * drifts by 6% of its own width over the course of one cycle. Kept small on
 * purpose -- a photo sliding a third of the screen reads as a slideshow
 * transition, not as a living shot.
 */
export const BACKGROUND_MOTIONS = [
  { id: 'none', label: '静止', amount: 0 },
  // Slow push in across the whole clip. The safest one: no pan direction to get
  // wrong, and it reads as intent rather than as drift.
  { id: 'zoomIn', label: '缓慢推近', amount: 0.1 },
  { id: 'zoomOut', label: '缓慢拉远', amount: 0.1 },
  { id: 'panLeft', label: '向左平移', amount: 0.07 },
  { id: 'panRight', label: '向右平移', amount: 0.07 },
  // A diagonal drift plus a slight push, for scenery and talking-head footage.
  { id: 'drift', label: '斜向漂浮', amount: 0.07 },
  // The only one that loops: in and out over `period` seconds, for a clip long
  // enough that a single one-way move would finish and then sit still.
  { id: 'breathe', label: '呼吸缩放', amount: 0.06, period: 24 },
];

export const DEFAULT_BACKGROUND_MOTION = 'none';

/** Resolve an option id, falling back to the default. */
export function backgroundMotionOf(id) {
  return (
    BACKGROUND_MOTIONS.find((m) => m.id === id) ||
    BACKGROUND_MOTIONS.find((m) => m.id === DEFAULT_BACKGROUND_MOTION)
  );
}

/** How far through one cycle `seconds` is, in [0, 1). */
export function cycleProgress(seconds, period) {
  if (!period || period <= 0) return 0;
  const t = Math.max(0, Number(seconds) || 0);
  return (t % period) / period;
}

/**
 * Eased cycle position in [0, 1].
 *
 * A sawtooth would jump back to the start and be visible as a cut. This is a
 * triangle wave pushed through smoothstep, so the move slows into each reversal
 * instead of bouncing off it.
 */
export function breathe(p) {
  const x = Math.min(1, Math.max(0, Number(p) || 0));
  const triangle = x < 0.5 ? x * 2 : (1 - x) * 2;
  return triangle * triangle * (3 - 2 * triangle);
}

/**
 * Scale and offset for the background at `seconds`.
 *
 * `duration` is the whole clip's length, and it is what makes the one-way moves
 * work: progress runs 0 -> 1 across the entire render, so the image pushes in
 * once and never restarts. A looping period would have to snap back to the start
 * at every wrap, and that snap is a visible cut in the middle of a sentence --
 * the one thing a "slowly drifting photo" must not do.
 *
 * Without a `duration` (a test, or a caller that only knows the instant) the
 * moves degrade to their cyclic form, which still covers the frame.
 *
 * Returns `{ scale, dx, dy }` applied *after* the cover fit:
 *
 * - `scale` multiplies the cover rectangle. Always >= 1, so the image still
 *   covers the frame.
 * - `dx` / `dy` are fractions of the *drawn* (cover x scale) size, and are
 *   bounded by the room the scale leaves over, so the image can never slide
 *   past its own edge.
 *
 * The caller translates by `dx * drawnWidth` and scales by `scale`. Units are
 * relative rather than absolute so the same option looks the same at 720p and
 * 1080p.
 *
 * @param {string} motion  an id from BACKGROUND_MOTIONS
 * @param {number} seconds  time since the render started
 * @param {{duration?: number, seed?: number}} [options]  `duration` is the clip
 *   length; `seed` staggers the phase per background, so two photos in a
 *   rotation do not make exactly the same move at the same moment
 */
export function backgroundTransform(motion, seconds, { duration = 0, seed = 0 } = {}) {
  const spec = backgroundMotionOf(motion);
  if (spec.id === 'none' || !spec.amount) return { scale: 1, dx: 0, dy: 0 };

  const t = Math.max(0, Number(seconds) || 0);
  const amount = spec.amount;
  // A per-background phase offset keeps a rotation from looking mechanical: two
  // images swapped mid-move would otherwise both restart at exactly zero. It is
  // only meaningful for the looping motion; a one-way move starts at zero by
  // definition, or the first frame would not match the still preview.
  const phase = spec.period ? ((Math.abs(seed) % 100) / 100) * spec.period : 0;

  // `breathe` loops on its own period; everything else is a single move across
  // the whole clip, so it uses the clip length as its span. The one-way moves
  // clamp rather than wrap: running out of travel and stopping is the intended
  // end state, while wrapping would snap back to the start mid-sentence.
  const span = spec.period || (Number(duration) || 0);
  let p = 0;
  if (span > 0) {
    p = spec.period ? breathe(((t + phase) % span) / span) : smoothstep(Math.min(1, t / span));
  }

  switch (spec.id) {
    case 'zoomIn':
    case 'breathe':
      return { scale: 1 + amount * p, dx: 0, dy: 0 };
    case 'zoomOut':
      // Starts wide and settles; the reversed progress keeps it a pure function
      // of the same clock.
      return { scale: 1 + amount * (1 - p), dx: 0, dy: 0 };
    case 'panLeft':
      return pan(amount, -1, p);
    case 'panRight':
      return pan(amount, 1, p);
    case 'drift':
      // A little extra zoom than a plain pan needs, plus a diagonal component so
      // it does not read as a straight slide. The vertical factor is under 1
      // because a wide frame crops a photo vertically: the vertical slack is
      // usually several times the horizontal one, and matching the coefficients
      // would make the drift mostly vertical rather than diagonal.
      return {
        scale: 1 + amount * 1.6,
        dx: p * 2 - 1,
        dy: (p * 2 - 1) * -0.35,
      };
    default:
      return { scale: 1, dx: 0, dy: 0 };
  }
}

/** Smoothstep, for the one-way moves: ease out of the start and into the end. */
function smoothstep(x) {
  const t = Math.min(1, Math.max(0, Number(x) || 0));
  return t * t * (3 - 2 * t);
}

/**
 * A horizontal pan that stays inside the frame.
 *
 * `dx` here is a fraction of the *available slack*, not of the image: -1 means
 * "as far left as the zoom allows", +1 the opposite edge. `backgroundSourceRect`
 * multiplies it by the slack it computes, so the image edge lands exactly on the
 * frame edge and can never go past it, whatever the zoom or aspect ratio. `eased`
 * runs 0 -> 1 -> 0, which maps to a full there-and-back pan.
 */
function pan(amount, direction, p) {
  return { scale: 1 + amount, dx: direction * (p * 2 - 1), dy: 0 };
}

/**
 * The source rectangle to blit onto the whole canvas.
 *
 * This is the whole trick, and it is arithmetic rather than a canvas transform
 * on purpose. Composing `translate`/`scale`/`translate` by hand makes the pan
 * offset come out multiplied by the scale (later calls apply first), which is
 * both easy to get wrong and hard to assert on. Here the answer is a rectangle
 * in image space, so "does this show the canvas edge?" becomes "is `sx >= 0`
 * and `sx + sw <= imageWidth`", which a test can check directly.
 *
 * The region is derived from the `cover` fit: at zoom 1 it is exactly what
 * `coverRect` would have cropped to, so the still case and the moving case agree
 * on the framing. Zooming in shrinks the region (less source, more enlargement),
 * and the pan slides it within the bounds the zoom leaves over.
 *
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @param {number} width   canvas width
 * @param {number} height  canvas height
 * @param {{scale?: number, dx?: number, dy?: number}} [move]  from
 *   `backgroundTransform`; `dx`/`dy` are fractions of the region
 * @returns {{sx: number, sy: number, sw: number, sh: number}}
 */
export function backgroundSourceRect(imageWidth, imageHeight, width, height, move = {}) {
  if (!imageWidth || !imageHeight || !width || !height) {
    return { sx: 0, sy: 0, sw: imageWidth || 0, sh: imageHeight || 0 };
  }
  // How much the image is enlarged to cover the frame.
  const cover = Math.max(width / imageWidth, height / imageHeight);
  const scale = Math.min(1e6, Math.max(1, Number(move.scale) || 1));
  // Zooming keeps the same aspect, so both dimensions shrink together and the
  // result still covers -- that is what makes the clamp below a no-op normally.
  const sw = Math.min(imageWidth, width / (cover * scale));
  const sh = Math.min(imageHeight, height / (cover * scale));

  // Room to pan: the region can move by half its slack on either side.
  const slackX = (imageWidth - sw) / 2;
  const slackY = (imageHeight - sh) / 2;
  const dx = clampUnit(move.dx) * slackX;
  const dy = clampUnit(move.dy) * slackY;

  const sx = clamp(imageWidth / 2 + dx - sw / 2, 0, imageWidth - sw);
  const sy = clamp(imageHeight / 2 + dy - sh / 2, 0, imageHeight - sh);
  return { sx, sy, sw, sh };
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/** Offsets are fractions of the region and cannot exceed its own slack. */
function clampUnit(value) {
  const n = Number(value) || 0;
  return Math.min(1, Math.max(-1, n));
}
