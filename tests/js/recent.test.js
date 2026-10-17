// The 最近使用 shortcut above each voice picker.
//
// Why this is a separate module with its own tests: 253 synthesis voices and one
// more cloned voice per enrollment make "find the one I always use" the most
// repeated action in the UI. Two things about the shortcut are easy to get
// wrong and neither shows up in a screenshot:
//
//   * an id the picker does not offer (a voice from another model, a clone that
//     was deleted) must be dropped, or the dropdown offers something that fails
//     at synthesis time
//   * reapplying after a rebuild must replace the group, not stack a second one
//     at the top of the list
//
// localStorage is injected everywhere, so the private-mode fallback is covered
// here instead of discovered on a phone.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CLONE_VOICE_KEY,
  RECENT_LIMIT,
  TTS_VOICE_KEY,
  applyRecent,
  loadRecent,
  localStore,
  rememberVoice,
  selectableRecent,
  trackSelection,
} from '../../static/js/recent.js';

/** A storage that behaves, for the happy paths. */
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, value),
  };
}

/** What Safari private mode and a full quota actually throw at you. */
function hostileStorage() {
  return {
    getItem() {
      throw new DOMException('denied', 'SecurityError');
    },
    setItem() {
      throw new DOMException('quota', 'QuotaExceededError');
    },
  };
}

/**
 * A `<select>`-shaped fake with the tree semantics applyRecent relies on:
 * options live inside optgroups, `options` flattens them in tree order (and
 * never yields the optgroups themselves, which is how the real collection
 * behaves), and insertBefore/remove actually move children.
 */
function makeNode(tag, { value = '', text = value } = {}) {
  const collect = (parent, out = []) => {
    for (const child of parent.children) {
      if (child.tagName === 'OPTION') out.push(child);
      else collect(child, out);
    }
    return out;
  };
  const node = {
    tagName: tag.toUpperCase(),
    value,
    textContent: text,
    label: '',
    dataset: {},
    children: [],
    parent: null,
    listeners: {},
    get options() {
      return collect(this);
    },
    get firstChild() {
      return this.children[0] || null;
    },
    appendChild(child) {
      child.parent = this;
      this.children.push(child);
      return child;
    },
    insertBefore(child, before) {
      child.parent = this;
      const at = before ? this.children.indexOf(before) : 0;
      this.children.splice(at < 0 ? 0 : at, 0, child);
      return child;
    },
    remove() {
      const at = this.parent ? this.parent.children.indexOf(this) : -1;
      if (at >= 0) this.parent.children.splice(at, 1);
      this.parent = null;
    },
    querySelector(selector) {
      const [tag, attribute] = selector.split('[');
      const key = attribute
        ? attribute.replace(']', '').replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        : null;
      const walk = (parent) => {
        for (const child of parent.children) {
          if (child.tagName === tag.toUpperCase() && (!key || key in child.dataset)) return child;
          const hit = walk(child);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this);
    },
    cloneNode() {
      // Current state, not the constructor arguments: the real thing copies
      // whatever the node holds now, and the test above edits textContent after
      // the option was built.
      const copy = makeNode(tag, { value: node.value, text: node.textContent });
      copy.label = node.label;
      copy.dataset = { ...node.dataset };
      copy.children = node.children.map((child) => child.cloneNode(true));
      return copy;
    },
    addEventListener(type, handler) {
      (this.listeners[type] ||= []).push(handler);
    },
    dispatchEvent(event) {
      for (const handler of this.listeners[event.type] || []) handler(event);
    },
  };
  return node;
}

/** A select holding `values`, optionally already grouped the way the app does. */
function fakeSelect(values, { grouped = false } = {}) {
  const select = makeNode('select');
  const group = () => {
    const node = makeNode('optgroup');
    select.appendChild(node);
    return node;
  };
  let bucket = grouped ? group() : select;
  for (const value of values) {
    const option = makeNode('option', { value, text: `${value} · 音色` });
    bucket.appendChild(option);
    if (grouped && bucket.children.length === 2) bucket = group();
  }
  return select;
}

const create = (tag) => makeNode(tag);

describe('recent: recording a pick', () => {
  it('puts the newest voice first', () => {
    const storage = fakeStorage();
    rememberVoice(storage, TTS_VOICE_KEY, 'a');
    rememberVoice(storage, TTS_VOICE_KEY, 'b');
    assert.deepEqual(loadRecent(storage, TTS_VOICE_KEY), ['b', 'a']);
  });

  it('moves a re-picked voice back to the front instead of duplicating it', () => {
    const storage = fakeStorage();
    for (const id of ['a', 'b', 'c']) rememberVoice(storage, TTS_VOICE_KEY, id);
    rememberVoice(storage, TTS_VOICE_KEY, 'a');
    assert.deepEqual(loadRecent(storage, TTS_VOICE_KEY), ['a', 'c', 'b']);
  });

  it('keeps five, dropping the oldest', () => {
    const storage = fakeStorage();
    for (let i = 0; i < 8; i++) rememberVoice(storage, TTS_VOICE_KEY, `v${i}`);
    const recent = loadRecent(storage, TTS_VOICE_KEY);
    assert.equal(recent.length, RECENT_LIMIT);
    assert.equal(recent[0], 'v7');
    assert.ok(!recent.includes('v0'), 'the sixth-oldest should have been dropped');
  });

  it('honours a smaller cap', () => {
    const storage = fakeStorage();
    for (const id of ['a', 'b', 'c', 'd']) rememberVoice(storage, CLONE_VOICE_KEY, id, 2);
    assert.deepEqual(loadRecent(storage, CLONE_VOICE_KEY), ['d', 'c']);
  });

  it('keeps the two pickers apart', () => {
    const storage = fakeStorage();
    rememberVoice(storage, TTS_VOICE_KEY, 'synth');
    rememberVoice(storage, CLONE_VOICE_KEY, 'clone');
    assert.deepEqual(loadRecent(storage, TTS_VOICE_KEY), ['synth']);
    assert.deepEqual(loadRecent(storage, CLONE_VOICE_KEY), ['clone']);
  });

  it('ignores an empty pick', () => {
    const storage = fakeStorage({ [TTS_VOICE_KEY]: JSON.stringify(['a']) });
    assert.deepEqual(rememberVoice(storage, TTS_VOICE_KEY, ''), ['a']);
  });
});

describe('recent: reading past a bad store', () => {
  it('starts empty when there is no storage', () => {
    // The shape returned by localStore() when the browser refuses to hand it over.
    assert.deepEqual(loadRecent(null, TTS_VOICE_KEY), []);
    assert.deepEqual(rememberVoice(null, TTS_VOICE_KEY, 'a'), ['a']);
  });

  it('survives a storage that throws on both read and write', () => {
    const storage = hostileStorage();
    assert.deepEqual(loadRecent(storage, TTS_VOICE_KEY), []);
    assert.doesNotThrow(() => rememberVoice(storage, TTS_VOICE_KEY, 'a'));
  });

  it('survives a hand-edited value', () => {
    const storage = fakeStorage({ [TTS_VOICE_KEY]: '{"not":"a list"}' });
    assert.deepEqual(loadRecent(storage, TTS_VOICE_KEY), []);
  });

  it('drops entries that are not voice ids', () => {
    const storage = fakeStorage({ [TTS_VOICE_KEY]: JSON.stringify(['a', 7, null, 'b']) });
    assert.deepEqual(loadRecent(storage, TTS_VOICE_KEY), ['a', 'b']);
  });

  it('returns null rather than throwing when storage is blocked', () => {
    // localStore() itself can throw on the property access in a sandboxed frame.
    const had = 'localStorage' in globalThis;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    try {
      assert.equal(localStore(), null);
    } finally {
      if (!had) delete globalThis.localStorage;
    }
  });
});

describe('recent: the dropdown group', () => {
  it('adds a 最近使用 group at the top', () => {
    const select = fakeSelect(['longan', 'qwen', 'sam']);
    const added = applyRecent(select, ['qwen'], { create });
    assert.equal(added, 1);
    assert.equal(select.children[0].tagName, 'OPTGROUP');
    assert.equal(select.children[0].label, '最近使用');
    assert.deepEqual(select.children[0].children.map((o) => o.value), ['qwen']);
  });

  it('keeps the catalogue below it intact', () => {
    const select = fakeSelect(['a', 'b']);
    applyRecent(select, ['b'], { create });
    // The same voice still has its place in its scene group.
    assert.deepEqual(select.options.map((o) => o.value), ['b', 'a', 'b']);
  });

  it('clones the option, so the capability suffix comes along', () => {
    const select = fakeSelect(['longan']);
    select.options[0].textContent = '龙安洋 · 阳光大男孩　〔情感 场景〕';
    applyRecent(select, ['longan'], { create });
    assert.equal(select.children[0].children[0].textContent, '龙安洋 · 阳光大男孩　〔情感 场景〕');
    // And the clone is a copy: editing it cannot rewrite the catalogue entry.
    assert.notEqual(select.children[0].children[0], select.options[1]);
  });

  it('finds a voice that sits inside an optgroup', () => {
    // The synthesis picker builds optgroups; the clone picker does not.
    const select = fakeSelect(['a', 'b', 'c'], { grouped: true });
    assert.equal(applyRecent(select, ['b'], { create }), 1);
    assert.deepEqual(select.children[0].children.map((o) => o.value), ['b']);
  });

  it('drops ids this picker does not offer', () => {
    // A voice from another model, or a clone that has since been deleted.
    const select = fakeSelect(['a', 'b']);
    assert.equal(applyRecent(select, ['a', 'gone', 'other-model'], { create }), 1);
    assert.deepEqual(select.children[0].children.map((o) => o.value), ['a']);
  });

  it('adds nothing when every remembered id is gone', () => {
    const select = fakeSelect(['a']);
    assert.equal(applyRecent(select, ['gone'], { create }), 0);
    assert.equal(select.children.length, 1);
    assert.equal(select.children[0].tagName, 'OPTION');
  });

  it('adds nothing when there is no history', () => {
    const select = fakeSelect(['a', 'b']);
    assert.equal(applyRecent(select, [], { create }), 0);
    assert.equal(select.children.length, 2);
    assert.equal(applyRecent(select, null, { create }), 0);
  });

  it('replaces the group instead of stacking a second one', () => {
    // refreshVoices() rebuilds the list on every load and on every 刷新列表.
    const select = fakeSelect(['a', 'b', 'c']);
    applyRecent(select, ['a', 'b'], { create });
    applyRecent(select, ['c'], { create });
    const groups = select.children.filter((child) => child.tagName === 'OPTGROUP');
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].children.map((o) => o.value), ['c']);
  });

  it('clears a group whose voices all disappeared', () => {
    const select = fakeSelect(['a', 'b']);
    applyRecent(select, ['a'], { create });
    applyRecent(select, ['deleted'], { create });
    assert.equal(select.children.filter((c) => c.tagName === 'OPTGROUP').length, 0);
  });

  it('survives a missing select', () => {
    assert.equal(applyRecent(null, ['a'], { create }), 0);
  });
});

describe('recent: resolving against the open dropdown', () => {
  it('returns the remembered order, as options', () => {
    const select = fakeSelect(['a', 'b', 'c']);
    const found = selectableRecent(select, ['c', 'a']);
    assert.deepEqual(found.map((o) => o.value), ['c', 'a']);
  });

  it('is empty for an empty history', () => {
    assert.deepEqual(selectableRecent(fakeSelect(['a']), []), []);
    assert.deepEqual(selectableRecent(null, ['a']), []);
  });
});

describe('recent: tracking a change', () => {
  it('records the picked voice', () => {
    const storage = fakeStorage();
    const select = fakeSelect(['a', 'b']);
    select.value = 'b';
    trackSelection(select, { storage, key: CLONE_VOICE_KEY });
    select.dispatchEvent({ type: 'change' });
    assert.deepEqual(loadRecent(storage, CLONE_VOICE_KEY), ['b']);
  });

  it('survives the picker being rebuilt around it', () => {
    // The listener sits on the <select>; refreshVoices() only replaces options.
    const storage = fakeStorage();
    const select = fakeSelect(['a']);
    trackSelection(select, { storage, key: CLONE_VOICE_KEY });
    select.children = [];
    select.value = 'b';
    select.dispatchEvent({ type: 'change' });
    assert.deepEqual(loadRecent(storage, CLONE_VOICE_KEY), ['b']);
  });

  it('is a no-op without a picker', () => {
    assert.doesNotThrow(() => trackSelection(null, { storage: fakeStorage(), key: 'k' }));
  });
});