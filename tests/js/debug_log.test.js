import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  MAX_ENTRIES,
  clear,
  command,
  error,
  errorCount,
  formatAll,
  formatEntry,
  record,
  snapshot,
  subscribe,
} from '../../static/js/debug_log.js';

beforeEach(() => clear());

describe('debug log', () => {
  it('records a command with a timestamp and a level', () => {
    command('GET /api/voices');
    const [entry] = snapshot();
    assert.equal(entry.level, 'cmd');
    assert.equal(entry.message, 'GET /api/voices');
    assert.ok(entry.at > 0);
  });

  it('keeps entries in order and copies snapshots', () => {
    command('first');
    error('second');
    const entries = snapshot();
    assert.deepEqual(
      entries.map((entry) => entry.message),
      ['first', 'second']
    );
    entries[0].message = 'mutated';
    assert.equal(snapshot()[0].message, 'first');
  });

  it('counts errors without counting warnings', () => {
    error('one');
    record('warn', 'two');
    assert.equal(errorCount(), 1);
  });

  it('caps the ring buffer at MAX_ENTRIES', () => {
    for (let i = 0; i < MAX_ENTRIES + 3; i += 1) record('info', `line ${i}`);
    const entries = snapshot();
    assert.equal(entries.length, MAX_ENTRIES);
    assert.equal(entries[0].message, 'line 3');
    assert.equal(entries.at(-1).message, `line ${MAX_ENTRIES + 2}`);
  });

  it('notifies subscribers and unsubscribe stops delivery', () => {
    const seen = [];
    const unsubscribe = subscribe((event) => seen.push(event.type));
    command('one');
    unsubscribe();
    command('two');
    assert.deepEqual(seen, ['record']);
  });

  it('formats a command and its detail as one copied block', () => {
    const entry = command('POST /api/voices', { status: 502, request_id: 'req-1' });
    const text = formatEntry(entry);
    assert.match(text, /\[cmd\]/);
    assert.match(text, /POST \/api\/voices/);
    assert.match(text, /request_id/);
    assert.match(text, /502/);
  });

  it('clears entries and notifies listeners', () => {
    command('one');
    const seen = [];
    subscribe((event) => seen.push(event.type));
    clear();
    assert.deepEqual(snapshot(), []);
    assert.deepEqual(seen, ['clear']);
  });

  it('formats all entries as copyable text', () => {
    command('one');
    error('two', { detail: 'x' });
    const text = formatAll();
    assert.match(text, /one/);
    assert.match(text, /two/);
    assert.match(text, /detail/);
  });

  it('survives a circular detail object when formatting', () => {
    const circular = {};
    circular.self = circular;
    const entry = record('info', 'circular', circular);
    assert.doesNotThrow(() => formatEntry(entry));
  });
});
