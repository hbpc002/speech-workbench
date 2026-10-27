// Theme and render-option normalisation.
//
// These are the values that reach both the preview canvas and the recorder, so
// a resolver that silently returns undefined is the difference between "the
// theme did not apply" and "the export is a black frame".

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CAPTION_POSITIONS,
  CAPTION_STYLES,
  DEFAULT_CAPTION_STYLE,
  DEFAULT_POSITION,
  DEFAULT_SIZE,
  DEFAULT_THEME,
  SIZE_STEPS,
  THEMES,
  captionAnchorY,
  normalizeOptions,
  sizeOf,
  themeOf,
} from '../../static/js/video_theme.js';

describe('themeOf', () => {
  it('finds a theme by id', () => {
    assert.equal(themeOf('paper').label, '米白纸感');
  });

  it('falls back to the default for an unknown id', () => {
    assert.equal(themeOf('nope').id, DEFAULT_THEME);
    assert.equal(themeOf(undefined).id, DEFAULT_THEME);
    assert.equal(themeOf(null).id, DEFAULT_THEME);
  });

  it('gives every theme the colors the renderer reads', () => {
    // paintFrame dereferences all six; a missing one paints `undefined` and
    // Canvas ignores the assignment rather than throwing.
    for (const theme of THEMES) {
      for (const key of ['bgTop', 'bgBottom', 'text', 'muted', 'accent']) {
        assert.match(theme[key], /^#[0-9a-f]{6}$/i, `${theme.id}.${key}`);
      }
      assert.equal(typeof theme.plate, 'number', `${theme.id}.plate`);
    }
  });

  it('gives the default theme a plate, since its background is dark', () => {
    assert.ok(themeOf(DEFAULT_THEME).plate > 0);
  });

  it('leaves the light theme without a plate, where a dark box would look wrong', () => {
    assert.equal(themeOf('paper').plate, 0);
  });
});

describe('sizeOf', () => {
  it('resolves each step to a scale', () => {
    assert.equal(sizeOf('large').scale, 1.22);
    assert.equal(sizeOf('normal').scale, 1);
  });

  it('falls back to the documented default, not the first item', () => {
    // The first item is 小; reading item 0 here would shrink every caption.
    assert.equal(sizeOf('bogus').id, DEFAULT_SIZE);
  });
});

describe('normalizeOptions', () => {
  it('fills an empty object with usable defaults', () => {
    const options = normalizeOptions();
    assert.equal(options.theme, DEFAULT_THEME);
    assert.equal(options.position, DEFAULT_POSITION);
    assert.equal(options.style, DEFAULT_CAPTION_STYLE);
    assert.equal(options.sizeScale, 1);
    assert.equal(options.palette.id, DEFAULT_THEME);
  });

  it('resolves the palette object, not just the id', () => {
    // The renderer takes `palette.*`; handing it an id string would throw.
    assert.equal(normalizeOptions({ theme: 'forest' }).palette.bgTop, '#1a2721');
  });

  it('rejects stale ids from a persisted control', () => {
    const options = normalizeOptions({ theme: 'gone', position: 'gone', style: 'gone', size: 'gone' });
    assert.equal(options.theme, DEFAULT_THEME);
    assert.equal(options.position, DEFAULT_POSITION);
    assert.equal(options.style, DEFAULT_CAPTION_STYLE);
    assert.equal(options.size, DEFAULT_SIZE);
  });

  it('trims and caps the title', () => {
    assert.equal(normalizeOptions({ title: '  标题  ' }).title, '标题');
    assert.equal(normalizeOptions({ title: '字'.repeat(200) }).title.length, 60);
    assert.equal(normalizeOptions({ title: null }).title, '');
  });

  it('treats an explicit false as off and anything else as on', () => {
    assert.equal(normalizeOptions({ motion: false }).motion, false);
    assert.equal(normalizeOptions({ motion: true }).motion, true);
    assert.equal(normalizeOptions({ progressBar: false }).progressBar, false);
    assert.equal(normalizeOptions({}).motion, true);
    assert.equal(normalizeOptions({}).progressBar, true);
  });
});

describe('captionAnchorY', () => {
  it('orders the three positions top < center < bottom', () => {
    assert.ok(captionAnchorY('top') < captionAnchorY('center'));
    assert.ok(captionAnchorY('center') < captionAnchorY('bottom'));
  });

  it('keeps every anchor inside the frame with room for the progress bar', () => {
    // A caption at 1.0 would be clipped by the encoder; this is the same
    // safety rule the ASS writer applies with its 7% bottom margin.
    for (const position of CAPTION_POSITIONS) {
      const y = captionAnchorY(position.id);
      assert.ok(y > 0.1 && y < 0.9, `${position.id} -> ${y}`);
    }
  });

  it('falls back to the bottom for an unknown position', () => {
    assert.equal(captionAnchorY('nope'), captionAnchorY('bottom'));
  });
});

describe('option lists', () => {
  it('offers the three caption styles the renderer implements', () => {
    assert.deepEqual(CAPTION_STYLES.map((s) => s.id), ['plain', 'karaoke', 'word_by_word']);
  });

  it('offers three caption positions', () => {
    assert.deepEqual(CAPTION_POSITIONS.map((p) => p.id), ['bottom', 'center', 'top']);
  });

  it('offers at least four themes, so the chooser is worth having', () => {
    assert.ok(THEMES.length >= 4);
  });

  it('keeps theme ids unique', () => {
    assert.equal(new Set(THEMES.map((t) => t.id)).size, THEMES.length);
  });

  it('keeps a 1.0 scale among the size steps', () => {
    assert.ok(SIZE_STEPS.some((s) => s.scale === 1));
  });
});
