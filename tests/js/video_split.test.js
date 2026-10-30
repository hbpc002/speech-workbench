// Scene splitting for the short-video tab.
//
// The server splits too (that is the AI path), but 按句拆分 is local on purpose:
// it works with no model, no network and no cost. The merge rule is the part
// worth pinning down -- one sentence per scene makes captions flash, too many
// sentences per scene makes a single stock clip run for 20 seconds.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pcmToWavBlob, splitLocal, textToTerms } from '../../static/js/video_split.js';

test('splits on Chinese sentence punctuation', () => {
  assert.deepEqual(splitLocal('第一句。第二句！第三句？'), ['第一句。第二句！第三句？']);
});

test('merges short sentences into one scene', () => {
  const parts = splitLocal('你好。今天天气不错。我们出去走走吧。');
  assert.equal(parts.length, 1);
  assert.equal(parts[0], '你好。今天天气不错。我们出去走走吧。');
});

test('starts a new scene past 60 characters', () => {
  const long = '一'.repeat(61) + '。';
  const parts = splitLocal(long + '下一句。');
  assert.equal(parts.length, 2);
  assert.equal(parts[0].length, 62);
});

test('keeps blank lines as scene breaks', () => {
  const parts = splitLocal('第一段\n第二段\n');
  assert.deepEqual(parts, ['第一段第二段']);
});

test('drops empty input', () => {
  assert.deepEqual(splitLocal('   '), []);
});

test('parses search terms with Chinese and English punctuation', () => {
  assert.deepEqual(textToTerms('city night, coffee pouring，rain'), [
    'city night',
    'coffee pouring',
    'rain',
  ]);
});

test('caps search terms at four', () => {
  assert.equal(textToTerms('a,b,c,d,e').length, 4);
});

test('pcmToWavBlob writes a 44-byte header and PCM payload', async () => {
  const blob = pcmToWavBlob([new Int16Array([1, -2, 3])], 16000);
  assert.equal(blob.type, 'audio/wav');
  assert.equal(blob.size, 44 + 6);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const text = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  assert.equal(text(0, 4), 'RIFF');
  assert.equal(text(8, 12), 'WAVE');
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(40, true), 6);
  assert.equal(view.getInt16(44, true), 1);
  assert.equal(view.getInt16(46, true), -2);
});
