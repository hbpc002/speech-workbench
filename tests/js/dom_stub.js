// Minimal DOM stand-in for booting app.js under `node --test`.
//
// app.js touches a lot of the document at import time, and jsdom is not a
// dependency (package.json exists only so Node treats static/js/*.js as ESM).
// This is the smallest thing that makes `boot()` runnable, and it is shared by
// every test that needs a page.

/** A node with the handful of properties app.js actually reads or writes. */
function makeNode(tag = 'div', id = '') {
  const node = {
    tagName: tag.toUpperCase(),
    id,
    hidden: false,
    textContent: '',
    // Assigning '' empties the element, so a handler that clears a list before
    // refilling it actually clears it. As a plain data property it silently
    // accumulated every option instead.
    _innerHTML: '',
    get innerHTML() { return this._innerHTML; },
    set innerHTML(value) {
      this._innerHTML = value;
      if (value === '') this.children = [];
    },
    value: '',
    type: '',
    disabled: false,
    title: '',
    style: {},
    dataset: {},
    children: [],
    // Live, like HTMLOptionsCollection: every descendant <option> in tree
    // order, whatever optgroup it sits in. A static array here hides every
    // "is this voice still in the list?" question the pickers ask of it.
    get options() {
      const found = [];
      const walk = (parent) => {
        for (const child of parent.children || []) {
          if (child.tagName === 'OPTION') found.push(child);
          else walk(child);
        }
      };
      walk(this);
      return found;
    },
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle(c, force) { force ? this._set.add(c) : this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    listeners: {},
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
    removeEventListener() {},
    // Real, not a no-op: the script boxes announce every write with an `input`
    // event and the 去标签 buttons keep their disabled state in sync from it, so
    // a stub that swallows events hides exactly the bugs worth catching.
    dispatchEvent(event) {
      for (const handler of this.listeners[event.type] || []) handler(event);
    },
    appendChild(child) { this.children.push(child); return child; },
    append(...nodes) { this.children.push(...nodes); },
    removeChild() {},
    remove() {},
    // The voice pickers: populateVoiceSelect() looks for a stale 最近使用 group
    // before it adds one, and applyRecent() puts the new one first.
    get firstChild() { return this.children[0] || null; },
    insertBefore(child, before) {
      const at = before ? this.children.indexOf(before) : 0;
      this.children.splice(at < 0 ? 0 : at, 0, child);
      return child;
    },
    // A copy, so editing the clone cannot rewrite the node it came from -- which
    // is how the 最近使用 entries are meant to behave.
    cloneNode() {
      const copy = makeNode(this.tagName.toLowerCase(), this.id);
      copy.value = this.value;
      copy.textContent = this.textContent;
      copy.label = this.label;
      copy.dataset = { ...this.dataset };
      return copy;
    },
    querySelector() { return null; },
    setSelectionRange() {},
    focus() {},
    // `<dialog>`: the AI dialog is opened, closed and re-opened by the tab, and
    // showModal() throws when it is already open -- so the stub has to track it.
    open: false,
    showModal() { this.open = true; },
    close() { this.open = false; },
    closest() { return null; },
    getAttribute() { return null; },
    setAttribute() {},
    querySelectorAll() { return []; },
    click() {},
  };
  return node;
}

/** The ids app.js needs present for boot() and start() to complete. */
export const REQUIRED_IDS = [
  'login',
  'login-form',
  'login-error',
  'password',
  'app',
  'logout',
  'platform-badge',
  'chat-model',
  'chat-voice',
  'chat-vad',
  'chat-silence',
  'tts-model',
  'tts-voice',
  'tts-instruct-kind',
  'voice-model',
  'voice-record-hint',
];

/**
 * Install a fresh DOM on globalThis and return a handle.
 *
 * `extraIds` covers tests that need an element app.js does not reach for.
 */
export function installDom({ ids = [], hash = '' } = {}) {
  const nodes = new Map();
  for (const id of [...REQUIRED_IDS, ...ids]) {
    nodes.set(id, makeNode('div', id));
  }

  const document = {
    getElementById: (id) => nodes.get(id) || null,
    querySelectorAll: () => [],
    createElement: (tag) => makeNode(tag),
    addEventListener() {},
    removeEventListener() {},
  };

  globalThis.document = document;
  globalThis.location = { hash, reload() {} };
  globalThis.history = { replaceState() {} };
  if (!globalThis.Event) globalThis.Event = class Event { constructor(type) { this.type = type; } };

  return {
    document,
    nodes,
    /** The node, throwing rather than returning null so typos fail loudly. */
    get(id) {
      const node = nodes.get(id);
      if (!node) throw new Error(`test DOM is missing #${id}`);
      return node;
    },
    text(id) {
      return nodes.get(id)?.textContent;
    },
  };
}

export function uninstallDom() {
  delete globalThis.document;
  delete globalThis.location;
  delete globalThis.history;
}

/** A `fetch` that answers from a table of `path -> response`. */
export function stubFetch(routes, { onCall } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (onCall) {
      const custom = await onCall(url, options);
      if (custom) return custom;
    }
    const entry = routes[url];
    if (!entry) {
      return { ok: false, status: 404, json: async () => ({ detail: `no stub for ${url}` }) };
    }
    const status = entry.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => entry.body ?? {},
    };
  };
  return calls;
}

/** The smallest config that satisfies populateFromConfig(). */
export const CONFIG_BODY = {
  realtime_model: 'qwen-audio-3.0-realtime-plus',
  realtime_voices: [],
  realtime_vad_modes: [],
  silence_durations: [],
  tts_models: [],
  tts_default_model: 'cosyvoice-v3-flash',
  clone_models: [],
  enroll_target_seconds: 10,
  storage: 'blob',
};