// Buttons inside a history card's action row.
//
// Extracted from tab_tts.js and tab_voice.js because of one non-obvious rule:
// below 760px the stylesheet sets `font-size: 0` on `.hactions button` and
// paints `attr(data-short)` in its place. A button without `data-short` renders
// as a blank cell -- no error, no warning, just an invisible control on exactly
// the phones where the layout is tightest.
//
// Kept in its own module so it can be unit-tested: tab_tts.js and tab_voice.js
// both import app.js, which touches `document` at module scope and cannot be
// imported under `node --test`.

/** Full label -> short form for narrow screens. */
export const SHORT_LABELS = {
  播放: '播放',
  下载: '下载',
  重新生成: '重生',
  删除: '删除',
  分段: '分段',
  收起分段: '收起',
  生成视频: '视频',
};

/**
 * Resolve the short form, falling back to the label itself.
 *
 * Throwing on a missing entry would be tempting, but a new action is a normal
 * thing to add and an empty button is a much worse failure than a long one --
 * a long label merely wraps.
 */
export function shortLabel(label) {
  return SHORT_LABELS[label] || label;
}

/**
 * Build one action button.
 *
 * `create` is injected rather than reaching for `document` so this stays
 * testable; both tabs pass `document.createElement.bind(document)`.
 */
export function actionButton(label, {
  short,
  className = 'ghost',
  disabled = false,
  title,
  onClick,
  create = defaultCreate,
} = {}) {
  const node = create('button');
  node.className = className;
  node.textContent = label;
  // Always set, even when it equals the label: the stylesheet switches on the
  // attribute's presence at narrow widths.
  node.dataset.short = short || shortLabel(label);
  node.disabled = Boolean(disabled);
  if (title) node.title = title;
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

function defaultCreate(tag) {
  if (typeof document === 'undefined') {
    throw new Error('actionButton needs a document; pass one via options.create');
  }
  return document.createElement(tag);
}