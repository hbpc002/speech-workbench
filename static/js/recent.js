// Remembering which voice was picked last.
//
// The synthesis catalogue ships 253 voices in twelve scene groups, and the clone
// tab gains another entry every time a sample is enrolled. Scrolling a dropdown
// back to the same entry is the most repeated annoyance in this UI, so every
// voice picker grows a short 最近使用 group at the top.
//
// The entries are clones of the options the catalogue already rendered rather
// than strings built here: the label carries the capability suffix
// (`龙安洋 · 阳光大男孩　〔情感 场景〕`), and duplicating that formatting in a
// second place is how the two copies drift apart.
//
// Pure functions over an injected storage object, so `node --test` covers the
// ordering, the cap and the unavailable-storage fallback without a browser.

/** How many voices each picker remembers. */
export const RECENT_LIMIT = 5;

export const RECENT_GROUP_LABEL = '最近使用';

/** Marks the injected group so a second apply() replaces it instead of stacking. */
const GROUP_FLAG = 'recentVoices';
const GROUP_SELECTOR = 'optgroup[data-recent-voices]';

export const TTS_VOICE_KEY = 'recent.ttsVoice';
export const CLONE_VOICE_KEY = 'recent.cloneVoice';

/**
 * The browser's localStorage, or null where it is not available.
 *
 * Accessing the property itself can throw in a sandboxed iframe, so this is a
 * try/catch around the read and not just around the getItem below.
 */
export function localStore() {
  try {
    return globalThis.localStorage || null;
  } catch (_) {
    return null;
  }
}

function readIds(storage, key) {
  try {
    const raw = storage && storage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // A hand-edited or half-written value must not break the picker.
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string' && v) : [];
  } catch (_) {
    return [];
  }
}

function writeIds(storage, key, ids) {
  try {
    if (storage) storage.setItem(key, JSON.stringify(ids));
  } catch (_) {
    // Private mode or a full quota. The picker still works; it just forgets.
  }
  return ids;
}

/** Most recently picked first, de-duplicated, capped. Returns the new list. */
export function rememberVoice(storage, key, id, limit = RECENT_LIMIT) {
  if (!id) return readIds(storage, key);
  const kept = readIds(storage, key).filter((value) => value !== id);
  return writeIds(storage, key, [id, ...kept].slice(0, limit));
}

export function loadRecent(storage, key) {
  return readIds(storage, key);
}

/** The remembered voices this picker can actually offer, in order. */
export function selectableRecent(select, ids) {
  if (!select || !ids || !ids.length) return [];
  const options = [...select.options];
  const usable = [];
  for (const id of ids) {
    const option = options.find((o) => o.value === id);
    // A voice belonging to another model has no entry here, and a cloned voice
    // that was deleted is simply gone: an option pointing at nothing would only
    // fail later, at synthesis time, with a far worse message.
    if (option) usable.push(option);
  }
  return usable;
}

function removeRecent(select) {
  const existing = select.querySelector(GROUP_SELECTOR);
  if (existing) existing.remove();
}

/**
 * Put a 最近使用 group at the top of a voice `<select>`.
 *
 * `create` is injected for the same reason actionButton takes one: this module
 * must import cleanly under `node --test`.
 *
 * Returns how many entries landed in the group, so callers can tell an empty
 * dropdown from one whose remembered voices were all filtered out.
 */
export function applyRecent(select, ids, { create = defaultCreate } = {}) {
  if (!select) return 0;
  removeRecent(select);
  const usable = selectableRecent(select, ids);
  if (!usable.length) return 0;

  const group = create('optgroup');
  group.label = RECENT_GROUP_LABEL;
  group.dataset[GROUP_FLAG] = '';
  for (const option of usable) group.appendChild(option.cloneNode(true));
  select.insertBefore(group, select.firstChild);
  return usable.length;
}

/**
 * Record every change to a picker.
 *
 * Attaching once is enough: every caller rebuilds the `<select>`'s children in
 * place (innerHTML or optgroups) rather than replacing the element, so the
 * listener survives.
 */
export function trackSelection(select, { storage, key, limit = RECENT_LIMIT }) {
  if (!select) return;
  select.addEventListener('change', () => {
    rememberVoice(storage, key, select.value, limit);
  });
}

function defaultCreate(tag) {
  if (typeof document === 'undefined') {
    throw new Error('applyRecent needs a document; pass one via options.create');
  }
  return document.createElement(tag);
}