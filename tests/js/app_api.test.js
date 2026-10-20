// Request/response plumbing shared by every tab.
//
// Two regressions live here, both of which fail silently:
//
//   * labelling a FormData body application/json strips the multipart
//     boundary, so FastAPI cannot parse it and answers 422
//   * FastAPI's 422 carries `detail` as a *list*, and `new Error(list)`
//     stringifies to "[object Object]"
//
// Imports static/js/http.js, not app.js: app.js runs boot() at module scope and
// touches document, so it cannot be imported here. That indirection is the whole
// reason http.js exists.
//
// fetch is stubbed per case so each one can assert on what went over the wire.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { clear, snapshot } from '../../static/js/debug_log.js';
import { api, errorDetail } from '../../static/js/http.js';

const realFetch = globalThis.fetch;

beforeEach(() => clear());

/** Records the request and replies with whatever the test queued. */
function stubFetch(response) {
  const seen = {};
  globalThis.fetch = async (url, options) => {
    seen.url = url;
    seen.options = options;
    return response;
  };
  return seen;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('api', () => {
  it('returns the parsed body on success', async () => {
    stubFetch(jsonResponse(200, { ok: true }));
    assert.deepEqual(await api('/api/config'), { ok: true });
  });

  it('labels a JSON body application/json', async () => {
    const seen = stubFetch(jsonResponse(200, {}));
    await api('/api/voices/x', { method: 'POST', body: JSON.stringify({ a: 1 }) });
    assert.equal(seen.options.headers['Content-Type'], 'application/json');
  });

  it('does NOT label FormData as JSON', async () => {
    // The whole point: the browser must own this header to append the
    // multipart boundary. Overriding it yields a body FastAPI cannot parse.
    const seen = stubFetch(jsonResponse(200, {}));
    const form = new FormData();
    form.append('prefix', 'demo');
    await api('/api/voices', { method: 'POST', body: form });
    assert.equal(seen.options.headers['Content-Type'], undefined);
  });

  it('sends the FormData instance itself, untouched', async () => {
    const seen = stubFetch(jsonResponse(200, {}));
    const form = new FormData();
    form.append('prefix', 'demo');
    await api('/api/voices', { method: 'POST', body: form });
    assert.equal(seen.options.body, form);
  });

  it('lets the caller override the header', async () => {
    const seen = stubFetch(jsonResponse(200, {}));
    await api('/x', { headers: { 'Content-Type': 'text/plain' }, body: 'hi' });
    assert.equal(seen.options.headers['Content-Type'], 'text/plain');
  });

  it('returns the response body on success even with no explicit method', async () => {
    stubFetch(jsonResponse(200, { voices: [] }));
    assert.deepEqual(await api('/api/voices'), { voices: [] });
  });
});

describe('debug log integration', () => {
  it('logs the command and the success line', async () => {
    stubFetch(jsonResponse(200, { ok: true }));
    await api('/api/voices');
    const entries = snapshot();
    assert.equal(entries[0].level, 'cmd');
    assert.equal(entries[0].message, 'GET /api/voices');
    assert.equal(entries[1].level, 'ok');
    assert.match(entries[1].message, /GET \/api\/voices -> 200/);
  });

  it('attaches status and the server debug payload to the thrown error', async () => {
    stubFetch(
      jsonResponse(502, {
        detail: '音色复刻失败：千问上游异常；详情见「日志」',
        debug: { request_id: 'req-500', operation: 'create_voice' },
      })
    );

    await assert.rejects(
      () => api('/api/voices', { method: 'POST' }),
      (err) => {
        assert.equal(err.status, 502);
        assert.equal(err.method, 'POST');
        assert.deepEqual(err.debug, { request_id: 'req-500', operation: 'create_voice' });
        return true;
      }
    );

    const failed = snapshot().find((entry) => entry.level === 'error');
    assert.ok(failed);
    assert.equal(failed.detail.status, 502);
    assert.equal(failed.detail.upstream.request_id, 'req-500');
  });

  it('logs a transport failure without pretending it was an HTTP status', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    await assert.rejects(() => api('/api/voices'));
    const failed = snapshot().find((entry) => entry.level === 'error');
    assert.ok(failed);
    assert.match(failed.message, /请求失败/);
    assert.equal(failed.detail.status, undefined);
  });
});

describe('error messages', () => {
  it('passes a string detail through', async () => {
    stubFetch(jsonResponse(502, { detail: '音色复刻失败: boom' }));
    await assert.rejects(() => api('/api/voices'), /音色复刻失败: boom/);
  });

  it('renders a FastAPI validation list instead of [object Object]', async () => {
    // This is the exact shape of the regression: `detail` is a list, and
    // `new Error([...])` stringifies to "[object Object]".
    stubFetch(
      jsonResponse(422, {
        detail: [{ type: 'missing', loc: ['body', 'audio'], msg: 'Field required', input: null }],
      })
    );
    await assert.rejects(() => api('/api/voices'), (err) => {
      assert.doesNotMatch(err.message, /\[object Object\]/);
      assert.match(err.message, /audio/);
      assert.match(err.message, /Field required/);
      return true;
    });
  });

  it('drops the body segment from the field path', async () => {
    stubFetch(
      jsonResponse(422, {
        detail: [{ type: 'missing', loc: ['body', 'target_model'], msg: 'Field required' }],
      })
    );
    await assert.rejects(() => api('/api/voices'), /target_model: Field required/);
  });

  it('joins several violations', async () => {
    stubFetch(
      jsonResponse(422, {
        detail: [
          { type: 'missing', loc: ['body', 'audio'], msg: 'Field required' },
          { type: 'missing', loc: ['body', 'prefix'], msg: 'Field required' },
        ],
      })
    );
    await assert.rejects(() => api('/api/voices'), /audio.*prefix/);
  });

  it('falls back to the status when detail is an empty list', async () => {
    stubFetch(jsonResponse(500, { detail: [] }));
    await assert.rejects(() => api('/api/voices'), (e) => e.message === 'HTTP 500');
  });

  it('falls back to the status for a non-JSON body', async () => {
    stubFetch({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    });
    await assert.rejects(() => api('/api/voices'), (e) => e.message === 'HTTP 502');
  });

  it('accepts a message field as well as detail', async () => {
    stubFetch(jsonResponse(400, { message: 'nope' }));
    await assert.rejects(() => api('/api/voices'), /nope/);
  });
});