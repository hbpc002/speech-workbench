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
    // A drifting accent glow is the only motion available on a gradient field;
    // it keeps a long still frame from looking like a frozen video.
    motion: raw.motion !== false,
    progressBar: raw.progressBar !== false,
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
