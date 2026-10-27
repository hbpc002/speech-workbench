// PCM assembly for the video renderer.
//
// `joinPcm` is where the renderer intersects the real record format, and it is
// the second place the "base64 only" assumption lived: it called `atob` on
// every chunk, so an Int16Array record threw `InvalidCharacterError` and the
// dialog reported 录制失败 only after it had finally opened.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { joinPcm } from '../../static/js/video_render.js';

/** Base64 for little-endian int16 samples, the shape an older record used. */
function base64Of(samples) {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
  return buffer.toString('base64');
}

describe('joinPcm', () => {
  it('concatenates Int16Array chunks in reading order', () => {
    const out = joinPcm([new Int16Array([1, 2]), new Int16Array([3])]);
    assert.deepEqual(Array.from(out), [1, 2, 3]);
  });

  it('still accepts base64 chunks', () => {
    const out = joinPcm([base64Of([7, 8]), base64Of([9])]);
    assert.deepEqual(Array.from(out), [7, 8, 9]);
  });

  it('mixes both shapes, which is what a record migrated between versions holds', () => {
    const out = joinPcm([new Int16Array([1]), base64Of([2, 3])]);
    assert.deepEqual(Array.from(out), [1, 2, 3]);
  });

  it('keeps samples that are easy to truncate: negative and above 127', () => {
    const out = joinPcm([new Int16Array([-1, -32768, 32767, 256])]);
    assert.deepEqual(Array.from(out), [-1, -32768, 32767, 256]);
  });

  it('drops empty chunks instead of failing on them', () => {
    assert.equal(joinPcm([new Int16Array([1]), null, undefined, new Int16Array([])]).length, 1);
    assert.equal(joinPcm([]).length, 0);
    assert.equal(joinPcm(null).length, 0);
  });
});
