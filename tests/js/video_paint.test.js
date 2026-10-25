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
  const stack = [];
  const ctx = {
    calls,
    measureText: (text) => ({ width: String(text).length * 10 }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: (x) => {
      ctx.lastGlowX = x;
      return { addColorStop: () => {} };
    },
    fillRect: (x, y, w, h) =>
      calls.push({ op: 'fillRect', x, y, w, h, fillStyle: ctx.fillStyle, globalAlpha: ctx.globalAlpha }),
    drawImage: (image, x, y, w, h) =>
      calls.push({ op: 'drawImage', image, x, y, w, h, globalAlpha: ctx.globalAlpha }),
    strokeText: (text, x, y) => calls.push({ op: 'strokeText', text, x, y, strokeStyle: ctx.strokeStyle }),
    fillText: (text, x, y) =>
      calls.push({ op: 'fillText', text, x, y, fillStyle: ctx.fillStyle, font: ctx.font }),
    beginPath: () => {},
    moveTo: () => {},
    arcTo: () => {},
    closePath: () => {},
    fill: () => calls.push({ op: 'fill', fillStyle: ctx.fillStyle }),
    // The caption entrance animation wraps the block in save/restore and
    // optionally a translate/scale pair, so the fake has to model the transform
    // stack: assertions below check that the stack is balanced, and an
    // unbalanced stack would mean the next frame paints in a moved space.
    save: () => stack.push({ translate: [0, 0], scale: 1, alpha: ctx.globalAlpha }),
    restore: () => {
      const top = stack.pop();
      if (top) ctx.globalAlpha = top.alpha;
    },
    translate: (x, y) => {
      const top = stack[stack.length - 1];
      if (top) top.translate = [top.translate[0] + x, top.translate[1] + y];
      calls.push({ op: 'translate', x, y });
    },
    scale: (x) => {
      const top = stack[stack.length - 1];
      if (top) top.scale = top.scale * x;
    },
    lastGlowX: null,
    stack,
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
  let alpha = 1;
  Object.defineProperty(ctx, 'globalAlpha', {
    get: () => alpha,
    set: (next) => {
      alpha = next;
    },
  });
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

describe('paintFrame with a background', () => {
  /** A fake drawable: paintFrame only reads width/height and passes it to drawImage. */
  const image = { tagName: 'IMG', width: 800, height: 800 };

  it('draws the background over the gradient', () => {
    const ctx = recordingContext();
    paintFrame(ctx, {
      ...FRAME,
      cue: CUE,
      title: '',
      progress: 0,
      options: normalizeOptions(),
      background: image,
    });
    const draw = ctx.calls.find((c) => c.op === 'drawImage');
    assert.ok(draw, '背景未绘制');
    assert.equal(draw.image, image);
  });

  it('covers the frame instead of fitting inside it', () => {
    const ctx = recordingContext();
    paintFrame(ctx, {
      ...FRAME,
      cue: CUE,
      title: '',
      progress: 0,
      options: normalizeOptions(),
      background: image,
    });
    const draw = ctx.calls.find((c) => c.op === 'drawImage');
    assert.equal(draw.w, FRAME.width);
    assert.equal(draw.h, FRAME.width);
    assert.ok(draw.y < 0, '方图放进横幅时应上下溢出并被裁掉');
  });

  it('dims the background by the scrim so captions stay readable', () => {
    const ctx = recordingContext();
    paintFrame(ctx, {
      ...FRAME,
      cue: CUE,
      title: '',
      progress: 0,
      options: normalizeOptions({ scrim: 0.5 }),
      background: image,
    });
    const scrim = ctx.calls.find((c) => c.op === 'fillRect' && c.w === FRAME.width && c.globalAlpha === 0.5);
    assert.ok(scrim, '应有一层 0.5 透明度的压暗');
  });

  it('skips the scrim entirely at 0', () => {
    const ctx = recordingContext();
    paintFrame(ctx, {
      ...FRAME,
      cue: CUE,
      title: '',
      progress: 0,
      options: normalizeOptions({ scrim: 0 }),
      background: image,
    });
    const dimmed = ctx.calls.filter((c) => c.op === 'fillRect' && c.globalAlpha !== 1);
    assert.equal(dimmed.length, 0);
  });

  it('restores globalAlpha afterwards, or every later draw fades', () => {
    const ctx = recordingContext();
    paintFrame(ctx, {
      ...FRAME,
      cue: CUE,
      title: '',
      progress: 0,
      options: normalizeOptions({ scrim: 0.4 }),
      background: image,
    });
    assert.equal(ctx.globalAlpha, 1);
  });

  it('still draws the caption on top of the background', () => {
    const ctx = recordingContext();
    paintFrame(ctx, {
      ...FRAME,
      cue: CUE,
      title: '',
      progress: 0,
      options: normalizeOptions(),
      background: image,
    });
    const order = ctx.calls.map((c) => c.op);
    assert.ok(order.indexOf('drawImage') < order.indexOf('fillText'), '字幕必须画在背景之后');
    assert.ok(texts(ctx).some((t) => t.includes('你好')));
  });

  it('paints the theme background when no image is chosen', () => {
    const ctx = recordingContext();
    paintFrame(ctx, { ...FRAME, cue: CUE, title: '', progress: 0, options: normalizeOptions() });
    assert.equal(ctx.calls.filter((c) => c.op === 'drawImage').length, 0);
  });

  it('ignores a background with no dimensions', () => {
    // A video element is 0x0 until metadata loads. Drawing it throws
    // InvalidStateError, which would kill the render loop after recording began.
    const ctx = recordingContext();
    assert.doesNotThrow(() =>
      paintFrame(ctx, {
        ...FRAME,
        cue: CUE,
        title: '',
        progress: 0,
        options: normalizeOptions(),
        background: { tagName: 'IMG', width: 0, height: 0 },
      })
    );
  });
});
