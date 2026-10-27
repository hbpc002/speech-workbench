// Visual options for the video renderer.
//
// Kept as data plus pure resolvers, no DOM and no canvas: the same object has to
// reach the preview canvas and the recorded one, and the only way to guarantee
// preview == export is for both to read one normalised value. A theme that
// exists as a stylesheet here and a hard-coded color there drifts apart.
//
// The palette/layout split follows Pixelle-Video's HTML templates
// (`templates/<size>/*.html`): a template is a background treatment plus a type
// treatment, not a pile of per-pixel settings. The caption safety margins come
// from aegra-video-agent's `_srt_to_ass`: text inside 90% of the width and clear
// of the frame edges, because burned-in captions clipped by the encoder are
// unrecoverable.

import {
  BACKGROUND_MOTIONS,
  DEFAULT_BACKGROUND_MOTION,
  backgroundMotionOf,
} from './video_background_motion.js';

/** Every theme: a background pair, a type color pair, and an accent. */
export const THEMES = [
  {
    id: 'midnight',
    label: '深夜蓝',
    bgTop: '#171a23',
    bgBottom: '#0f1117',
    text: '#e6e8ee',
    muted: '#8b93a7',
    accent: '#6c8cff',
    // Caption plate opacity. Zero means outline-only, which is what the light
    // themes need: a dark plate over a near-white background reads as a box.
    plate: 0.45,
  },
  {
    id: 'paper',
    label: '米白纸感',
    bgTop: '#f7f4ec',
    bgBottom: '#e6dfd0',
    text: '#241f18',
    muted: '#7c7264',
    accent: '#b4552d',
    plate: 0,
  },
  {
    id: 'forest',
    label: '墨绿',
    bgTop: '#1a2721',
    bgBottom: '#0c1410',
    text: '#e8efe9',
    muted: '#8ba394',
    accent: '#4ade80',
    plate: 0.42,
  },
  {
    id: 'sunset',
    label: '暖橘',
    bgTop: '#2e1a20',
    bgBottom: '#150c10',
    text: '#fdeae4',
    muted: '#bda0a2',
    accent: '#fb7185',
    plate: 0.45,
  },
  {
    id: 'ink',
    label: '纯黑白',
    bgTop: '#000000',
    bgBottom: '#0d0d0d',
    text: '#ffffff',
    muted: '#9a9a9a',
    accent: '#ffffff',
    plate: 0,
  },
  {
    id: 'ocean',
    label: '海雾',
    bgTop: '#12212e',
    bgBottom: '#0a1219',
    text: '#e2eef7',
    muted: '#879db0',
    accent: '#38bdf8',
    plate: 0.45,
  },
];

export const DEFAULT_THEME = 'midnight';

/** Where the caption block sits vertically. */
export const CAPTION_POSITIONS = [
  { id: 'bottom', label: '底部' },
  { id: 'center', label: '居中' },
  { id: 'top', label: '顶部' },
];

export const DEFAULT_POSITION = 'bottom';

/**
 * Caption emphasis, mirroring openmontage's `highlight_style`.
 *
 * `karaoke` needs per-token timings, which `buildCues` derives from character
 * share -- the synthesis API returns sentence-level audio and no word clock, so
 * a real karaoke track is not available and proportional timing is the honest
 * approximation.
 */
export const CAPTION_STYLES = [
  { id: 'plain', label: '整句' },
  { id: 'karaoke', label: '逐字高亮' },
  { id: 'word_by_word', label: '逐词显示' },
];

export const DEFAULT_CAPTION_STYLE = 'plain';

/**
 * How a caption enters the frame.
 *
 * All of these are transform-only: alpha, offset and scale on text that has
 * already been positioned and wrapped. Doing it any other way (re-laying out
 * per frame, per-character transforms) would make the caption width jump during
 * the animation, which is exactly what the eye notices.
 *
 * `none` is the default because an entrance animation on every one of sixty
 * cues in a three-minute video is exhausting; it is a choice, not the baseline.
 */
export const CAPTION_ANIMATIONS = [
  { id: 'none', label: '无', duration: 0 },
  { id: 'fade', label: '淡入', duration: 0.28 },
  { id: 'rise', label: '上浮', duration: 0.32 },
  { id: 'drop', label: '下落', duration: 0.32 },
  { id: 'zoom', label: '放大', duration: 0.3 },
  { id: 'slide', label: '侧滑', duration: 0.34 },
];

export const DEFAULT_CAPTION_ANIMATION = 'none';

// Re-exported so callers that already import the caption options from here get
// the background ones from the same place, rather than reaching for a second
// module for a neighbouring control.
export { BACKGROUND_MOTIONS, DEFAULT_BACKGROUND_MOTION, backgroundMotionOf };

/** Resolve an animation id, falling back to the default. */
export function animationOf(id) {
  return (
    CAPTION_ANIMATIONS.find((a) => a.id === id) ||
    CAPTION_ANIMATIONS.find((a) => a.id === DEFAULT_CAPTION_ANIMATION)
  );
}

/**
 * Progress of the entrance animation at `elapsed` into a cue, in [0, 1].
 *
 * Cues can be shorter than the animation, so the duration is clamped to the
 * cue's own length: a 0.2 s cue with a 0.34 s slide would otherwise never finish
 * entering before it is replaced.
 */
export function animationProgress(elapsedInCue, cueDuration, duration) {
  if (!duration || duration <= 0) return 1;
  const span = Math.min(duration, Math.max(0.1, Number(cueDuration) || duration));
  const t = Math.max(0, Number(elapsedInCue) || 0);
  // easeOutCubic: fast in, settling at rest. A linear entrance reads as
  // mechanical next to the eased drift of the background glow.
  const x = Math.min(1, t / span);
  return 1 - Math.pow(1 - x, 3);
}

/**
 * Transform for a caption at entrance progress `p`.
 *
 * Returns `{ alpha, dx, dy, scale }`; the renderer applies them around the
 * caption's own centre so the block never shifts its baseline.
 */
export function captionTransform(animation, p, short = 720) {
  const t = Math.min(1, Math.max(0, Number(p) || 0));
  const away = 1 - t;
  switch (animation) {
    case 'fade':
      return { alpha: t, dx: 0, dy: 0, scale: 1 };
    case 'rise':
      return { alpha: t, dx: 0, dy: short * 0.06 * away, scale: 1 };
    case 'drop':
      return { alpha: t, dx: 0, dy: -short * 0.06 * away, scale: 1 };
    case 'zoom':
      // Never start from zero: scaling text up from nothing makes the first
      // frames unreadable, and 0.82 is the step at which it still reads.
      return { alpha: t, dx: 0, dy: 0, scale: 0.82 + 0.18 * t };
    case 'slide':
      return { alpha: t, dx: short * 0.12 * away, dy: 0, scale: 1 };
    default:
      return { alpha: 1, dx: 0, dy: 0, scale: 1 };
  }
}

/** Size steps, as a multiplier on the caption's base font size. */
export const SIZE_STEPS = [
  { id: 'small', label: '小', scale: 0.82 },
  { id: 'normal', label: '标准', scale: 1 },
  { id: 'large', label: '大', scale: 1.22 },
];

export const DEFAULT_SIZE = 'normal';

/** Resolve a theme id, falling back to the default. */
export function themeOf(id) {
  return THEMES.find((theme) => theme.id === id) || THEMES.find((t) => t.id === DEFAULT_THEME);
}

/** Resolve a size step id, falling back to the default. */
export function sizeOf(id) {
  return SIZE_STEPS.find((step) => step.id === id) || SIZE_STEPS.find((s) => s.id === DEFAULT_SIZE);
}

/** Accept only a known id, so a stale persisted value cannot break a render. */
function pickId(list, id, fallback) {
  return list.some((item) => item.id === id) ? id : fallback;
}

/**
 * One normalised options object for preview and export.
 *
 * Every field is resolved to something `paintFrame` understands, because a
 * partially filled object from a stale `<select>` is the shape of bug that
 * renders a preview nobody asked for.
 */
export function normalizeOptions(raw = {}) {
  const theme = themeOf(raw.theme);
  const size = sizeOf(raw.size);
  return {
    theme: theme.id,
    palette: theme,
    position: pickId(CAPTION_POSITIONS, raw.position, DEFAULT_POSITION),
    style: pickId(CAPTION_STYLES, raw.style, DEFAULT_CAPTION_STYLE),
    size: size.id,
    sizeScale: size.scale,
    title: String(raw.title || '').trim().slice(0, 60),
    // A drifting accent glow keeps a long still frame from looking like a
    // frozen video. With a background image or video it matters even more: the
    // glow is what stops a single photo from reading as a still.
    motion: raw.motion !== false,
    progressBar: raw.progressBar !== false,
    // How far to darken a background image/video so captions stay readable on
    // it. A photo is the one input whose brightness the theme cannot know, so
    // the scrim is a value the operator can raise rather than a fixed guess.
    scrim: Number.isFinite(raw.scrim) ? Math.max(0, Math.min(0.85, raw.scrim)) : 0.35,
    animation: pickId(CAPTION_ANIMATIONS, raw.animation, DEFAULT_CAPTION_ANIMATION),
    animationDuration: animationOf(raw.animation).duration,
    // Motion for the background image itself. Separate from `motion`, which is
    // the glow drifting behind the caption: that one is tied to the theme and
    // works on a gradient, this one only applies when a photo or video is
    // behind the text.
    backgroundMotion: backgroundMotionOf(raw.backgroundMotion).id,
  };
}

/**
 * Vertical anchor for the caption block, in [0, 1] of frame height.
 *
 * Read off the progress bar rather than the frame edge so the caption never
 * collides with it, which is the same reason the ASS writer keeps its bottom
 * margin at 7% instead of 0.
 */
export function captionAnchorY(position) {
  if (position === 'top') return 0.2;
  if (position === 'center') return 0.5;
  return 0.84;
}
