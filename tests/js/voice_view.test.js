// Searching, ordering and naming for the clone list.
//
// All of this is pure so the cases that are easy to get silently wrong -- the
// `2026-10-14 13:38:02` timestamp, the numbering gap after a delete, the
// backup merge -- are asserted here rather than by clicking around a browser.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_NAME,
  autoName,
  autoNameRows,
  createdMsOf,
  matchesQuery,
  parseNames,
  serializeNames,
  sortRows,
  visibleRows,
} from '../../static/js/voice_view.js';

const row = (patch) => ({
  voice_id: 'cosyvoice-v3-flash-a-1',
  name: '',
  target_model: 'cosyvoice-v3-flash',
  tags: [],
  note: '',
  gmt_create: '2026-10-14 13:38:02',
  ...patch,
});

describe('autoName', () => {
  it('starts at 1', () => {
    assert.equal(autoName([]), '新音色 1');
  });

  it('continues past the highest number in use', () => {
    assert.equal(autoName(['新音色 1', '新音色 7']), '新音色 8');
  });

  it('does not wrap around a gap left by a delete', () => {
    // Reusing a freed number would silently point two conversations at the
    // same name, and the operator has no way to tell which is which.
    assert.equal(autoName(['新音色 1', '新音色 3']), '新音色 4');
  });

  it('ignores names it did not generate', () => {
    assert.equal(autoName(['客户 A', '龙安洋']), '新音色 1');
  });

  it('tolerates spacing inside a generated name', () => {
    assert.equal(autoName(['新音色   5']), '新音色 6');
  });
});

describe('createdMsOf', () => {
  it('parses the space-separated DashScope timestamp', () => {
    // `new Date('2026-10-14 13:38:02')` parses as local time in V8 but is not
    // portable; a 1970 date here would sort every voice to the bottom.
    assert.equal(createdMsOf({ gmt_create: '2026-10-14 13:38:02' }), new Date(2026, 9, 14, 13, 38, 2).getTime());
  });

  it('accepts seconds being absent', () => {
    assert.equal(createdMsOf({ gmt_create: '2026-10-14 13:38' }), new Date(2026, 9, 14, 13, 38, 0).getTime());
  });

  it('accepts an ISO timestamp', () => {
    const iso = '2026-10-14T05:38:02.000Z';
    assert.equal(createdMsOf({ gmt_create: iso }), Date.parse(iso));
  });

  it('accepts epoch seconds', () => {
    assert.equal(createdMsOf({ created_at: 1791000000 }), 1791000000000);
  });

  it('accepts epoch milliseconds without scaling them again', () => {
    assert.equal(createdMsOf({ created_at: 1791000000000 }), 1791000000000);
  });

  it('returns 0 when there is no timestamp at all', () => {
    assert.equal(createdMsOf({}), 0);
    assert.equal(createdMsOf(null), 0);
  });

  it('prefers an already-resolved value', () => {
    assert.equal(createdMsOf({ createdMs: 1234, gmt_create: '2026-10-14 13:38:02' }), 1234);
  });
});

describe('matchesQuery', () => {
  it('matches an empty query', () => {
    assert.equal(matchesQuery(row(), ''), true);
    assert.equal(matchesQuery(row(), '   '), true);
  });

  it('matches a name regardless of case', () => {
    assert.equal(matchesQuery(row({ name: '客服 A' }), '客服'), true);
    assert.equal(matchesQuery(row({ name: 'VIP Voice' }), 'vip'), true);
  });

  it('matches the voice id, which is what is on screen when there is no name', () => {
    assert.equal(matchesQuery(row(), 'flash-a-1'), true);
  });

  it('matches the model', () => {
    assert.equal(matchesQuery(row(), 'cosyvoice'), true);
  });

  it('matches a tag and a note', () => {
    assert.equal(matchesQuery(row({ tags: ['广告'] }), '广告'), true);
    assert.equal(matchesQuery(row({ note: '六月活动' }), '六月'), true);
  });

  it('requires every term, so two words narrow the list', () => {
    const target = row({ name: '客服 A', tags: ['广告'] });
    assert.equal(matchesQuery(target, '客服 广告'), true);
    assert.equal(matchesQuery(target, '客服 新闻'), false);
  });

  it('rejects a row that matches none of it', () => {
    assert.equal(matchesQuery(row(), 'zzz'), false);
  });
});

describe('sortRows', () => {
  const older = row({ voice_id: 'v-old', name: '旧', gmt_create: '2026-10-01 09:00:00' });
  const newer = row({ voice_id: 'v-new', name: '新', gmt_create: '2026-10-20 09:00:00' });
  const middle = row({ voice_id: 'v-mid', name: '中', gmt_create: '2026-10-10 09:00:00' });

  it('defaults to newest first', () => {
    assert.deepEqual(
      sortRows([older, newer, middle]).map((r) => r.voice_id),
      ['v-new', 'v-mid', 'v-old']
    );
  });

  it('reverses for oldest first', () => {
    assert.deepEqual(
      sortRows([older, newer, middle], 'created-asc').map((r) => r.voice_id),
      ['v-old', 'v-mid', 'v-new']
    );
  });

  it('sorts by name with numbers read as numbers', () => {
    // A plain string sort puts 新音色 10 before 新音色 2, which is exactly the
    // list an operator scans by number.
    const rows = [
      row({ voice_id: 'c', name: '新音色 10' }),
      row({ voice_id: 'a', name: '新音色 2' }),
      row({ voice_id: 'b', name: '新音色 1' }),
    ];
    assert.deepEqual(
      sortRows(rows, 'name').map((r) => r.voice_id),
      ['b', 'a', 'c']
    );
  });

  it('groups by model, newest first inside a group', () => {
    const rows = [
      row({ voice_id: 'q-old', target_model: 'qwen-audio-3.0-tts-flash', gmt_create: '2026-10-01 09:00:00' }),
      row({ voice_id: 'c-new', target_model: 'cosyvoice-v3-flash', gmt_create: '2026-10-20 09:00:00' }),
      row({ voice_id: 'q-new', target_model: 'qwen-audio-3.0-tts-flash', gmt_create: '2026-10-10 09:00:00' }),
    ];
    assert.deepEqual(
      sortRows(rows, 'model').map((r) => r.voice_id),
      ['c-new', 'q-new', 'q-old']
    );
  });

  it('does not mutate the caller list', () => {
    const rows = [older, newer];
    sortRows(rows, 'name');
    assert.deepEqual(rows.map((r) => r.voice_id), ['v-old', 'v-new']);
  });

  it('treats a missing timestamp as oldest', () => {
    const undated = row({ voice_id: 'v-none', name: '无日期', gmt_create: '' });
    assert.deepEqual(
      sortRows([undated, newer]).map((r) => r.voice_id),
      ['v-new', 'v-none']
    );
  });
});

describe('visibleRows', () => {
  const rows = [
    row({ voice_id: 'v1', name: '客服用', tags: ['客服'], gmt_create: '2026-10-01 09:00:00' }),
    row({ voice_id: 'v2', name: '广告用', tags: ['广告'], gmt_create: '2026-10-20 09:00:00' }),
    row({ voice_id: 'v3', name: '客服备用', tags: ['客服'], gmt_create: '2026-10-10 09:00:00' }),
  ];

  it('applies the tag filter', () => {
    assert.deepEqual(
      visibleRows(rows, { tag: '客服' }).map((r) => r.voice_id),
      ['v3', 'v1']
    );
  });

  it('applies the search on top of the tag filter', () => {
    assert.deepEqual(
      visibleRows(rows, { tag: '客服', query: '备用' }).map((r) => r.voice_id),
      ['v3']
    );
  });

  it('returns nothing when the two disagree', () => {
    assert.deepEqual(visibleRows(rows, { tag: '广告', query: '客服' }), []);
  });

  it('orders what it returns', () => {
    assert.deepEqual(
      visibleRows(rows, { sort: 'name' }).map((r) => r.voice_id),
      ['v2', 'v3', 'v1']
    );
  });

  it('passes everything through with no criteria', () => {
    assert.equal(visibleRows(rows).length, 3);
  });
});

describe('autoNameRows', () => {
  it('names the unnamed oldest first and reports what it did', () => {
    const rows = [
      row({ voice_id: 'v-new', gmt_create: '2026-10-20 09:00:00' }),
      row({ voice_id: 'v-old', gmt_create: '2026-10-01 09:00:00' }),
    ];
    const assigned = autoNameRows(rows);
    // Oldest gets 1, so the numbering follows the list and does not shuffle
    // when another voice is cloned next week.
    assert.deepEqual(assigned, [
      { id: 'v-old', name: '新音色 1' },
      { id: 'v-new', name: '新音色 2' },
    ]);
    assert.equal(rows.find((r) => r.voice_id === 'v-old').name, '新音色 1');
  });

  it('leaves an existing name alone', () => {
    const rows = [row({ voice_id: 'v1', name: '客服' })];
    assert.deepEqual(autoNameRows(rows), []);
    assert.equal(rows[0].name, '客服');
  });

  it('continues numbering after the names already stored', () => {
    // The stored names are what survive a reload; re-deriving the count from
    // the list alone would restart at 1 and collide with them.
    const rows = [row({ voice_id: 'v1' })];
    assert.deepEqual(autoNameRows(rows, ['新音色 1', '新音色 2']), [
      { id: 'v1', name: '新音色 3' },
    ]);
  });

  it('does not reuse a number within one batch', () => {
    const rows = [row({ voice_id: 'v1' }), row({ voice_id: 'v2' })];
    const names = autoNameRows(rows).map((entry) => entry.name);
    assert.deepEqual(names, ['新音色 1', '新音色 2']);
  });

  it('treats a whitespace-only name as unnamed', () => {
    const rows = [row({ voice_id: 'v1', name: '   ' })];
    assert.equal(autoNameRows(rows)[0].name, '新音色 1');
  });
});

describe('the name backup file', () => {
  const records = [
    { id: 'v1', alias: '客服用', tags: ['客服'], note: '六月' },
    { id: 'v2', alias: '', tags: [], note: '' },
  ];

  it('round-trips aliases, tags and notes', () => {
    const parsed = parseNames(serializeNames(records));
    assert.deepEqual(parsed, [{ id: 'v1', alias: '客服用', tags: ['客服'], note: '六月' }]);
  });

  it('leaves out voices with nothing to remember', () => {
    // v2 has no metadata at all; writing an empty entry would make the file
    // look like it carried something and would import as a no-op.
    const parsed = parseNames(serializeNames(records));
    assert.equal(parsed.length, 1);
  });

  it('stamps a version, so a future shape is not misread as this one', () => {
    assert.equal(JSON.parse(serializeNames(records)).version, 1);
  });

  it('reads the older flat shape, where the alias was called name', () => {
    const legacy = JSON.stringify({ v9: { name: '老名字' } });
    assert.deepEqual(parseNames(legacy), [{ id: 'v9', alias: '老名字', tags: [], note: '' }]);
  });

  it('rejects a file that is not JSON', () => {
    assert.throws(() => parseNames('not json'), /不是有效的 JSON/);
  });

  it('rejects JSON that is not an object', () => {
    assert.throws(() => parseNames('[1, 2]'), /格式不正确/);
    assert.throws(() => parseNames('null'), /格式不正确/);
  });

  it('skips entries that are not objects', () => {
    const parsed = parseNames(JSON.stringify({ v1: 'nope', v2: { alias: '好的' } }));
    assert.deepEqual(parsed.map((r) => r.id), ['v2']);
  });

  it('caps an over-long alias instead of dropping the record', () => {
    const long = 'x'.repeat(MAX_NAME + 20);
    const parsed = parseNames(JSON.stringify({ v1: { alias: long } }));
    assert.equal(parsed[0].alias.length, MAX_NAME);
  });

  it('drops blank tags', () => {
    const parsed = parseNames(JSON.stringify({ v1: { tags: ['客服', '  ', ''] } }));
    assert.deepEqual(parsed[0].tags, ['客服']);
  });
});
