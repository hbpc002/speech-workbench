// The two things every module needs from the shell: an element lookup and the
// shared runtime state.
//
// Split out of app.js for one reason: importing app.js *boots the page* -- it
// calls boot() at module scope, which touches document and fires requests. That
// is why app.js's own helpers could not be unit-tested, why http.js had to be
// carved out for api(), and why a module as ordinary as the AI tag dialog could
// not be imported under `node --test` at all: one helper in the wrong file and
// the tests are impossible again.
//
// app.js re-exports both, so every tab keeps importing from the same place.

export const state = {
  config: null,
  prompts: null,
};

export function el(id) {
  return document.getElementById(id);
}