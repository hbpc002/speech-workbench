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
    sentences: [],
    sampleRate: 0,
  });
});

test('finished samples travel with the event', () => {
  const events = [];
  globalThis.window = { dispatchEvent: (event) => events.push(event) };
  try {
    requestShortVideo({
      text: '你好',
      sentences: [
        { text: '你好，', pcm: new Int16Array([1, 2, 3]) },
        { text: '世界。', pcm: null },
      ],
      sampleRate: 22050,
    });
  } finally {
    delete globalThis.window;
  }
  assert.equal(events[0].detail.sampleRate, 22050);
  assert.equal(events[0].detail.sentences.length, 1);
  assert.equal(events[0].detail.sentences[0].text, '你好，');
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
