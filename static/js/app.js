// Shell: login gate, config loading, tab switching, and the small DOM helpers
// every tab uses.

// Imported, not re-exported in place: `export { api } from './http.js'` gives
// importers a binding but leaves `api` undefined *inside* this module, and the
// five call sites below would throw ReferenceError. That broke the auth check,
// which locked the operator behind the password prompt on every reload even
// with a valid session cookie.
import { api } from './http.js';
import { record as debugRecord } from './debug_log.js';
import { initDebugConsole } from './debug_console.js';
import { TTS_VOICE_KEY, applyRecent, loadRecent, localStore, trackSelection } from './recent.js';
// Imported, not re-exported in place: `export { el } from './dom.js'` gives
// importers a binding but leaves `el` undefined *inside* this module, and the
// dozens of call sites below would throw ReferenceError.
import { el, state } from './dom.js';

// One import site for the tabs, now that the implementation lives in http.js.
export { api };

// Re-exported for the tabs, which have always imported them from here.
export { el, state };

export function setStatus(id, text, kind = '') {
  const node = el(id);
  if (!node) return;
  node.textContent = text;
  node.dataset.state = kind;
}

const STATUS_LABELS = {
  connected: '已连接',
  connecting: '连接中…',
  reconnecting: '重连中…',
  closed: '已断开',
  error: '错误',
};

export function applySocketStatus(id, raw) {
  setStatus(id, STATUS_LABELS[raw] || raw, raw);
}

export function appendMsg(container, text, kind = 'user') {
  const node = document.createElement('div');
  node.className = `msg ${kind}`;
  node.textContent = text;
  el(container).appendChild(node);
  const box = el(container);
  box.scrollTop = box.scrollHeight;
  return node;
}

export function updateMsg(node, text) {
  if (!node) return;
  node.textContent = text;
  const box = node.parentElement;
  if (box) box.scrollTop = box.scrollHeight;
}

export function log(container, text, kind = 'system') {
  // Chat and recognition transcripts are already visible in their own panels;
  // mirroring every token into the diagnostic log would bury the request lines.
  // Status lines are the ones an operator wants beside the HTTP commands.
  if (String(container).endsWith('-status')) {
    debugRecord(kind === 'error' ? 'error' : 'info', text, { source: container });
  }
  return appendMsg(container, text, kind);
}

function selectInto(node, values) {
  if (!node) return;
  node.innerHTML = '';
  for (const value of values) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = String(value);
    node.appendChild(option);
  }
}

function showLogin(show, message = '') {
  el('login').hidden = !show;
  el('app').hidden = show;
  const error = el('login-error');
  error.hidden = !message;
  error.textContent = message;
}

function wireTabs() {
  const tabs = [...document.querySelectorAll('.tab')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.toggle('active', t === tab));
      for (const panel of document.querySelectorAll('.panel')) {
        panel.classList.toggle('active', panel.dataset.panel === tab.dataset.tab);
      }
      history.replaceState(null, '', `#${tab.dataset.tab}`);
      // Panels differ in height, so a scroll position that was right for the
      // old one can land the new one halfway down. Optional call, because the
      // boot tests import this module without a window.
      globalThis.scrollTo?.({ top: 0 });
    });
  }
  const initial = location.hash.replace('#', '');
  if (initial) {
    const match = tabs.find((t) => t.dataset.tab === initial);
    if (match) match.click();
  }
}

function populateModelSelect(node, models, selected) {
  if (!node) return;
  node.innerHTML = '';
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.label;
    node.appendChild(option);
  }
  if (selected) node.value = selected;
}

function populateVoiceSelect(node, model, selected) {
  if (!node || !model) return;
  node.innerHTML = '';
  const capabilities = state.config.voice_capabilities || {};
  const byGroup = new Map((model.groups || []).map((g) => [g, []]));
  for (const voice of model.voices || []) {
    if (!byGroup.has(voice.group || model.groups?.[0])) {
      byGroup.set(voice.group || '其他', []);
    }
    byGroup.get(voice.group || model.groups?.[0]).push(voice);
  }
  // v3 voices carry a per-voice `group`; the smaller catalogues do not.
  for (const [group, entries] of byGroup) {
    if (!entries.length) continue;
    const optgroup = document.createElement('optgroup');
    optgroup.label = group;
    for (const voice of entries) {
      const option = document.createElement('option');
      option.value = voice.id;
      // Voices that accept instructions are tagged so they can be spotted
      // in a 89-entry list without switching each one.
      const caps = capabilities[voice.id];
      const suffix = caps && caps.length ? `　〔${caps.join(' ')}〕` : '';
      option.textContent = `${voice.name} · ${voice.trait}${suffix}`;
      option.dataset.lang = voice.lang;
      optgroup.appendChild(option);
    }
    node.appendChild(optgroup);
  }
  // 253 entries across twelve groups is a lot to scroll past every time, so the
  // ones already picked get a shortcut at the top. Entries belonging to another
  // model are dropped by applyRecent; the surviving one then wins over the
  // catalogue default, which is the whole point of remembering it.
  const recent = loadRecent(localStore(), TTS_VOICE_KEY);
  applyRecent(node, recent);
  const remembered = recent.find((id) => [...node.options].some((o) => o.value === id));
  if (remembered || selected) node.value = remembered || selected;
}

function syncTtsSelectors() {
  const cfg = state.config;
  const models = cfg.tts_models || [];
  const model = models.find((m) => m.id === el('tts-model').value);
  // Voice first, then instruction options: the latter are derived from the
  // selected voice, so reading it before the list exists would wrongly report
  // that the default voice supports nothing.
  populateVoiceSelect(el('tts-voice'), model, model ? model.default_voice : null);
  populateInstructionKinds();
  const instruct = el('tts-instruct-kind');
  instruct.disabled = !(model && model.supports_instruction);
  if (instruct.disabled && instruct.value) instruct.value = '';
  instruct.dispatchEvent(new Event('change'));
}

/**
 * Instruction support is per voice and mostly disjoint, so the options are
 * rebuilt from the server's verified capability map rather than shown for
 * every voice and failing at generation time.
 */
function populateInstructionKinds() {
  const voiceId = el('tts-voice') ? el('tts-voice').value : '';
  const node = el('tts-instruct-kind');
  const profiles = state.config.instruct_profiles || {};
  const kinds = profiles[voiceId] || [{ id: '', label: '无' }];
  const previous = node.value;

  node.innerHTML = '';
  for (const kind of kinds) {
    const option = document.createElement('option');
    option.value = kind.id;
    option.textContent = kind.label;
    node.appendChild(option);
  }
  if ([...node.options].some((o) => o.value === previous)) node.value = previous;
}

function populateFromConfig() {
  const cfg = state.config;

  el('chat-model').value = cfg.realtime_model;
  selectInto(el('chat-voice'), cfg.realtime_voices);
  selectInto(el('chat-vad'), cfg.realtime_vad_modes);
  selectInto(el('chat-silence'), cfg.silence_durations);

  populateModelSelect(el('tts-model'), cfg.tts_models || [], cfg.tts_default_model);
  syncTtsSelectors();
  el('tts-model').addEventListener('change', syncTtsSelectors);
  el('tts-model').addEventListener('change', () => {
    // Tag support is model-specific; the tab panel re-renders off this event.
    window.dispatchEvent(new Event('tts-model-changed'));
  });
  el('tts-voice').addEventListener('change', () => {
    populateInstructionKinds();
    el('tts-instruct-kind').dispatchEvent(new Event('change'));
  });
  // Attached to the <select>, which is never replaced -- only its options are
  // rebuilt -- so one listener covers every model switch.
  trackSelection(el('tts-voice'), { storage: localStore(), key: TTS_VOICE_KEY });

  selectInto(el('voice-model'), cfg.clone_models);

  el('voice-record-hint').textContent = `录制约 ${cfg.enroll_target_seconds} 秒清晰人声`;

  const platform = [];
  if (cfg.using_workspace_endpoint) platform.push('workspace 端点');
  platform.push(`存储 ${cfg.storage || '-'}`);
  el('platform-badge').textContent = platform.join(' · ');
}

async function loadRuntimeConfig() {
  const health = await api('/healthz').catch(() => null);
  if (health) state.config = { ...(await api('/api/config')), storage: health.storage };
  else state.config = await api('/api/config');
  state.prompts = await api('/api/prompts').catch(() => ({}));
  populateFromConfig();
}

/**
 * Whether the operator already holds a valid session.
 *
 * The try/catch wraps the *call*, not just a promise: `await api(...).catch()`
 * cannot catch a synchronous throw while evaluating `api` itself, which is
 * exactly how a ReferenceError in this file used to bypass the fallback and
 * lock the operator out of their own deployment.
 *
 * Defaults to authenticated on any failure. Reaching your own app is the
 * common case, and /api/config plus the WebSocket auth checks are the real
 * gates; a transient 500 here should not mean a password prompt on every
 * reload.
 */
async function checkSession() {
  try {
    const body = await api('/authcheck');
    // Only an explicit false asks for the password. A missing field or a
    // malformed body means "cannot prove unauthenticated", which is the same
    // position as a network failure.
    return body?.authenticated !== false;
  } catch {
    return true;
  }
}

async function boot() {
  wireTabs();

  el('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.reload();
  });

  el('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: el('password').value }),
      }).then((r) => {
        if (!r.ok) throw new Error('密码错误');
      });
      showLogin(false);
      start();
    } catch (error) {
      showLogin(true, error.message);
    }
  });

  if (await checkSession()) {
    showLogin(false);
    start();
  } else {
    showLogin(true);
  }
}

const TAB_MODULES = [
  '/static/js/tab_chat.js',
  '/static/js/tab_asr.js',
  '/static/js/tab_tts.js',
  '/static/js/tab_voice.js',
];

async function start() {
  initDebugConsole();
  try {
    await loadRuntimeConfig();
  } catch (error) {
    el('platform-badge').textContent = `配置加载失败: ${error.message}`;
    return;
  }

  // Wire each tab independently so one broken module does not silently take
  // down the whole page.
  const results = await Promise.allSettled(TAB_MODULES.map((path) => import(path)));
  results.forEach((result, index) => {
    const label = TAB_MODULES[index].split('/').pop();
    if (result.status === 'rejected') {
      console.error(`${label} failed to load`, result.reason);
      el('platform-badge').textContent = `${label} 加载失败`;
      return;
    }
    try {
      result.value.init();
    } catch (error) {
      console.error(`${label} failed to init`, error);
      el('platform-badge').textContent = `${label} 初始化失败`;
    }
  });
}

/**
 * Importing this module must not boot the page: under `node --test` there is
 * no document, and the tests need to control when and with what DOM it runs.
 * `http.js` was extracted for the same reason.
 */
if (typeof document !== 'undefined') boot();