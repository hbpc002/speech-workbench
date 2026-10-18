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
    selectionStart: value.length,
    selectionEnd: value.length,
    focused: false,
    inputs: 0,
    focus() {
      this.focused = true;
    },
    setSelectionRange(a, b) {
      this.selectionStart = a;
      this.selectionEnd = b;
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

describe('script box: tag chips', () => {
  it('drops the tag in at the caret and leaves it there', () => {
    const { textarea, box } = setup('今天带大家去看露营装备。');
    textarea.selectionStart = 4;
    textarea.selectionEnd = 4;
    box.insertTag('[sad]');
    assert.equal(textarea.value, '今天带大[sad]家去看露营装备。');
    // Caret after what was inserted, so the next chip lands next to this one.
    assert.equal(textarea.selectionStart, 4 + '[sad]'.length);
    assert.equal(textarea.selectionEnd, textarea.selectionStart);
    assert.equal(textarea.focused, true);
  });

  it('is undoable', () => {
    // One chip, one step: the point of a chip is placing them one at a time.
    const { textarea, box } = setup('原稿。');
    box.insertTag('[excited]');
    assert.equal(box.depth(), 1);
    box.undo();
    assert.equal(textarea.value, '原稿。');
    assert.equal(box.depth(), 0);
  });

  it('walks back one chip at a time', () => {
    // The caret starts at the end, so the chips queue up there -- and that is
    // the point: two clicks are two decisions, not one batch.
    const { textarea, box } = setup('原稿。');
    box.insertTag('[excited]');
    box.insertTag('[whispers]');
    assert.equal(textarea.value, '原稿。[excited][whispers]');
    box.undo();
    assert.equal(textarea.value, '原稿。[excited]');
    box.undo();
    assert.equal(textarea.value, '原稿。');
  });

  it('announces the write, so 去标签 turns clickable', () => {
    // The bug this closes: a chip used to set .value directly, so the button
    // stayed greyed out with a tag sitting in the text.
    const { textarea, box } = setup('原稿。');
    textarea.inputs = 0;
    box.insertTag('[sad]');
    assert.equal(textarea.inputs, 1);
    assert.equal(box.depth(), 1, 'and it must be on the undo stack');
  });

  it('replaces the current selection', () => {
    const { textarea, box } = setup('请删掉这句话。');
    textarea.selectionStart = 0;
    textarea.selectionEnd = 6;
    box.insertTag('[serious]');
    assert.equal(textarea.value, '[serious]。');
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