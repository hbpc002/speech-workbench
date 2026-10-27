// The local voice names, shared across tabs.
//
// A renamed voice should be recognisable everywhere, not only on the tab it was
// renamed on. The voice-management tab owns the metadata store, but the TTS tab
// owns the catalogue dropdown the operator actually picks from, so the aliases
// live in a module both can import without touching app.js or each other.
//
// Kept free of DOM at import time for the same reason the other small modules
// are: app.js is importable under `node --test` only because it does not touch
// `document` until `boot()` is called, and this module must be importable by it.

/** voice_id -> alias. Only voices the operator has named, so it stays small. */
const aliases = new Map();

/**
 * Replace the whole map. Called once when the voice metadata first loads, since
 * the store may already hold aliases the operator set on a previous visit.
 */
export function hydrateVoiceAliases(rows = []) {
  aliases.clear();
  for (const row of rows) {
    const alias = String(row?.alias ?? '').trim();
    if (alias) aliases.set(row.id, alias);
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('voice-aliases-changed'));
  }
}

/** The operator's name for a voice, or '' when it has none. */
export function aliasOf(voiceId) {
  return aliases.get(voiceId) || '';
}

/**
 * Label a voice for a picker or a history card.
 *
 * The alias wins over the catalogue name because the catalogue calls every
 * clone `cosyvoice-v3-flash-10201530-8f3a2b1c`, which is precisely what the
 * operator is naming over.
 */
export function displayNameOf(voiceId, catalogueName = '') {
  return aliasOf(voiceId) || catalogueName || voiceId || '';
}

/**
 * Set one alias and announce the change.
 *
 * The tab that owns the store calls this instead of mutating a private Map, so
 * a rename shows up in the TTS dropdown without the two tabs knowing about each
 * other. Empty alias is how a rename is undone.
 */
export function rememberAlias(voiceId, alias) {
  const trimmed = String(alias ?? '').trim();
  if (trimmed) aliases.set(voiceId, trimmed);
  else aliases.delete(voiceId);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('voice-aliases-changed', { detail: { voiceId } }));
  }
}