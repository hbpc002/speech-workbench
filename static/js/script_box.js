// The script textarea's undo and clear behaviour, shared by both tabs.
//
// The synthesis tab and the clone-generation tab each have a 文本框 with 清空文本
// and 撤销 beside it, and the two have to behave identically: a cloned voice is
// just another voice, so the preview scripts get AI-tagged and stripped the same
// way, and a user who learns 撤销 on one tab expects it on the other.
//
// A stack rather than a single slot -- otherwise "tag it, then clear it" can
// only be walked back one step, which is the case undo exists for.
//
// Every writer fires `input`, because both tabs keep their 去标签 button's
// disabled state in sync from that event. A silent `value = ...` leaves the
// button offering to strip tags that are no longer there -- which is also how
// clicking a 情感 chip used to leave 去标签 greyed out with a tag in the text.
//
// The DOM is injected so this stays unit-testable under `node --test`; the tabs
// themselves cannot be imported there because app.js touches `document` at module
// scope.

import { insertAtCaret } from './tag_input.js';

/** A 2000-char script x 20 is still trivial to hold. */
export const UNDO_LIMIT = 20;

export function createScriptBox({ textarea, undoButton, limit = UNDO_LIMIT }) {
  if (!textarea) throw new Error('createScriptBox needs a textarea');
  const stack = [];

  function syncButton() {
    if (undoButton) undoButton.disabled = stack.length === 0;
  }

  /** Snapshot the current text so 撤销 can walk back over the next change. */
  function push(text) {
    stack.push(text);
    if (stack.length > limit) stack.shift();
    syncButton();
  }

  function setText(text) {
    textarea.value = text;
    textarea.dispatchEvent(new Event('input'));
  }

  function undo() {
    if (!stack.length) return;
    setText(stack.pop());
    syncButton();
  }

  /** Clearing an already empty box pushes nothing, so 撤销 cannot undo nothing. */
  function clear() {
    if (!textarea.value) return;
    push(textarea.value);
    setText('');
    textarea.focus();
  }

  /**
   * Drop a 情感/拟声 chip into the text at the caret, undoably.
   *
   * One click is one step: the point of a chip is that you place them one at a
   * time, and placing five in a row is five decisions you may want to walk back
   * one at a time.
   */
  function insertTag(tag) {
    push(textarea.value);
    insertAtCaret(textarea, tag);
    textarea.dispatchEvent(new Event('input'));
  }

  // The markup ships 撤销 disabled, but a box over an already-restored stack
  // must not leave the button enabled, so the state is decided here rather than
  // inherited from the HTML.
  syncButton();
  return {
    push,
    setText,
    undo,
    clear,
    insertTag,
    canUndo: () => stack.length > 0,
    depth: () => stack.length,
    syncButton,
  };
}