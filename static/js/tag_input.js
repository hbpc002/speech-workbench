// Emotion / onomatopoeia tag chips.
//
// Shared by the synthesis tab and the voice-clone preview: both synthesise
// with a voice and both want the operator to drop `[sad]` into the script by
// clicking rather than by remembering the exact spelling.
//
// Only the qwen TTS models understand these. On cosyvoice they are read aloud
// as literal text, so the caller must hide the panel rather than let a stray
// tag reach the model -- see server/voices.py TAG_MODELS.
//
// Pure functions over plain objects, with the textarea handled as an injected
// value, so this is unit-testable under `node --test`.

import { hasAnyTag, stripKnownTags } from './tag_rules.js';

/** Chip descriptors for one row of the panel. */
export function tagChips(config, { rich = false } = {}) {
  const source = rich ? config.rich_tags : config.control_tags;
  return (source || []).map((item) => ({
    tag: item.tag,
    name: item.name,
    cls: rich ? 'rich' : '',
  }));
}

/** Every tag the config knows about, longest-first. */
export function allKnownTags(config) {
  const control = (config.control_tags || []).map((t) => t.tag);
  const rich = (config.rich_tags || []).map((t) => t.tag);
  // Longest-first so `[very happy]` is stripped before `[very]`, if such a
  // pair ever exists.
  return [...control, ...rich].sort((a, b) => b.length - a.length);
}

/** Remove recognised tags; other bracket text is left alone. */
export function stripTags(text, config) {
  return stripKnownTags(text, allKnownTags(config));
}

export function hasTags(text, config) {
  return hasAnyTag(text, allKnownTags(config));
}

/** The last tag in the text, which is the one currently in effect. */
export function lastControlTag(text, config) {
  const tags = (config.control_tags || []).map((t) => t.tag);
  let found = '';
  let position = -1;
  for (const tag of tags) {
    const at = text.lastIndexOf(tag);
    if (at > position) {
      position = at;
      found = tag;
    }
  }
  return found;
}

/**
 * Insert text at the caret, leaving the caret after what was inserted.
 *
 * Mutates the textarea in place because that is what the browser's selection
 * model expects; a caller wanting the old value for undo must snapshot it
 * first, as tab_tts.js does.
 */
export function insertAtCaret(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
  const caret = start + text.length;
  textarea.focus();
  textarea.setSelectionRange(caret, caret);
  return caret;
}

/**
 * Paint one row of chips. `create` is injected so this stays testable.
 *
 * Chips are `<button type="button">` rather than `<div onclick>` so they never
 * submit a surrounding form.
 */
export function renderChips(node, chips, { onPick, create }) {
  node.innerHTML = '';
  for (const chip of chips) {
    const button = create('button');
    button.type = 'button';
    button.className = `tag-chip ${chip.cls || ''}`.trim();
    button.textContent = chip.name;
    button.title = chip.tag;
    button.addEventListener('click', () => onPick(chip.tag));
    node.appendChild(button);
  }
}