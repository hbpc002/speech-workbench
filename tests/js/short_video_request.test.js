// The event bridge between a synthesis record and the short-video tab.
//
// It must not import anything that touches document at module scope: both the
// synthesis tab and this test load it directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SHORT_VIDEO_EVENT, requestShortVideo } from '../../static/js/short_video_request.js';

test('dispatching carries text, model and voice', () => {
  const events = [];
  globalThis.window = { dispatchEvent: (event) => events.push(event) };
  try {
    assert.equal(
      requestShortVideo({ text: '  你好  ', model: 'cosyvoice-v2', voice: 'longanhuan' }),
      true
    );
  } finally {
    delete globalThis.window;
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].type, SHORT_VIDEO_EVENT);
  assert.deepEqual(events[0].detail, {
    text: '你好',
    model: 'cosyvoice-v2',
    voice: 'longanhuan',
  });
});

test('blank text is refused before dispatching', () => {
  let called = false;
  globalThis.window = { dispatchEvent: () => (called = true) };
  try {
    assert.equal(requestShortVideo({ text: '   ' }), false);
  } finally {
    delete globalThis.window;
  }
  assert.equal(called, false);
});
