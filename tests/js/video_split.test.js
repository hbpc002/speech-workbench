// Scene splitting for the short-video tab.
//
// The server splits too (that is the AI path), but 按句拆分 is local on purpose:
// it works with no model, no network and no cost. The merge rule is the part
// worth pinning down -- one sentence per scene makes captions flash, too many
// sentences per scene makes a single stock clip run for 20 seconds.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitLocal, textToTerms } from '../../static/js/video_split.js';

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
