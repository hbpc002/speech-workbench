// Turning a finished synthesis record into a video timeline.
//
// There is no server-side renderer here on purpose: this app deploys to Vercel,
// where the function filesystem is read-only outside /tmp and there is no
// FFmpeg binary. So the "video generation" step composes in the browser --
// Canvas frames captured by MediaRecorder, with the already-synthesised PCM as
// the audio track. That is also why this module is pure: the interesting part
// is the timeline arithmetic, and none of it needs a GPU or a spawn.
//
// The cue layout follows `tools/subtitle/subtitle_gen.py` in
// hbpc002/openmontage-azure-tts (the FFmpeg/Remotion-free part of that
// project): words are packed into display cues within a word budget and a
// character budget, and each cue carries the start/end of the words it holds.

/** Frame sizes offered in the dialog, as [width, height]. */
export const PRESETS = [
  { id: '16:9', label: '横屏 16:9', width: 1280, height: 720 },
  { id: '9:16', label: '竖屏 9:16', height: 1280, width: 720 },
  { id: '1:1', label: '方形 1:1', width: 960, height: 960 },
];

export const DEFAULT_PRESET = '16:9';

/** Caption defaults, matching the reference tool's subtitle defaults. */
export const MAX_WORDS_PER_CUE = 8;
export const MAX_CHARS_PER_CUE = 42;

/** Video is captured at 30fps; MediaRecorder tolerates less but looks choppy. */
export const FPS = 30;

/** Audio pads shorter than this are not worth a cue. */
const MIN_CUE_SECONDS = 0.05;

/** Resolve a preset id to its dimensions, falling back to the default. */
export function presetOf(id) {
  return PRESETS.find((preset) => preset.id === id) || PRESETS.find((p) => p.id === DEFAULT_PRESET);
}

/**
 * Sample count of one sentence's PCM, or 0 when there is nothing usable.
 *
 * The TTS tab stores `Int16Array` (IndexedDB structured-clones it); a base64
 * string is accepted too because that is what the unit fixtures build, and the
 * two are cheap to tell apart. Treating the sample count as a byte count halves
 * every caption, which is the mistake this function exists to prevent.
 */
function samplesOf(pcm) {
  if (!pcm) return 0;
  if (typeof pcm === 'string') {
    // Base64 encodes 3 bytes per 4 characters, minus padding.
    const padding = pcm.endsWith('==') ? 2 : pcm.endsWith('=') ? 1 : 0;
    if (!pcm.length) return 0;
    return Math.max(0, Math.floor((pcm.length * 3) / 4) - padding) / 2;
  }
  // Typed arrays carry the sample count directly; the earlier version read
  // `.length` off a string only, so a real record threw
  // `pcm.endsWith is not a function` and the dialog never opened.
  return typeof pcm.length === 'number' ? pcm.length : 0;
}

/** Seconds of audio in one sentence. */
export function secondsOfPcm(pcm, sampleRate = 22050) {
  if (!sampleRate) return 0;
  return Math.max(0, samplesOf(pcm) / sampleRate);
}

/**
 * Split one sentence into caption-sized pieces.
 *
 * Sentences here are the synthesis unit, not a display unit: one can be a whole
 * paragraph, and a single caption holding all of it is unreadable. Chinese has
 * no spaces, so a naive word split cannot work -- the text is chunked on
 * punctuation first, then by character budget, and each chunk's share of the
 * sentence duration is apportioned by its character count. That keeps the
 * caption roughly in step with the audio, which is all that is needed when
 * there are no word-level timestamps to begin with.
 */
export function splitForCaptions(text, maxChars = MAX_CHARS_PER_CUE) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];

  // Punctuation ends a piece; the mark stays with the piece before it.
  const pieces = trimmed.match(/[^。！？；，、,.!?;]+[。！？；，、,.!?;]?/g) || [trimmed];
  const out = [];
  for (const piece of pieces) {
    const value = piece.trim();
    if (!value) continue;
    if (value.length <= maxChars) {
      out.push(value);
      continue;
    }
    // Still too long: hard-wrap. Mixing Latin text in means a run of spaces is
    // a better break than a mid-word cut, so prefer the last space when there
    // is one in the back half.
    let rest = value;
    while (rest.length > maxChars) {
      let cut = maxChars;
      const space = rest.lastIndexOf(' ', maxChars);
      if (space > maxChars / 2) cut = space;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

/**
 * Pack caption pieces into cues within the word and character budgets.
 *
 * This is the `_build_cues` shape from the reference tool, adapted to the fact
 * that a sentence here already has a known duration rather than per-word
 * timestamps.
 */
export function buildCues(sentenceTexts, sentenceSeconds, {
  maxWords = MAX_WORDS_PER_CUE,
  maxChars = MAX_CHARS_PER_CUE,
} = {}) {
  const cues = [];
  let clock = 0;

  sentenceTexts.forEach((text, index) => {
    const duration = Math.max(0, Number(sentenceSeconds[index]) || 0);
    const pieces = splitForCaptions(text, maxChars);
    if (!pieces.length) {
      // A silent or empty sentence still occupies its time on the timeline;
      // skipping the clock advance here would slide every later caption early.
      clock += duration;
      return;
    }

    // Weight each piece by its character count so a long piece is on screen
    // longer, which is the only signal available without word timings.
    const totalChars = pieces.reduce((sum, piece) => sum + piece.length, 0) || 1;
    let buffer = '';
    let bufferStart = clock;
    let bufferChars = 0;
    let bufferWords = 0;

    const flush = (endAt) => {
      if (!buffer) return;
      const start = bufferStart;
      const end = Math.max(endAt, start + MIN_CUE_SECONDS);
      cues.push({
        index: cues.length + 1,
        start: round(start),
        end: round(end),
        text: buffer,
      });
      buffer = '';
      bufferChars = 0;
      bufferWords = 0;
      bufferStart = end;
    };

    pieces.forEach((piece) => {
      const share = (piece.length / totalChars) * duration;
      const pieceEnd = clock + share;
      const words = piece.split(/\s+/).filter(Boolean).length || piece.length;
      const wouldExceed =
        buffer &&
        (bufferWords + words > maxWords || bufferChars + piece.length > maxChars);

      if (wouldExceed) flush(clock);
      if (!buffer) bufferStart = clock;
      buffer = buffer ? `${buffer}${needsSpace(buffer, piece) ? ' ' : ''}${piece}` : piece;
      bufferChars += piece.length;
      bufferWords += words;
      clock = pieceEnd;
    });

    // Ends at the sentence boundary, which `clock` now points at.
    flush(clock);
  });

  return cues;
}

/** Whether two pieces need a space between them when joined. */
function needsSpace(left, right) {
  // Only between two Latin runs: Chinese pieces butt together, and a space
  // between two CJK characters is just a visible gap.
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
}

/** Captions are compared and rendered at millisecond precision. */
function round(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * Lay out every sentence of a record on one timeline.
 *
 * `sentences` is `[{ text, pcm }]` in reading order, exactly as the TTS tab
 * stores them. Regenerating one sentence changes only its own duration, so the
 * later cues shift by exactly that much.
 */
export function buildTimeline(sentences, sampleRate = 22050, options = {}) {
  // Only sentences that actually have audio belong on the timeline: a record
  // can be half-generated, and a caption for a sentence with no sound behind it
  // would sit a cue over a gap of silence.
  const rows = (sentences || [])
    .map((sentence) => ({
      text: sentence?.text || '',
      seconds: secondsOfPcm(sentence?.pcm, sampleRate),
    }))
    .filter((row) => row.seconds > 0);
  const cues = buildCues(
    rows.map((row) => row.text),
    rows.map((row) => row.seconds),
    options
  );
  const duration = rows.reduce((sum, row) => sum + row.seconds, 0);
  return { cues, duration: round(duration), sentences: rows };
}

/** `mm:ss` for a duration, for the dialog's summary line. */
export function durationOf(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * A filename stem that survives every filesystem.
 *
 * The title comes from the record's text, which is arbitrary user prose: `/`,
 * `:` and newlines are all legal in the text and not in a filename.
 */
export function fileNameFor(text, extension = 'webm', now = new Date()) {
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate()
  ).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(
    2,
    '0'
  )}`;
  const stem = String(text || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return `语音视频-${stem ? `${stem}-` : ''}${stamp}.${extension}`;
}

/**
 * Which container to ask MediaRecorder for.
 *
 * Safari shipped MediaRecorder only with MP4 support for a long time, and
 * Chrome prefers WebM; asking for a type the browser cannot produce makes
 * `new MediaRecorder` throw, so the first supported candidate wins.
 */
export const RECORDER_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
];

/** The first mime type `isSupported` accepts, or '' when none do. */
export function pickMimeType(isSupported) {
  for (const type of RECORDER_TYPES) {
    try {
      if (isSupported(type)) return type;
    } catch (_) {
      // Some browsers throw on an unknown codec instead of returning false.
    }
  }
  return '';
}

/** Extension implied by a mime type. */
export function extensionOf(mimeType) {
  return String(mimeType || '').includes('mp4') ? 'mp4' : 'webm';
}
