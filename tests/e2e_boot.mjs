// End-to-end boot check: the real static/js/app.js against a live uvicorn.
//
// Not part of `node --test tests/js/**` because it needs a server and a port;
// run it explicitly with `npm run e2e`.
//
// This exists because two browser-only regressions shipped that unit tests could
// not see:
//
//   * `export { api } from './http.js'` left `api` undefined inside app.js, so
//     /authcheck never ran and a valid session still produced a password prompt
//   * the same helper labelled a FormData body application/json, losing the
//     multipart boundary and failing enrollment with "[object Object]"
//
// Node cannot resolve the '/static/js/tab_*.js' imports (a browser serves them
// over HTTP), so their load failure is expected and Promise.allSettled absorbs
// it. Everything this script asserts is on the shell and the request layer.

import { spawn } from 'node:child_process';
import { installDom } from './js/dom_stub.js';

const PORT = Number(process.env.E2E_PORT || 8099);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'e2e-password';
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

function startServer() {
  const child = spawn(
    `${ROOT}/.venv/bin/python`,
    ['-m', 'uvicorn', 'server.main:app', '--host', '127.0.0.1', '--port', String(PORT), '--log-level', 'warning'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        DASHSCOPE_API_KEY: 'sk-invalid-by-design',
        APP_PASSWORD: PASSWORD,
        PUBLIC_BASE_URL: 'https://e2e.example',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    }
  );
  child.stderr.on('data', () => {});
  return child;
}

async function waitForServer(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return true;
    } catch (_) {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** 10 seconds of 16 kHz mono PCM in a WAV container. */
function enrollmentWav() {
  const pcm = new Int16Array(16000 * 10).fill(2000);
  const buf = Buffer.alloc(44 + pcm.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + pcm.length * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(pcm.length * 2, 40);
  Buffer.from(pcm.buffer).copy(buf, 44);
  return new Blob([buf], { type: 'audio/wav' });
}

const server = startServer();
let exitCode = 1;

try {
  if (!(await waitForServer())) {
    console.error(`server did not start on ${BASE}`);
    process.exit(1);
  }

  const dom = installDom();

  // Node's fetch keeps no cookie jar; the browser does.
  let cookie = '';
  const bare = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    const res = await bare(url.startsWith('http') ? url : BASE + url, { ...options, headers });
    for (const c of res.headers.getSetCookie?.() || []) cookie = c.split(';')[0];
    return res;
  };

  const login = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  console.log(`login                  -> ${login.status}, cookie ${cookie ? 'set' : 'MISSING'}`);

  console.error = () => {}; // the tab-module load failures are expected here
  const mod = await import(`${ROOT}/static/js/app.js?e2e=1`);
  await new Promise((r) => setTimeout(r, 400));

  const loginHidden = dom.get('login').hidden;
  const appHidden = dom.get('app').hidden;
  const badge = dom.text('platform-badge') || '';

  console.log(`login gate hidden      -> ${loginHidden}`);
  console.log(`app shown              -> ${!appHidden}`);
  console.log(`badge                  -> "${badge}"`);
  console.log(`config loaded          -> ${mod.state.config ? 'yes' : 'NO'}`);

  // A valid session must not produce another password prompt. This is the
  // regression that shipped.
  const gateOk = loginHidden && !appHidden;

  let cloneNote = 'unreachable';
  try {
    const form = new FormData();
    form.append('audio', enrollmentWav(), 'sample.wav');
    form.append('prefix', 'demo');
    form.append('target_model', 'cosyvoice-v3-flash');
    const res = await mod.api('/api/voices', { method: 'POST', body: form });
    cloneNote = `unexpected ${res.status}`;
  } catch (err) {
    const m = String(err.message);
    if (/InvalidApiKey|Status Code: 40/.test(m)) cloneNote = 'body parsed, reached DashScope';
    else if (/\[object Object\]|Field required/.test(m)) cloneNote = `MULTIPART BROKEN: ${m}`;
    else if (/需要登录/.test(m)) cloneNote = 'session cookie was not sent';
    else cloneNote = `unexpected: ${m}`;
  }
  console.log(`clone                  -> ${cloneNote}`);

  const configOk = Boolean(mod.state.config) && !/配置加载失败/.test(badge);
  const multipartOk = !/MULTIPART BROKEN|需要登录/.test(cloneNote);
  exitCode = gateOk && configOk && multipartOk ? 0 : 1;
  console.log(`\ngate=${gateOk} config=${configOk} multipart=${multipartOk}`);
  console.log(`RESULT: ${exitCode === 0 ? 'PASS' : 'FAIL'}`);
} finally {
  server.kill('SIGTERM');
}
process.exit(exitCode);