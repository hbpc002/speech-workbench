// Tag chips shared by the synthesis tab and the voice-clone preview.
//
// The failure this guards: a tag reaching a model that does not understand it
// is read aloud literally, and `[very fast]` vs `[very]` is stripped in the
// wrong order unless the list is sorted longest-first.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  allKnownTags,
  hasTags,
  insertAtCaret,
  lastControlTag,
  renderChips,
  stripTags,
  tagChips,
} from '../../static/js/tag_input.js';

const CONFIG = {
  control_tags: [
    { tag: '[sad]', name: '悲伤' },
    { tag: '[excited]', name: '兴奋' },
    { tag: '[very]', name: '很' },
  ],
  rich_tags: [{ tag: '[giggles]', name: '轻笑' }],
};

/** Minimal textarea stand-in with a selection. */
function fakeTextarea(value, start = value.length, end = start) {
  return {
    value,
    selectionStart: start,
    selectionEnd: end,
    focused: false,
    focus() {
      this.focused = true;
    },
    setSelectionRange(a, b) {
      this.selectionStart = a;
      this.selectionEnd = b;
    },
  };
}

const fakeCreate = (tag) => ({
  tagName: tag,
  className: '',
  textContent: '',
  title: '',
  dataset: {},
  listeners: {},
  innerHTML: '',
  addEventListener(type, handler) {
    this.listeners[type] = handler;
  },
  appendChild(child) {
    this.children = this.children || [];
    this.children.push(child);
  },
});

describe('tagChips', () => {
  it('returns the control tags by default', () => {
    const chips = tagChips(CONFIG);
    assert.equal(chips.length, 3);
    assert.equal(chips[0].name, '悲伤');
    assert.equal(chips[0].cls, '');
  });

  it('returns the rich tags when asked, marked as such', () => {
    const chips = tagChips(CONFIG, { rich: true });
    assert.deepEqual(chips, [{ tag: '[giggles]', name: '轻笑', cls: 'rich' }]);
  });

  it('tolerates a config with no tags', () => {
    assert.deepEqual(tagChips({}, { rich: true }), []);
  });
});

describe('allKnownTags', () => {
  it('includes both kinds', () => {
    const tags = allKnownTags(CONFIG);
    assert.ok(tags.includes('[sad]'));
    assert.ok(tags.includes('[giggles]'));
  });

  it('is sorted longest first', () => {
    // [excited] must be tried before [very] would ever be tried; more to the
    // point, ordering is what makes strip behave when one tag contains another.
    const tags = allKnownTags(CONFIG);
    for (let i = 1; i < tags.length; i++) {
      assert.ok(tags[i - 1].length >= tags[i].length, 'not sorted by descending length');
    }
  });
});

describe('stripTags', () => {
  it('removes known tags', () => {
    assert.equal(stripTags('今天[sad]很难过。', CONFIG), '今天很难过。');
  });

  it('leaves other brackets alone', () => {
    // A markdown link or a unit must not be eaten.
    assert.equal(stripTags('见 [1] 文档', CONFIG), '见 [1] 文档');
  });

  it('is a no-op on plain text', () => {
    assert.equal(stripTags('你好。', CONFIG), '你好。');
  });
});

describe('hasTags', () => {
  it('detects a known tag', () => {
    assert.equal(hasTags('你好[sad]', CONFIG), true);
  });

  it('ignores unknown brackets', () => {
    assert.equal(hasTags('见 [1] 文档', CONFIG), false);
  });
});

describe('lastControlTag', () => {
  it('finds the last one', () => {
    assert.equal(lastControlTag('[sad]你好[excited]在吗', CONFIG), '[excited]');
  });

  it('is empty when there is none', () => {
    assert.equal(lastControlTag('你好', CONFIG), '');
  });
});

describe('insertAtCaret', () => {
  it('appends at the caret when there is no selection', () => {
    const box = fakeTextarea('你好');
    const caret = insertAtCaret(box, '[sad]');
    assert.equal(box.value, '你好[sad]');
    assert.equal(caret, box.value.length);
  });

  it('replaces the selection', () => {
    const box = fakeTextarea('你好世界', 2, 4);
    insertAtCaret(box, '[sad]');
    assert.equal(box.value, '你好[sad]');
  });

  it('leaves the caret after the inserted text', () => {
    const box = fakeTextarea('ab', 0);
    const caret = insertAtCaret(box, 'X');
    assert.equal(box.selectionStart, 1);
    assert.equal(caret, 1);
  });

  it('focuses so typing continues at the right place', () => {
    const box = fakeTextarea('');
    insertAtCaret(box, '[sad]');
    assert.equal(box.focused, true);
  });
});

/** Container stand-in: renderChips clears it and appends into it. */
function fakeNode() {
  return {
    innerHTML: 'stale',
    children: [],
    appendChild(child) {
      this.children.push(child);
    },
  };
}

describe('renderChips', () => {
  it('renders one button per chip', () => {
    const node = fakeNode();
    renderChips(node, tagChips(CONFIG), { onPick: () => {}, create: fakeCreate });
    assert.equal(node.children.length, 3);
    assert.equal(node.children[0].textContent, '悲伤');
    assert.equal(node.children[0].title, '[sad]');
  });

  it('marks rich chips', () => {
    const node = fakeNode();
    renderChips(node, tagChips(CONFIG, { rich: true }), { onPick: () => {}, create: fakeCreate });
    assert.match(node.children[0].className, /rich/);
  });

  it('passes the tag on click, not the display name', () => {
    const node = fakeNode();
    let picked = null;
    renderChips(node, tagChips(CONFIG), { onPick: (tag) => (picked = tag), create: fakeCreate });
    node.children[0].listeners.click();
    assert.equal(picked, '[sad]');
  });

  it('uses type=button so it cannot submit a form', () => {
    const node = fakeNode();
    renderChips(node, tagChips(CONFIG), { onPick: () => {}, create: fakeCreate });
    assert.equal(node.children[0].type, 'button');
  });

  it('clears previous chips rather than appending', () => {
    const node = fakeNode();
    renderChips(node, tagChips(CONFIG), { onPick: () => {}, create: fakeCreate });
    assert.equal(node.innerHTML, '');
    assert.equal(node.children.length, 3);
  });
});