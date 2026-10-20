// JSON/FormData request helper and error-message formatting.
//
// Its own module, re-exported by app.js, for one reason: app.js runs `boot()`
// at import time and touches `document`, so nothing in it can be imported under
// `node --test`. Every other module here that needed testing was extracted for
// the same reason -- see static/js/actions.js and clip_check.js.
//
// The two behaviours below are both regressions that fail silently, which is
// why they live here rather than being inlined at the call site:
//
//   * labelling a FormData body application/json strips the multipart boundary,
//     so FastAPI cannot parse it and answers 422 instead of running the handler
//   * FastAPI's 422 carries `detail` as a *list*; `new Error(list)` stringifies
//     to "[object Object]", which tells the operator nothing

import { command, error as logError, ok } from './debug_log.js';

/**
 * `options.headers` wins outright, so a caller can set or omit Content-Type.
 *
 * FormData must NOT be labelled application/json: the browser only appends the
 * multipart boundary when it owns the header.
 */
export async function api(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const started = Date.now();
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers = { ...(isForm ? {} : { 'Content-Type': 'application/json' }), ...options.headers };

  command(`${method} ${path}`);

  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch (error) {
    const elapsed = Date.now() - started;
    // Query strings and bodies are intentionally absent: an API key belongs in
    // a header, and logging the body would duplicate the audio blob.
    logError(`${method} ${path} 请求失败 (${elapsed}ms)`, {
      message: error?.message || String(error),
      name: error?.name || 'Error',
    });
    throw error;
  }

  const elapsed = Date.now() - started;
  if (!response.ok) {
    const payload = await errorPayload(response);
    const err = new Error(payload.message);
    err.status = response.status;
    err.debug = payload.debug;
    err.method = method;
    err.path = path;
    logError(`${method} ${path} -> ${response.status} (${elapsed}ms)`, {
      status: response.status,
      message: payload.message,
      upstream: payload.debug,
    });
    throw err;
  }

  try {
    const body = await response.json();
    ok(`${method} ${path} -> ${response.status} (${elapsed}ms)`);
    return body;
  } catch (error) {
    logError(`${method} ${path} -> ${response.status} 响应不是 JSON`, {
      status: response.status,
      message: error?.message || String(error),
    });
    throw error;
  }
}

/**
 * Turn an error body into one line of text plus its optional debug payload.
 *
 * A validation failure arrives as `[{loc, msg, type}, ...]`. The `body` segment
 * of the location is dropped because "body.audio" reads as noise next to the
 * field name.
 */
export async function errorPayload(response) {
  const fallback = `HTTP ${response.status}`;
  let body;
  try {
    body = await response.json();
  } catch (_) {
    /* non-JSON error body */
    return { message: fallback, debug: null };
  }
  return { message: messageFromBody(body, fallback), debug: body?.debug ?? null };
}

export async function errorDetail(response) {
  return (await errorPayload(response)).message;
}

function messageFromBody(body, fallback) {
  const detail = body?.detail ?? body?.message;
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => {
        const field = Array.isArray(item?.loc)
          ? item.loc.filter((part) => part !== 'body').join('.')
          : '';
        const msg = item?.msg || item?.type || '';
        return field ? `${field}: ${msg}` : msg;
      })
      .filter(Boolean);
    if (parts.length) return parts.join('；');
  }
  return fallback;
}
