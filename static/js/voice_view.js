// Searching, ordering and naming for the cloned-voice list.
//
// The enrolment API returns ids like `cosyvoice-v3-flash-10201530-8f3a2b1c`
// and nothing else that a person can recognise. Once there are more than three
// of them the tab stops being a list and becomes a wall of hex, so everything
// that makes one row distinguishable from another lives here: a searchable
// key, a stable order, and a name for the voices nobody has named yet.
//
// Pure functions over plain rows -- no DOM, no storage. `tab_voice.js` resolves
// each entry into a row ({ name, tags, createdMs, ... }) and hands it over, so
// `node --test` covers the ordering and the numbering without a browser.

/** Longest name and note accepted, matching the inputs' maxlength. */
export const MAX_NAME = 40;
export const MAX_NOTE = 200;

/** The order the 排序 dropdown offers, in the order it offers them. */
export const SORT_MODES = [
  { id: 'created-desc', label: '最近创建' },
  { id: 'created-asc', label: '最早创建' },
  { id: 'name', label: '按名称' },
  { id: 'model', label: '按模型' },
];

export const DEFAULT_SORT = 'created-desc';

/**
 * Names generated for unnamed voices are `新音色 N`.
 *
 * Numbering rather than reusing the id keeps the list readable, and a stable
 * number beats a shortened id: `新音色 3` is something an operator can say out
 * loud, `cosyvoice-v3-fla…` is not.
 */
const AUTO_NAME = /^新音色\s*(\d+)$/;

/** Next free `新音色 N`, given every name already spoken for. */
export function autoName(used = []) {
  let highest = 0;
  for (const raw of used) {
    const match = AUTO_NAME.exec(String(raw ?? '').trim());
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `新音色 ${highest + 1}`;
}

/**
 * Epoch milliseconds for a DashScope timestamp, or 0 when there is none.
 *
 * `gmt_create` arrives as `2026-10-14 13:38:02` -- a space, no timezone, no
 * `T`. `new Date()` accepts that in V8 but not in every browser, and a voice
 * that dates to 1970 would sort to the bottom of every list, so the two shapes
 * are parsed explicitly rather than left to the engine.
 */
export function createdMsOf(entry) {
  if (!entry) return 0;
  if (typeof entry.createdMs === 'number') return entry.createdMs;

  for (const raw of [entry.gmt_create, entry.gmtCreate, entry.created_at]) {
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw === 'number') return raw > 1e12 ? raw : raw * 1000;

    const text = String(raw).trim();
    // An explicit zone has to win over the local-time branch below, or an ISO
    // string is silently shifted by the operator's offset.
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) {
      const zoned = Date.parse(text);
      if (!Number.isNaN(zoned)) return zoned;
    }

    const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
    if (local) {
      const [, y, mo, d, h, mi, s] = local;
      // Local time on purpose: the server formats in Beijing time and the
      // operator reads the same clock.
      return new Date(+y, +mo - 1, +d, +h, +mi, +(s || 0)).getTime();
    }
    const parsed = Date.parse(text);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

/**
 * The identity of a row.
 *
 * `voice_id` is spelled two ways depending on which upstream page it came from,
 * and the stored metadata records (`voice-meta` in IndexedDB) are keyed by a
 * plain `id`, so all three are accepted here rather than at every call site.
 */
export function idOf(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return entry;
  return entry.voice_id || entry.voiceId || entry.id || '';
}

/** Everything one row can be found by, lowercased. */
export function searchKeyOf(row) {
  return [row.name, idOf(row), row.target_model, row.note, ...(row.tags || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Does this row match a search box's contents?
 *
 * Every whitespace-separated term has to match, so `龙 复刻` narrows rather than
 * widens -- the way a search box is expected to behave once someone starts
 * typing two words.
 */
export function matchesQuery(row, query) {
  const terms = String(query || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return true;
  const key = searchKeyOf(row);
  return terms.every((term) => key.includes(term));
}

/** Locale-aware name order that keeps `新音色 2` before `新音色 10`. */
const byName = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

/**
 * Sort a copy of `rows`.
 *
 * `created-desc` is the default because the voice someone just cloned is the
 * one they are looking for; `model` groups the voices that can actually be
 * used together, since a voice only synthesises under the model it was
 * enrolled against.
 */
export function sortRows(rows, mode = DEFAULT_SORT) {
  const out = [...rows];
  if (mode === 'name') {
    out.sort((a, b) => byName.compare(a.name || '', b.name || ''));
  } else if (mode === 'model') {
    out.sort(
      (a, b) =>
        byName.compare(a.target_model || '', b.target_model || '') ||
        createdMsOf(b) - createdMsOf(a)
    );
  } else if (mode === 'created-asc') {
    out.sort((a, b) => createdMsOf(a) - createdMsOf(b));
  } else {
    out.sort((a, b) => createdMsOf(b) - createdMsOf(a));
  }
  return out;
}

/**
 * The rows the list should paint: tag filter, then search, then order.
 *
 * Tag filtering happens first because it is the coarse axis -- it comes from a
 * dropdown of everything in use, while the search box is free text.
 */
export function visibleRows(rows, { query = '', sort = DEFAULT_SORT, tag = '' } = {}) {
  const tagged = tag ? rows.filter((row) => (row.tags || []).includes(tag)) : rows;
  return sortRows(
    tagged.filter((row) => matchesQuery(row, query)),
    sort
  );
}

/**
 * Give every unnamed row a name, oldest first, and report what was assigned.
 *
 * Oldest first so the numbers line up with the default order and do not shuffle
 * when a new voice is cloned. `used` is mutated so two rows cannot be handed
 * the same number; the caller persists each assignment, which is what keeps the
 * numbering stable across reloads instead of re-deriving it from scratch.
 */
export function autoNameRows(rows, used = []) {
  const taken = new Set(used.map((name) => String(name ?? '').trim()).filter(Boolean));
  const assigned = [];
  const unnamed = rows
    .filter((row) => !String(row.name || '').trim())
    .sort((a, b) => createdMsOf(a) - createdMsOf(b));

  for (const row of unnamed) {
    const name = autoName(taken);
    taken.add(name);
    row.name = name;
    assigned.push({ id: idOf(row), name });
  }
  return assigned;
}

/**
 * The file written by 导出名称.
 *
 * Versioned because this is the only copy of the names that survives clearing
 * site data -- an import that silently misread an older shape would lose them
 * for good.
 */
export function serializeNames(records) {
  const data = {};
  for (const record of records || []) {
    const id = idOf(record);
    if (!id) continue;
    const alias = String(record.alias ?? '').trim();
    const tags = (record.tags || []).map((t) => String(t).trim()).filter(Boolean);
    const note = String(record.note ?? '').trim();
    if (!alias && !tags.length && !note) continue;
    data[id] = { alias, tags, note };
  }
  return JSON.stringify(
    { version: 1, exportedAt: new Date().toISOString(), voices: data },
    null,
    2
  );
}

/**
 * Read an exported file back.
 *
 * Returns the records to write rather than writing them, so the caller owns
 * persistence and the merge rules are testable. An existing alias wins: the
 * file is a backup, and a re-import must not undo a rename made since.
 */
export function parseNames(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    throw new Error('文件不是有效的 JSON');
  }

  // v1 nests under `voices`; the older flat `{ id: {...} }` shape is still
  // accepted so a file exported before this version is not a dead end.
  const data = parsed && typeof parsed === 'object' && parsed.voices ? parsed.voices : parsed;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('文件格式不正确');
  }

  const records = [];
  for (const [id, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== 'object' || !id.trim()) continue;
    // The backup written before tags existed used `name` for the alias.
    const alias = String(entry.alias ?? entry.name ?? '').trim().slice(0, MAX_NAME);
    const tags = (Array.isArray(entry.tags) ? entry.tags : [])
      .map((t) => String(t).trim())
      .filter(Boolean);
    const note = String(entry.note ?? '').trim().slice(0, MAX_NOTE);
    if (!alias && !tags.length && !note) continue;
    records.push({ id: id.trim(), alias, tags, note });
  }
  return records;
}
