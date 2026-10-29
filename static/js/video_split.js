// Pure scene helpers for the short-video tab.
//
// Split out of tab_video.js so `node --test` can import them: everything else
// in that file imports `/static/js/app.js` by absolute URL, which only a
// browser resolves. Same reason actions.js and clip_check.js exist.

export const MAX_SCENES = 20;

/** Split a script into scenes of at most ~60 characters, on sentence marks. */
export function splitLocal(script) {
  const pieces = String(script || '')
    .replace(/\r\n/g, '\n')
    .split(/(?<=[。！？!?；;\n])/)
    .map((part) => part.trim())
    .filter(Boolean);
  const out = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length > 60) {
      out.push(current);
      current = piece;
    } else {
      current += piece;
    }
  }
  if (current) out.push(current);
  return out.slice(0, MAX_SCENES);
}

/** "city night, 咖啡 pouring" -> ["city night", "咖啡 pouring"], max 4. */
export function textToTerms(text) {
  return String(text || '')
    .split(/[,，、;；\n]/)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 4);
}

/** Inverse of textToTerms, for the scene input's value. */
export function termsToText(terms) {
  return (terms || []).join(', ');
}
