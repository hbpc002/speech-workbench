import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { voicePrefixFor } = await import('../../static/js/voice_prefix.js');

describe('voicePrefixFor', () => {
  it('formats local time as MMDDHHmm with zero padding', () => {
    const now = new Date(2026, 9, 20, 15, 7, 42);
    assert.equal(voicePrefixFor(now), '10201507');
  });

  it('stays inside the upstream nine-character limit', () => {
    const prefix = voicePrefixFor(new Date(2026, 11, 31, 23, 59, 59));
    assert.equal(prefix, '12312359');
    assert.match(prefix, /^[a-z0-9]{1,9}$/);
  });
});
