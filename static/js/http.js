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

/**
 * `options.headers` wins outright, so a caller can set or omit Content-Type.
 *
 * FormData must NOT be labelled application/json: the browser only appends the
 * multipart boundary when it owns the header.
 */
export async function api(path, options = {}) {
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers = { ...(isForm ? {} : { 'Content-Type': 'application/json' }), ...options.headers };
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    throw new Error(await errorDetail(response));
  }
  return response.json();
}

/**
 * Turn an error body into one line of text.
 *
 * A validation failure arrives as `[{loc, msg, type}, ...]`. The `body` segment
 * of the location is dropped because "body.audio" reads as noise next to the
 * field name.
 */
export async function errorDetail(response) {
  const fallback = `HTTP ${response.status}`;
  let body;
  try {
    body = await response.json();
  } catch (_) {
    /* non-JSON error body */
    return fallback;
  }
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