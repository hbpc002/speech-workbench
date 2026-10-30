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

/** Concatenate Int16Array chunks. */
function concatInt16(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Int16Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return joined;
}

/**
 * Encode 16-bit mono PCM as a WAV Blob.
 *
 * Copied from audio.js rather than imported: audio.js is the whole playback and
 * IndexedDB layer, and this tab only needs the 25-line encoder. The short-video
 * upload sends the record's own PCM through this, so the renderer receives the
 * exact audio the user already heard.
 */
export function pcmToWavBlob(chunks, sampleRate = 22050) {
  const list = chunks instanceof Int16Array ? [chunks] : chunks;
  const pcm = list.length === 1 && list[0] instanceof Int16Array ? list[0] : concatInt16(list);
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const writeText = (at, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(at + i, str.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  new Int16Array(buffer, 44).set(pcm);
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Inverse of textToTerms, for the scene input's value. */
export function termsToText(terms) {
  return (terms || []).join(', ');
}
