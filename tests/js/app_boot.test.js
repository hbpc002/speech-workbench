// The page boot sequence: auth check, login gate, config load.
//
// Both regressions that shipped in this area were invisible here because the
// sequence had no coverage at all:
//
//   * `export { api } from './http.js'` left `api` undefined *inside* app.js,
//     so /authcheck never ran and the operator was held behind the password
//     prompt on every reload despite a valid session cookie
//   * `await api(...).catch(...)` cannot catch a synchronous throw while
//     evaluating `api`, which is how that ReferenceError slipped past the
//     intended fallback
//
// app.js boots on import when a document exists, so each case installs a DOM,
// stubs fetch, and imports the module fresh via a cache-busting query.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { CONFIG_BODY, installDom, stubFetch, uninstallDom } from './dom_stub.js';

const APP = '../../static/js/app.js';
let counter = 0;

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.localStorage;
  uninstallDom();
});

/** Boot app.js fresh against the given routes. */
async function boot(routes, { onCall, domOptions } = {}) {
  const dom = installDom(domOptions);
  const calls = stubFetch(routes, { onCall });
  counter += 1;
  const mod = await import(`${APP}?boot=${counter}`);
  // boot() is async and not awaited on import; let its microtasks settle.
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { dom, mod, calls };
}

const ROUTES = {
  '/authcheck': { body: { authenticated: true } },
  '/healthz': { body: { status: 'ok', storage: 'blob' } },
  '/api/config': { body: CONFIG_BODY },
  '/api/prompts': { body: {} },
};

describe('boot: an existing session', () => {
  it('hides the login gate', async () => {
    const { dom } = await boot(ROUTES);
    assert.equal(dom.get('login').hidden, true);
  });

  it('shows the app', async () => {
    const { dom } = await boot(ROUTES);
    assert.equal(dom.get('app').hidden, false);
  });

  it('asks the server whether the session is valid', async () => {
    const { calls } = await boot(ROUTES);
    assert.ok(calls.some((c) => c.url === '/authcheck'), '/authcheck was never called');
  });

  it('never sends the login form as JSON on a plain GET', async () => {
    const { calls } = await boot(ROUTES);
    const check = calls.find((c) => c.url === '/authcheck');
    assert.equal(check.options.headers?.['Content-Type'], 'application/json');
  });

  it('loads the runtime config', async () => {
    const { mod } = await boot(ROUTES);
    assert.ok(mod.state.config, 'config should be populated');
    assert.equal(mod.state.config.enroll_target_seconds, 10);
  });

  it('merges the health check storage into the config', async () => {
    const { mod } = await boot({ ...ROUTES, '/healthz': { body: { storage: 'local' } } });
    assert.equal(mod.state.config.storage, 'local');
  });

  it('still loads the config when healthz is unreachable', async () => {
    const { mod } = await boot({ ...ROUTES, '/healthz': { status: 503 } });
    assert.ok(mod.state.config);
  });
});

describe('boot: no session', () => {
  it('shows the login gate', async () => {
    const { dom } = await boot({ ...ROUTES, '/authcheck': { body: { authenticated: false } } });
    assert.equal(dom.get('login').hidden, false);
  });

  it('keeps the app hidden', async () => {
    const { dom } = await boot({ ...ROUTES, '/authcheck': { body: { authenticated: false } } });
    assert.equal(dom.get('app').hidden, true);
  });
});

describe('boot: the auth check itself fails', () => {
  // The exact regression: a synchronous throw (api undefined) used to escape
  // the `.catch(...)` fallback and strand the operator at the password prompt.
  it('lets the operator in when authcheck 500s', async () => {
    const { dom } = await boot({ ...ROUTES, '/authcheck': { status: 500 } });
    assert.equal(dom.get('login').hidden, true);
  });

  it('lets the operator in when authcheck is unreachable', async () => {
    const { dom } = await boot(ROUTES, {
      onCall: (url) => (url === '/authcheck' ? Promise.reject(new Error('offline')) : null),
    });
    assert.equal(dom.get('login').hidden, true);
  });

  it('lets the operator in when the request layer blows up', async () => {
    // Not a synchronous throw, despite what that implies elsewhere: `api` is an
    // async function, so it can only ever reject. The synchronous throw that
    // actually bit us was `api` being an *undefined identifier*, which throws
    // while evaluating the callee -- before any `.catch` on it exists. The
    // try/catch covers both shapes.
    const { dom } = await boot(ROUTES, {
      onCall: () => {
        throw new Error('api is not defined');
      },
    });
    assert.equal(dom.get('login').hidden, true);
  });

  it('treats a missing field as authenticated', async () => {
    const { dom } = await boot({ ...ROUTES, '/authcheck': { body: {} } });
    assert.equal(dom.get('login').hidden, true);
  });
});

/** A catalogue with two voices, so a picker actually has something to choose. */
const VOICE_CONFIG = {
  ...CONFIG_BODY,
  tts_models: [{
    id: 'cosyvoice-v3-flash',
    label: 'cosyvoice-v3-flash',
    default_voice: 'longcheng',
    groups: ['男声'],
    supports_instruction: false,
    voices: [
      { id: 'longan', name: '龙安洋', trait: '阳光大男孩', group: '男声', lang: 'zh' },
      { id: 'longcheng', name: '龙橙', trait: '阳光青年', group: '男声', lang: 'zh' },
    ],
  }],
  voice_capabilities: { longan: ['情感', '场景'] },
};

describe('boot: the remembered voice', () => {
  /** localStorage as a Map, torn down with the rest of the globals. */
  function seedLocalStorage(entries = {}) {
    const data = new Map(Object.entries(entries));
    globalThis.localStorage = {
      getItem: (key) => (data.has(key) ? data.get(key) : null),
      setItem: (key, value) => data.set(key, value),
    };
    return data;
  }

  it('falls back to the catalogue default with no history', async () => {
    seedLocalStorage();
    const { dom } = await boot({ ...ROUTES, '/api/config': { body: VOICE_CONFIG } });
    assert.equal(dom.get('tts-voice').value, 'longcheng');
    assert.ok(!recentGroup(dom), 'no history should mean no shortcut group');
  });

  it('wins over the default, and appears at the top of the picker', async () => {
    // The point of the whole feature: 253 voices, and the one you always use is
    // still at the top of the list and already selected.
    seedLocalStorage({ 'recent.ttsVoice': JSON.stringify(['longan']) });
    const { dom } = await boot({ ...ROUTES, '/api/config': { body: VOICE_CONFIG } });
    assert.equal(dom.get('tts-voice').value, 'longan');
    const group = recentGroup(dom);
    assert.ok(group, 'expected a 最近使用 group');
    assert.equal(group.label, '最近使用');
    assert.deepEqual(group.options.map((o) => o.value), ['longan']);
  });

  it('clones the entry, so the capability suffix survives', async () => {
    seedLocalStorage({ 'recent.ttsVoice': JSON.stringify(['longan']) });
    const { dom } = await boot({ ...ROUTES, '/api/config': { body: VOICE_CONFIG } });
    const [shortcut] = recentGroup(dom).options;
    assert.match(shortcut.textContent, /〔情感 场景〕/);
  });

  it('ignores a remembered voice this model does not offer', async () => {
    // Voices are bound to the model they belong to, so after switching models
    // the shortcut must fall back rather than offer something that 418s.
    seedLocalStorage({ 'recent.ttsVoice': JSON.stringify(['qwen-only']) });
    const { dom } = await boot({ ...ROUTES, '/api/config': { body: VOICE_CONFIG } });
    assert.ok(!recentGroup(dom));
    assert.equal(dom.get('tts-voice').value, 'longcheng');
  });

  it('boots normally when the browser refuses localStorage', async () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    const { dom } = await boot({ ...ROUTES, '/api/config': { body: VOICE_CONFIG } });
    assert.equal(dom.get('login').hidden, true);
    assert.equal(dom.get('tts-voice').value, 'longcheng');
  });
});

/** The 最近使用 optgroup in a booted picker, if there is one. */
function recentGroup(dom) {
  return dom.get('tts-voice').children.find((child) => child.dataset.recentVoices !== undefined);
}

describe('boot: config load fails', () => {
  it('says so on the badge instead of failing silently', async () => {
    const { dom } = await boot({ ...ROUTES, '/api/config': { status: 500 } });
    assert.match(dom.text('platform-badge') || '', /配置加载失败/);
  });

  it('names the underlying reason', async () => {
    const { dom } = await boot({
      ...ROUTES,
      '/api/config': { status: 500, body: { detail: '数据库连不上' } },
    });
    assert.match(dom.text('platform-badge') || '', /数据库连不上/);
  });

  it('renders a FastAPI validation list readably', async () => {
    // Never "[object Object]": that tells the operator nothing.
    const { dom } = await boot({
      ...ROUTES,
      '/api/config': {
        status: 422,
        body: { detail: [{ loc: ['body', 'audio'], msg: 'Field required' }] },
      },
    });
    const text = dom.text('platform-badge') || '';
    assert.doesNotMatch(text, /\[object Object\]/);
    assert.match(text, /audio/);
  });
});

describe('app.js module shape', () => {
  it('exports api for the tabs', async () => {
    const { mod } = await boot(ROUTES);
    assert.equal(typeof mod.api, 'function');
  });

  it('does not boot when there is no document', async () => {
    // The guard that makes this file testable at all.
    uninstallDom();
    const calls = stubFetch({});
    counter += 1;
    const mod = await import(`${APP}?noDocument=${counter}`);
    // boot() is async and not awaited on import, so give it a chance to.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(typeof mod.api, 'function');
    // No document, no boot: not one request. The config left over from the cases
    // above cannot be asserted here -- `state` moved to dom.js and is now the
    // same object for every import.
    assert.deepEqual(calls, []);
  });
});