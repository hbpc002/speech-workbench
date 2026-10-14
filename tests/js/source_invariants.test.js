// Source-level invariants that a runtime test cannot see.
//
// The specific one: `export { X } from './mod.js'` gives *importers* a binding
// for X but creates no binding inside the module doing the re-export. A module
// that re-exports something it also calls internally therefore throws
// `ReferenceError: X is not defined` the moment it runs -- and if that call is
// on the auth path, the operator gets a password prompt on every reload even
// though their session cookie is valid.
//
// This shipped. It is cheap to check and impossible to notice without a browser,
// so it is checked here.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const JS_DIR = join(HERE, '..', '..', 'static', 'js');

const files = readdirSync(JS_DIR).filter((name) => name.endsWith('.js'));

/** Strip import/re-export statements so only real call sites are matched. */
function bodyWithoutBindings(source) {
  return source
    .replace(/^import\s[\s\S]*?from\s*['"][^'"]+['"];?/gm, '')
    .replace(/^export\s*\{[^}]*\}\s*from\s*['"][^'"]+['"];?/gm, '');
}

describe('static/js module bindings', () => {
  it('finds the js sources at all', () => {
    assert.ok(files.length > 5, `expected several modules, found ${files.length}`);
  });

  for (const name of files) {
    it(`${name} does not re-export a name it also calls`, () => {
      const source = readFileSync(join(JS_DIR, name), 'utf8');
      const offenders = [];

      for (const match of source.matchAll(/^export\s*\{([^}]*)\}\s*from/gm)) {
        for (const raw of match[1].split(',')) {
          const exported = raw.trim().split(/\s+as\s+/)[0].trim();
          if (!exported) continue;
          const called = new RegExp(`(?<![\\w.$])${exported}\\s*\\(`).test(bodyWithoutBindings(source));
          if (called) offenders.push(exported);
        }
      }

      assert.deepEqual(
        offenders,
        [],
        `${name}: export { ${offenders.join(', ')} } from ... gives importers a binding ` +
          `but none inside this module, so calling ${offenders[0]}() throws ReferenceError. ` +
          `Use \`import { ${offenders[0]} } from '...'\` and then \`export { ${offenders[0]} }\`.`
      );
    });
  }
});

describe('boot guard', () => {
  it('app.js only boots when a document exists', () => {
    // Without this guard the module cannot be imported under node --test at
    // all, which is why the auth path had no coverage.
    const source = readFileSync(join(JS_DIR, 'app.js'), 'utf8');
    assert.match(source, /if \(typeof document !== 'undefined'\) boot\(\);/);
    assert.doesNotMatch(source, /^\s*boot\(\);\s*$/m);
  });

  it('http.js is what the tabs and app share', () => {
    const app = readFileSync(join(JS_DIR, 'app.js'), 'utf8');
    assert.match(app, /^import \{ api \} from '\.\/http\.js';$/m);
    assert.match(app, /^export \{ api \};$/m);
  });
});

describe('multipart safety', () => {
  it('no module labels FormData as JSON', () => {
    // The regression that broke cloning: app.js's api() set
    // `Content-Type: application/json` unconditionally, so the browser never
    // appended the multipart boundary.
    const http = readFileSync(join(JS_DIR, 'http.js'), 'utf8');
    assert.match(http, /options\.body instanceof FormData/);
  });

  it('no tab re-defines its own api()', () => {
    // tab_voice.js used to, correctly, because app.js's version was JSON-only.
    // One implementation now; a second copy can only drift.
    for (const name of files.filter((f) => f.startsWith('tab_'))) {
      const source = readFileSync(join(JS_DIR, name), 'utf8');
      assert.doesNotMatch(source, /export async function api\(/, `${name} defines its own api()`);
    }
  });
});

describe('WAV assembly', () => {
  it('accepts a bare Int16Array as a single chunk', () => {
    // The defence that makes the earlier mistake non-fatal: a bare array used
    // to iterate as numbers, give an undefined chunk length, and produce a
    // valid-looking 44-byte WAV of digital silence.
    //
    // Whether the samples actually survive is asserted at runtime in
    // wav.test.js -- a static check cannot tell that `ready.map(...)` returns
    // an array, so checking call-site shapes here would only be theatre.
    const source = readFileSync(join(JS_DIR, 'audio.js'), 'utf8');
    assert.match(source, /chunks instanceof Int16Array \? \[chunks\] : chunks/);
  });

  it('is still called somewhere', () => {
    // Guards the guard above: if the call sites ever disappear, the defence
    // stops being exercised.
    let count = 0;
    for (const name of files) {
      for (const line of readFileSync(join(JS_DIR, name), 'utf8').split('\n')) {
        if (/pcmToWavBlob\s*\(/.test(line) && !/\bfunction\s+pcmToWavBlob\b/.test(line)) count++;
      }
    }
    assert.ok(count >= 4, `expected at least 4 call sites, found ${count}`);
  });
});