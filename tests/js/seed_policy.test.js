// 种子策略的单元测试。
//
// 这些是这个功能里最容易悄悄坏掉的部分：一旦 nextSeed 退回"永远用基线种子"，
// 「重新生成」就会变成一个点了没反应的按钮，而界面上看不出任何异常。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SEED_MAX, nextSeed, randomSeed, resolveSeed } from '../../static/js/seed_policy.js';

describe('randomSeed', () => {
  it('stays inside the range the server clamps to', () => {
    for (let i = 0; i < 500; i++) {
      const seed = randomSeed();
      assert.ok(Number.isInteger(seed), `not an integer: ${seed}`);
      assert.ok(seed >= 0 && seed <= SEED_MAX, `out of range: ${seed}`);
    }
  });

  it('actually varies', () => {
    // A constant seed would silently break every re-generation.
    const seen = new Set(Array.from({ length: 50 }, randomSeed));
    assert.ok(seen.size > 1, 'randomSeed returned a constant');
  });
});

describe('resolveSeed', () => {
  it('keeps an explicit seed', () => {
    assert.equal(resolveSeed('42'), 42);
    assert.equal(resolveSeed('  42  '), 42);
    assert.equal(resolveSeed(42), 42);
  });

  it('picks one when the field is blank', () => {
    // The whole point: 「随机」 must produce a recorded, reproducible value
    // rather than omitting the parameter and hoping for variety.
    const seed = resolveSeed('');
    assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= SEED_MAX);
    assert.notEqual(resolveSeed(''), undefined);
  });

  it('treats null and undefined as blank', () => {
    assert.ok(Number.isInteger(resolveSeed(null)));
    assert.ok(Number.isInteger(resolveSeed(undefined)));
  });

  it('clamps out-of-range values', () => {
    assert.equal(resolveSeed('99999'), SEED_MAX);
    assert.equal(resolveSeed('-5'), 0);
  });

  it('falls back to random for junk', () => {
    for (const junk of ['abc', 'NaN', 'Infinity', '12abc', {}]) {
      const seed = resolveSeed(junk);
      assert.ok(Number.isInteger(seed), `${JSON.stringify(junk)} -> ${seed}`);
    }
  });

  it('truncates decimals', () => {
    assert.equal(resolveSeed('7.9'), 7);
  });
});

describe('nextSeed', () => {
  const record = { params: { seed: 1234 } };

  it('uses the record baseline on the first attempt', () => {
    assert.equal(nextSeed(record, { seed: null }), 1234);
  });

  it('rolls a new seed on every attempt after the first', () => {
    const sentence = { seed: null };
    sentence.seed = nextSeed(record, sentence);
    assert.equal(sentence.seed, 1234);

    for (let i = 0; i < 20; i++) {
      const previous = sentence.seed;
      sentence.seed = nextSeed(record, sentence);
      assert.notEqual(sentence.seed, previous, 're-generation reused the seed');
    }
  });

  it('treats undefined as "not generated yet"', () => {
    // Fresh object literals omit the field entirely.
    assert.equal(nextSeed(record, {}), 1234);
  });

  it('survives an IndexedDB round trip', () => {
    // Structured clone keeps undefined on the way in, but anything that
    // normalises through JSON turns it into null. Both must mean the same.
    const viaUndefined = structuredClone({ seed: undefined });
    const viaNull = JSON.parse(JSON.stringify({ seed: undefined }));
    assert.equal(nextSeed(record, viaUndefined), 1234);
    assert.equal(nextSeed(record, viaNull), 1234);
  });

  it('falls back to a random seed when the record has none', () => {
    // Records saved before this feature have params without a seed.
    const seed = nextSeed({ params: {} }, { seed: null });
    assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= SEED_MAX);
  });

  it('does not mutate its arguments', () => {
    const sentence = { seed: null };
    const seed = nextSeed(record, sentence);
    assert.equal(sentence.seed, null);
    assert.equal(record.params.seed, 1234);
    assert.notEqual(seed, null);
  });

  it('never returns the same value twice in a row by luck alone', () => {
    // Deterministic-ish assertion: over many rolls, collisions must be rare,
    // which is what makes "重新生成" feel different every time.
    const sentence = { seed: null };
    sentence.seed = nextSeed(record, sentence);
    let collisions = 0;
    for (let i = 0; i < 200; i++) {
      const previous = sentence.seed;
      sentence.seed = nextSeed(record, sentence);
      if (sentence.seed === previous) collisions += 1;
    }
    assert.ok(collisions < 5, `too many collisions: ${collisions}/200`);
  });
});