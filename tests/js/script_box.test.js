// The 文本框 undo stack shared by the synthesis tab and the clone preview.
//
// Two tabs now offer 清空文本 and 撤销 over their own textarea, and a user who
// learns the pair on one expects it on the other. What the shared module has to
// get right, and what the tabs cannot check on their own:
//
//   * a stack, not a single slot -- "apply tags, then clear" has to walk back
//     one step at a time, which is the whole reason 撤销 exists
//   * clearing an empty box must push nothing, or 撤销 walks back onto text the
//     user never deleted
//   * every write fires `input`, because both tabs re-evaluate their 去标签
//     button from that event; a silent `value = ...` leaves it offering to strip
//     tags that are gone
//
// The textarea is injected because the tabs cannot be imported here at all:
// app.js touches `document` at module scope.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UNDO_LIMIT, createScriptBox } from '../../static/js/script_box.js';

function fakeTextarea(value = '') {
  return {
    value,
    focused: false,
    inputs: 0,
    focus() {
      this.focused = true;
    },
    dispatchEvent(event) {
      if (event.type === 'input') this.inputs += 1;
    },
  };
}

function fakeButton() {
  return { disabled: false };
}

/** A box over a fresh textarea, returning all three so assertions can reach them. */
function setup(value = '', options = {}) {
  const textarea = fakeTextarea(value);
  const button = fakeButton();
  const box = createScriptBox({ textarea, undoButton: button, ...options });
  return { textarea, button, box };
}

describe('script box: clearing', () => {
  it('empties the textarea and puts the old text on the stack', () => {
    const { textarea, button, box } = setup('这是一段稿子。');
    box.clear();
    assert.equal(textarea.value, '');
    assert.equal(box.depth(), 1);
    assert.equal(button.disabled, false);
  });

  it('returns focus to the box so the user can keep typing', () => {
    const { textarea, box } = setup('abc');
    box.clear();
    assert.equal(textarea.focused, true);
  });

  it('pushes nothing when the box is already empty', () => {
    const { textarea, button, box } = setup('');
    box.clear();
    assert.equal(box.depth(), 0);
    // Otherwise 撤销 would become enabled with nothing to undo.
    assert.equal(button.disabled, true);
  });

  it('fires input so the 去标签 button re-checks itself', () => {
    const { textarea, box } = setup('[sad]abc');
    textarea.inputs = 0;
    box.clear();
    assert.equal(textarea.inputs, 1);
  });
});

describe('script box: undoing', () => {
  it('brings the text back', () => {
    const { textarea, box } = setup('原文');
    box.clear();
    box.undo();
    assert.equal(textarea.value, '原文');
    assert.equal(box.depth(), 0);
  });

  it('walks back one step at a time', () => {
    // Modelled on what the tabs actually do: apply tags (push, then write),
    // twice, and then clear.
    const { textarea, box } = setup('第一版');
    for (const next of ['第二版', '第三版']) {
      box.push(textarea.value);
      textarea.value = next;
    }
    box.clear();

    box.undo();
    assert.equal(textarea.value, '第三版');
    box.undo();
    assert.equal(textarea.value, '第二版');
    box.undo();
    assert.equal(textarea.value, '第一版');
    assert.equal(box.canUndo(), false);
  });

  it('is a no-op on an empty stack', () => {
    const { textarea, box } = setup('原稿');
    box.undo();
    assert.equal(textarea.value, '原稿');
  });

  it('fires input on the way back too', () => {
    const { textarea, box } = setup('原稿');
    box.clear();
    textarea.inputs = 0;
    box.undo();
    assert.equal(textarea.inputs, 1);
  });
});

describe('script box: the button', () => {
  it('is disabled until there is something to undo', () => {
    const { button, box } = setup('原稿');
    assert.equal(button.disabled, true);
    box.push('原稿');
    assert.equal(button.disabled, false);
    box.undo();
    assert.equal(button.disabled, true);
  });

  it('works without a button at all', () => {
    // Nothing to hang a 撤销 control on in some future call site.
    const box = createScriptBox({ textarea: fakeTextarea('abc') });
    assert.doesNotThrow(() => {
      box.push('abc');
      box.undo();
      box.syncButton();
    });
    assert.equal(box.canUndo(), false);
  });
});

describe('script box: the stack depth', () => {
  it('keeps twenty snapshots by default', () => {
    const { textarea, box } = setup('v0');
    for (let i = 1; i <= UNDO_LIMIT + 5; i++) {
      textarea.value = `v${i}`;
      box.push(textarea.value);
    }
    assert.equal(box.depth(), UNDO_LIMIT);
  });

  it('drops the oldest, so undo stops at the earliest state still held', () => {
    const { textarea, box } = setup('v0', { limit: 3 });
    for (const value of ['v1', 'v2', 'v3']) {
      textarea.value = value;
      box.push(value);
    }
    textarea.value = 'v4';
    box.undo();
    assert.equal(textarea.value, 'v3');
  });
});

describe('script box: direct writes', () => {
  it('setText replaces the script and announces it', () => {
    const { textarea, box } = setup('旧稿');
    textarea.inputs = 0;
    box.setText('新稿');
    assert.equal(textarea.value, '新稿');
    assert.equal(textarea.inputs, 1);
    assert.equal(box.depth(), 0, 'setText on its own is not undoable');
  });

  it('demands a textarea', () => {
    assert.throws(() => createScriptBox({}), /textarea/);
  });
});