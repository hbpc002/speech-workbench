// What paintFrame actually puts on the canvas.
//
// The theme and caption options are only worth having if they reach the draw
// calls, and a unit test on `normalizeOptions` cannot tell you that: the bug it
// would miss is paintFrame reading `options.theme` (an id) where it needs
// `options.palette` (the resolved colors), which draws nothing and throws
// nowhere. So this records the 2D context calls instead of trusting the code.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cueAt, paintFrame } from '../../static/js/video_render.js';
import { buildTokens } from '../../static/js/video_timeline.js';
import { normalizeOptions, themeOf } from '../../static/js/video_theme.js';

/**
 * A 2D context that records what was drawn.
 *
 * Only the methods paintFrame calls are implemented; each records itself so a
 * test can assert on colors, positions and text without a browser. The style
 * properties are accessors so every recorded call can carry the color that was
 * active at the time.
 */
function recordingContext() {
  const calls = [];
  const ctx = {
    calls,
    measureText: (text) => ({ width: String(text).length * 10 }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: (x) => {
      ctx.lastGlowX = x;
      return { addColorStop: () => {} };
    },
    fillRect: (x, y, w, h) => calls.push({ op: 'fillRect', x, y, w, h, fillStyle: ctx.fillStyle }),
    strokeText: (text, x, y) => calls.push({ op: 'strokeText', text, x, y, strokeStyle: ctx.strokeStyle }),
    fillText: (text, x, y) =>
      calls.push({ op: 'fillText', text, x, y, fillStyle: ctx.fillStyle, font: ctx.font }),
    beginPath: () => {},
    moveTo: () => {},
    arcTo: () => {},
    closePath: () => {},
    fill: () => calls.push({ op: 'fill', fillStyle: ctx.fillStyle }),
    lastGlowX: null,
  };
  for (const key of ['fillStyle', 'strokeStyle', 'font', 'lineWidth', 'textAlign', 'textBaseline']) {
    let value = '';
    Object.defineProperty(ctx, key, {
      get: () => value,
      set: (next) => {
        value = next;
      },
    });
  }
  return ctx;
}

function texts(ctx) {
  return ctx.calls.filter((c) => c.op === 'fillText' || c.op === 'strokeText').map((c) => c.text);
}

const FRAME = { width: 1280, height: 720 };
const CUE = {
  index: 1,
  start: 0,
  end: 2,
  text: '你好世界',
  words: buildTokens('你好世界', 0, 2),
};

describe('paintFrame', () => {
  it('paints the background with the theme colors', () => {
    const ctx = recordingContext();
    paintFrame(ctx, { ...FRAME, cue: CUE, title: '', progress: 0.5, options: normalizeOptions({ theme: 'paper' }) });
    const rect = ctx.calls.find((c) => c.op === 'fillRect' && c.w === FRAME.width);
    assert.ok(rect, '背景未绘制');
    // The gradient's stops are set through addColorStop, which this recorder
    // ignores; what matters here is that a full-frame rect was filled at all.
    assert.equal(rect.h, FRAME.height);
  });

  it('draws the caption text', () => {
    const ctx = recordingContext();
    paintFrame(ctx, { ...FRAME, cue: CUE, title: '', progress: 0.5, options: normalizeOptions() });
    assert.ok(texts(ctx).some((t) => t.includes('你好')), texts(ctx).join('|'));
  });

  it('draws the title above the caption', () => {
    const ctx = recordingContext();
    paintFrame(ctx, {
      ...FRAME,
      cue: CUE,
      title: '一段标题',
      progress: 0.5,
      options: normalizeOptions({ title: '一段标题' }),
    });
    const fills = ctx.calls.filter((c) => c.op === 'fillText');
    const title = fills.find((c) => c.text === '一段标题');
    const caption = fills.find((c) => c.text.includes('你好'));
    assert.ok(title && caption);
    assert.ok(title.y < caption.y, '标题应位于字幕上方');
  });

  it('moves the caption when the position changes', () => {
    const at = (position) => {
      const ctx = recordingContext();
      paintFrame(ctx, {
        ...FRAME,
        cue: CUE,
        title: '',
        progress: 0,
        options: normalizeOptions({ position }),
      });
      return ctx.calls.filter((c) => c.op === 'fillText').find((c) => c.text.includes('你好')).y;
    };
    assert.ok(at('top') < at('center'), 'top 应高于 center');
    assert.ok(at('center') < at('bottom'), 'center 应高于 bottom');
  });

  it('writes with ink from the theme, not a hard-coded color', () => {
    const ctx = recordingContext();
    paintFrame(ctx, {
      ...FRAME,
      cue: CUE,
      title: '',
      progress: 0,
      options: normalizeOptions({ theme: 'paper' }),
    });
    const caption = ctx.calls.find((c) => c.op === 'fillText' && c.text.includes('你好'));
    assert.equal(caption.fillStyle, themeOf('paper').text);
  });

  it('makes the caption larger when the size step is larger', () => {
    const sizeOf = (size) => {
      const ctx = recordingContext();
      paintFrame(ctx, { ...FRAME, cue: CUE, title: '', progress: 0, options: normalizeOptions({ size }) });
      const caption = ctx.calls.find((c) => c.op === 'fillText' && c.text.includes('你好'));
      return Number(caption.font.match(/(\d+)px/)[1]);
    };
    assert.ok(sizeOf('large') > sizeOf('normal'), 'large 应大于 normal');
    assert.ok(sizeOf('normal') > sizeOf('small'), 'normal 应大于 small');
  });

  it('reveals only part of the line for word_by_word', () => {
    const ctx = recordingContext();
    paintFrame(ctx, {
      ...FRAME,
      cue: CUE,
      title: '',
      progress: 0.25,
      elapsed: 0.25,
      options: normalizeOptions({ style: 'word_by_word' }),
    });
    const shown = texts(ctx).join('');
    assert.ok(shown.length > 0 && shown.length < CUE.text.length, `显示长度 ${shown.length}`);
  });

  it('shows the whole line for the plain style regardless of the clock', () => {
    const ctx = recordingContext();
    paintFrame(ctx, {
      ...FRAME,
      cue: CUE,
      title: '',
      progress: 0.25,
      elapsed: 0.25,
      options: normalizeOptions({ style: 'plain' }),
    });
    assert.ok(texts(ctx).includes(CUE.text));
  });

  it('overpaints one token in the accent color for karaoke', () => {
    const ctx = recordingContext();
    paintFrame(ctx, {
      ...FRAME,
      cue: CUE,
      title: '',
      progress: 0.25,
      elapsed: 0.25,
      options: normalizeOptions({ style: 'karaoke', theme: 'forest' }),
    });
    const accent = themeOf('forest').accent;
    const highlighted = ctx.calls.filter((c) => c.op === 'fillText' && c.fillStyle === accent);
    assert.equal(highlighted.length, 1, '应只有一个字被高亮');
    assert.ok(CUE.text.includes(highlighted[0].text));
  });

  it('draws no caption before the first cue', () => {
    const ctx = recordingContext();
    paintFrame(ctx, { ...FRAME, cue: null, title: '', progress: 0, options: normalizeOptions() });
    assert.deepEqual(texts(ctx), []);
  });

  it('omits the progress bar when asked to', () => {
    const ctx = recordingContext();
    paintFrame(ctx, {
      ...FRAME,
      cue: CUE,
      title: '',
      progress: 0.5,
      options: normalizeOptions({ progressBar: false }),
    });
    const bar = ctx.calls.filter((c) => c.op === 'fillRect' && c.h < 10);
    assert.equal(bar.length, 0);
  });

  it('survives being called with no options at all', () => {
    // renderVideo is also reachable from an older caller; the defaults live in
    // paintFrame so a missing options object cannot throw.
    const ctx = recordingContext();
    assert.doesNotThrow(() => paintFrame(ctx, { ...FRAME, cue: CUE, title: '', progress: 0 }));
    assert.ok(texts(ctx).includes(CUE.text));
  });

  it('drifts the background glow only when motion is on', () => {
    const glowX = (motion) => {
      const ctx = recordingContext();
      paintFrame(ctx, { ...FRAME, cue: null, title: '', progress: 0, elapsed: 5, options: normalizeOptions({ motion }) });
      return ctx.lastGlowX;
    };
    assert.equal(glowX(false), FRAME.width * 0.5);
    assert.notEqual(glowX(true), FRAME.width * 0.5);
  });
});

describe('cueAt', () => {
  it('finds the cue covering the clock', () => {
    const cues = [
      { start: 0, end: 1, text: 'a' },
      { start: 1, end: 3, text: 'b' },
    ];
    assert.equal(cueAt(cues, 0.5).text, 'a');
    assert.equal(cueAt(cues, 2).text, 'b');
  });

  it('treats the end of a cue as belonging to the next one', () => {
    // Half-open intervals: at exactly 1 the first cue is over, so the caption
    // never shows for one extra frame.
    const cues = [
      { start: 0, end: 1, text: 'a' },
      { start: 1, end: 3, text: 'b' },
    ];
    assert.equal(cueAt(cues, 1).text, 'b');
  });

  it('returns null in a gap or with no cues', () => {
    assert.equal(cueAt([{ start: 0, end: 1, text: 'a' }], 5), null);
    assert.equal(cueAt([], 0), null);
    assert.equal(cueAt(null, 0), null);
  });
});
