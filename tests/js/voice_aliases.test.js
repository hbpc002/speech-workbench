import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aliasOf, displayNameOf, hydrateVoiceAliases, rememberAlias } from '../../static/js/voice_aliases.js';

// The module dispatches a CustomEvent on rename; under `node --test` there is
// no window, so the guard has to keep that from throwing.
const noWindow = globalThis.window;
test.afterEach(() => {
  globalThis.window = noWindow;
  hydrateVoiceAliases([]);
});

test('falls back to the catalogue label when nothing is named', () => {
  hydrateVoiceAliases([]);
  assert.equal(displayNameOf('cosyvoice-v3-flash-10201530-8f3a2b1c', '晓晓 · 活泼'), '晓晓 · 活泼');
  assert.equal(displayNameOf('x', ''), 'x');
  assert.equal(displayNameOf('', 'fallback'), 'fallback');
});

test('the alias wins over the catalogue label', () => {
  rememberAlias('v-1', '旁白');
  assert.equal(displayNameOf('v-1', '晓晓 · 活泼'), '旁白');
  assert.equal(aliasOf('v-1'), '旁白');
});

test('hydrate replaces the whole map and clears what is gone', () => {
  rememberAlias('v-1', '旁白');
  rememberAlias('v-2', '女声');
  hydrateVoiceAliases([{ id: 'v-2', alias: '旁白2' }, { id: 'v-3', alias: '   ' }]);
  assert.equal(aliasOf('v-1'), '');
  assert.equal(aliasOf('v-2'), '旁白2');
  assert.equal(aliasOf('v-3'), '');
});

test('an empty alias undoes a rename', () => {
  rememberAlias('v-1', '旁白');
  rememberAlias('v-1', '');
  assert.equal(aliasOf('v-1'), '');
  assert.equal(displayNameOf('v-1', '晓晓'), '晓晓');
});

test('does not throw when dispatching under node', () => {
  assert.doesNotThrow(() => hydrateVoiceAliases([]));
  assert.doesNotThrow(() => rememberAlias('v-1', '旁白'));
});