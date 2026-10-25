// Picking which background to draw on a given frame.
//
// A single background is the simple case and stays simple: `selection` holds at
// most one asset per kind and `backgroundAt` always returns it.
//
// The multi-select case is where the arithmetic lives. Given several images or
// videos and a rotation mode, the frame at time `t` shows exactly one of them.
// That decision has to be a pure function of `t` for the same reason the caption
// timeline is: the preview canvas and the recorded canvas are asked to draw the
// same instant independently, and any hidden mutable cursor would make them
// disagree. `renderVideo` also replays frames on a stutter, so "advance to the
// next one" would skip a background on every dropped frame.
//
// Videos are treated like stills here rather than played in parallel: loading
// four <video> decoders to show one is wasteful on a phone, and the rotation
// only needs the frame each element currently shows.

/** How the chosen backgrounds take turns. */
export const ROTATE_MODES = [
  { id: 'single', label: '只用选中的第一个' },
  { id: 'cue', label: '每句字幕换一张' },
  { id: 'time', label: '按时间轮换' },
  { id: 'random', label: '随机切换' },
];

export const DEFAULT_ROTATE_MODE = 'cue';

/** Seconds each background is held in `time` and `random` mode. */
export const ROTATE_SECONDS_STEPS = [
  { id: '3', label: '3 秒' },
  { id: '5', label: '5 秒' },
  { id: '8', label: '8 秒' },
  { id: '12', label: '12 秒' },
];

export const DEFAULT_ROTATE_SECONDS = '5';

/**
 * Index of the background to draw at `seconds`, or -1 for "none chosen".
 *
 * `count` is how many background assets are selected. Every mode is a pure
 * function of (count, seconds, cue index, seed) so re-drawing the same instant
 * always yields the same picture.
 *
 * `cueIndex` drives `cue` mode with the caption index rather than a separate
 * timer: the point of that mode is that the picture changes when the sentence
 * does, so it must key off the same value the caption uses.
 */
export function backgroundIndexAt({
  count,
  mode = DEFAULT_ROTATE_MODE,
  seconds = 0,
  cueIndex = -1,
  holdSeconds = 5,
  seed = 1,
} = {}) {
  if (!count || count < 1) return -1;
  if (mode === 'single' || count === 1) return 0;
  if (mode === 'cue') {
    // Before the first cue there is no sentence on screen; use the first
    // background rather than showing nothing on the opening frames.
    return cueIndex < 0 ? 0 : cueIndex % count;
  }
  const hold = Math.max(0.5, Number(holdSeconds) || 5);
  const slot = Math.floor(Math.max(0, seconds) / hold);
  if (mode === 'time') return slot % count;
  if (mode === 'random') return randomIndex(slot, count, seed);
  return 0;
}

/**
 * A slot-stable pseudo-random index.
 *
 * Deterministic on purpose: `Math.random()` here would make the preview and the
 * export disagree, and would even make two renderings of the same record differ.
 * A cheap integer hash gives a sequence that looks random to the eye while
 * staying reproducible from the seed the dialog persists.
 */
export function randomIndex(slot, count, seed = 1) {
  if (!count || count < 1) return -1;
  // xorshift-style mix; the constants are the usual 32-bit scramble.
  let x = (slot + 1) * 0x9e3779b1 + (seed | 0) * 0x85ebca6b;
  x ^= x >>> 15;
  x = Math.imul(x, 0x2c1b3c6d);
  x ^= x >>> 12;
  x = Math.imul(x, 0x297a2d39);
  x ^= x >>> 15;
  return Math.abs(x) % count;
}

/** Id of the background to draw, resolving the index against `assets`. */
export function backgroundIdAt(assets, options) {
  const index = backgroundIndexAt({ ...options, count: (assets || []).length });
  return index < 0 ? '' : assets[index]?.id || '';
}
