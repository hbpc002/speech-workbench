// Building the video timeline from a finished synthesis record.
//
// The arithmetic here is what makes the captions land on the spoken words, and
// it is invisible in the browser until a video is already rendering. Two things
// in particular are easy to get wrong and are pinned below: the base64 PCM
// length is bytes/2, not characters, and a silent sentence still advances the
// clock.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_PRESET,
  FPS,
  PRESETS,
  buildCues,
  buildTimeline,
  durationOf,
  extensionOf,
  fileNameFor,
  pickMimeType,
  presetOf,
  secondsOfPcm,
  splitForCaptions,
  activeTokenIndex,
  buildTokens,
  tokensRevealed,
} from '../../static/js/video_timeline.js';

/**
 * Base64 for `seconds` of silence at `rate`.
 *
 * The TTS tab actually stores `Int16Array`, which is covered separately; this
 * stays because the base64 path is still accepted and was the only one tested
 * when the dialog shipped dead.
 */
function pcmOf(seconds, rate = 22050) {
  return Buffer.alloc(Math.round(seconds * rate) * 2).toString('base64');
}

/** What a real record holds: the typed array IndexedDB hands back. */
function samplesOf(seconds, rate = 22050) {
  return new Int16Array(Math.round(seconds * rate));
}

describe('secondsOfPcm', () => {
  it('reads base64 as bytes, not as samples', () => {
    // 22050 samples of 16-bit mono is one second. Treating the string length
    // as a sample count would report half a second and halve every caption.
    assert.equal(secondsOfPcm(pcmOf(1)), 1);
  });

  it('reads an Int16Array record without throwing', () => {
    // Regression: the first implementation called `pcm.endsWith`, which only
    // exists on strings. Every real record is an Int16Array, so opening the
    // dialog threw before `showModal()` and the button looked dead.
    assert.equal(secondsOfPcm(samplesOf(1)), 1);
    assert.equal(secondsOfPcm(samplesOf(2, 24000), 24000), 2);
  });

  it('scales with the sample rate', () => {
    assert.equal(secondsOfPcm(pcmOf(1, 24000), 24000), 1);
  });

  it('handles padding without losing the last fraction', () => {
    // A length that is not a multiple of 3 gets `=` padding, and the naive
    // chars*3/4 estimate overcounts by up to two bytes.
    const pcm = Buffer.alloc(1001 * 2).toString('base64');
    assert.equal(secondsOfPcm(pcm).toFixed(4), (1001 / 22050).toFixed(4));
  });

  it('returns 0 for missing audio', () => {
    assert.equal(secondsOfPcm(null), 0);
    assert.equal(secondsOfPcm(''), 0);
    assert.equal(secondsOfPcm(undefined), 0);
  });

  it('returns 0 rather than Infinity without a sample rate', () => {
    assert.equal(secondsOfPcm(pcmOf(1), 0), 0);
  });
});

describe('splitForCaptions', () => {
  it('breaks on Chinese punctuation and keeps the mark', () => {
    assert.deepEqual(splitForCaptions('第一句话。第二句话！'), ['第一句话。', '第二句话！']);
  });

  it('breaks on a comma, which Chinese prose uses as a clause boundary', () => {
    assert.deepEqual(splitForCaptions('先说这个，再说那个。'), ['先说这个，', '再说那个。']);
  });

  it('hard-wraps a clause longer than the budget', () => {
    const long = '啊'.repeat(50);
    const pieces = splitForCaptions(long, 20);
    assert.equal(pieces.length, 3);
    assert.equal(pieces.join(''), long);
    for (const piece of pieces) assert.ok(piece.length <= 20);
  });

  it('prefers a space when wrapping mixed text', () => {
    // Cutting mid-word is worse than a slightly short line, so the last space
    // in the back half wins.
    const pieces = splitForCaptions('the quick brown fox jumps over the lazy dog', 20);
    for (const piece of pieces) {
      assert.ok(piece.length <= 20);
      assert.ok(!piece.startsWith(' '));
    }
    assert.equal(pieces.join(' ').replace(/\s+/g, ' '), 'the quick brown fox jumps over the lazy dog');
  });

  it('returns nothing for blank text', () => {
    assert.deepEqual(splitForCaptions(''), []);
    assert.deepEqual(splitForCaptions('   '), []);
    assert.deepEqual(splitForCaptions(null), []);
  });
});

describe('buildCues', () => {
  it('times a cue to the audio it covers', () => {
    const cues = buildCues(['你好。'], [2]);
    assert.equal(cues.length, 1);
    assert.equal(cues[0].start, 0);
    assert.equal(cues[0].end, 2);
    assert.equal(cues[0].text, '你好。');
  });

  it('advances the clock across sentences, so nothing drifts', () => {
    const cues = buildCues(['第一句。', '第二句。'], [1, 2]);
    assert.deepEqual(cues.map((c) => [c.start, c.end]), [
      [0, 1],
      [1, 3],
    ]);
  });

  it('splits one long sentence into several cues inside its own span', () => {
    // Three clauses of 20 characters each exceed the 42-character budget, so
    // this has to come out as more than one cue.
    const text = `${'甲'.repeat(20)}。${'乙'.repeat(20)}。${'丙'.repeat(20)}。`;
    const cues = buildCues([text], [3]);
    assert.ok(cues.length > 1, 'a three-clause sentence should not be one cue');
    assert.equal(cues[0].start, 0);
    assert.equal(cues.at(-1).end, 3);
    // Contiguous: the end of one cue is the start of the next.
    for (let i = 1; i < cues.length; i++) assert.equal(cues[i].start, cues[i - 1].end);
  });

  it('numbers cues from one', () => {
    const cues = buildCues(['甲。', '乙。'], [1, 1]);
    assert.deepEqual(cues.map((c) => c.index), [1, 2]);
  });

  it('keeps a silent sentence on the timeline', () => {
    // Dropping the row instead would pull every later caption forward by the
    // length of the gap, which is the one bug the viewer would definitely see.
    const cues = buildCues(['有声音。', '', '后面还有。'], [1, 1, 1]);
    assert.equal(cues.length, 2);
    assert.equal(cues[1].start, 2);
    assert.equal(cues[1].end, 3);
  });

  it('never emits a zero-length cue', () => {
    const cues = buildCues(['短。'], [0]);
    for (const cue of cues) assert.ok(cue.end > cue.start, JSON.stringify(cue));
  });

  it('joins Chinese pieces without a space', () => {
    const cues = buildCues(['你好世界'], [1]);
    assert.equal(cues[0].text, '你好世界');
  });

  it('respects the character budget', () => {
    const cues = buildCues(['甲'.repeat(80)], [4], { maxChars: 20, maxWords: 99 });
    for (const cue of cues) assert.ok(cue.text.length <= 20, cue.text);
  });

  it('produces nothing for no input', () => {
    assert.deepEqual(buildCues([], []), []);
  });
});

describe('buildTimeline', () => {
  it('sums the audio into a total duration', () => {
    const timeline = buildTimeline(
      [
        { text: '第一句。', pcm: pcmOf(1) },
        { text: '第二句。', pcm: pcmOf(2) },
      ],
      22050
    );
    assert.equal(timeline.duration, 3);
    assert.equal(timeline.cues.at(-1).end, 3);
  });

  it('sums an Int16Array record, which is what the tab actually stores', () => {
    const timeline = buildTimeline(
      [
        { text: '第一句。', pcm: samplesOf(1) },
        { text: '第二句。', pcm: samplesOf(2) },
      ],
      22050
    );
    assert.equal(timeline.duration, 3);
    assert.equal(timeline.cues.at(-1).end, 3);
  });

  it('leaves a sentence without audio out of the duration', () => {
    const timeline = buildTimeline([{ text: '还没生成。', pcm: null }], 22050);
    assert.equal(timeline.duration, 0);
    assert.deepEqual(timeline.cues, []);
  });

  it('tolerates a record with no sentences', () => {
    assert.deepEqual(buildTimeline([], 22050), { cues: [], duration: 0, sentences: [] });
    assert.deepEqual(buildTimeline(null, 22050), { cues: [], duration: 0, sentences: [] });
  });
});

describe('presets', () => {
  it('offers landscape, portrait and square', () => {
    assert.deepEqual(PRESETS.map((p) => p.id), ['16:9', '9:16', '1:1']);
  });

  it('falls back to the default for an unknown id', () => {
    assert.equal(presetOf('nope').id, DEFAULT_PRESET);
    assert.equal(presetOf(undefined).id, DEFAULT_PRESET);
  });

  it('keeps every preset an even pixel size, which video encoders expect', () => {
    for (const preset of PRESETS) {
      assert.equal(preset.width % 2, 0, preset.id);
      assert.equal(preset.height % 2, 0, preset.id);
    }
  });

  it('captures at a usable frame rate', () => {
    assert.ok(FPS >= 24);
  });
});

describe('durationOf', () => {
  it('formats minutes and seconds', () => {
    assert.equal(durationOf(0), '0:00');
    assert.equal(durationOf(9), '0:09');
    assert.equal(durationOf(61), '1:01');
    assert.equal(durationOf(600), '10:00');
  });

  it('rounds and clamps junk', () => {
    assert.equal(durationOf(-5), '0:00');
    assert.equal(durationOf(undefined), '0:00');
    assert.equal(durationOf(59.6), '1:00');
  });
});

describe('fileNameFor', () => {
  it('strips characters a filesystem would reject', () => {
    const name = fileNameFor('a/b:c*d?e"f<g>h|i');
    assert.ok(!/[\\/:*?"<>|]/.test(name.replace('语音视频-', '')), name);
  });

  it('keeps the text so the download is findable', () => {
    assert.match(fileNameFor('产品介绍'), /产品介绍/);
  });

  it('caps the stem so the name does not run off the screen', () => {
    const name = fileNameFor('字'.repeat(200));
    assert.ok(name.length < 90, name);
  });

  it('uses the requested extension', () => {
    assert.match(fileNameFor('x', 'mp4'), /\.mp4$/);
  });

  it('omits the stem when there is no text', () => {
    assert.match(fileNameFor('', 'webm', new Date(2026, 9, 24, 15, 30)), /^语音视频-20261024-1530\.webm$/);
  });
});

describe('pickMimeType', () => {
  it('takes the first type the browser supports', () => {
    assert.equal(pickMimeType((t) => t.startsWith('video/webm')), 'video/webm;codecs=vp9,opus');
  });

  it('falls through to mp4 for a browser without webm', () => {
    assert.equal(pickMimeType((t) => t === 'video/mp4'), 'video/mp4');
  });

  it('returns empty rather than throwing when nothing is supported', () => {
    assert.equal(pickMimeType(() => false), '');
  });

  it('survives a browser that throws on an unknown codec', () => {
    // Safari historically threw instead of returning false for vp9.
    assert.equal(
      pickMimeType((t) => {
        if (t.includes('vp9')) throw new Error('unknown codec');
        return t === 'video/webm';
      }),
      'video/webm'
    );
  });

  it('derives the extension from the chosen type', () => {
    assert.equal(extensionOf('video/webm;codecs=vp9,opus'), 'webm');
    assert.equal(extensionOf('video/mp4'), 'mp4');
    assert.equal(extensionOf(''), 'webm');
  });
});

describe('buildTokens', () => {
  it('gives every token a slice of the cue, in order', () => {
    const tokens = buildTokens('你好世界', 0, 4);
    assert.deepEqual(tokens.map((t) => t.word), ['你', '好', '世', '界']);
    assert.equal(tokens[0].start, 0);
    assert.equal(tokens.at(-1).end, 4);
  });

  it('keeps the tokens contiguous, so no sample of the cue is unreachable', () => {
    // A gap between tokens is time where karaoke highlights nothing mid-word.
    const tokens = buildTokens('第一句和第二句', 1, 4);
    for (let i = 1; i < tokens.length; i++) {
      assert.equal(tokens[i].start, tokens[i - 1].end, JSON.stringify(tokens));
    }
  });

  it('gives a long Latin word more time than a single CJK character', () => {
    const tokens = buildTokens('a international', 0, 10);
    const a = tokens.find((t) => t.word === 'a');
    const word = tokens.find((t) => t.word === 'international');
    assert.ok(word.end - word.start > a.end - a.start);
  });

  it('keeps a Latin run as one token instead of splitting per character', () => {
    // Splitting per character would make the highlight flicker across "hello".
    assert.deepEqual(buildTokens('hello world', 0, 2).map((t) => t.word), ['hello', 'world']);
  });

  it('produces nothing for text with no visible characters', () => {
    assert.deepEqual(buildTokens('', 0, 1), []);
    assert.deepEqual(buildTokens('   ', 0, 1), []);
    assert.deepEqual(buildTokens(null, 0, 1), []);
  });

  it('survives a zero-length cue without dividing by zero', () => {
    const tokens = buildTokens('甲乙', 2, 2);
    assert.equal(tokens.length, 2);
    for (const token of tokens) assert.equal(token.start, 2);
  });
});

describe('activeTokenIndex', () => {
  const tokens = buildTokens('甲乙丙', 0, 3);

  it('finds the token being spoken', () => {
    assert.equal(activeTokenIndex(tokens, 0.5), 0);
    assert.equal(activeTokenIndex(tokens, 1.5), 1);
    assert.equal(activeTokenIndex(tokens, 2.9), 2);
  });

  it('reports -1 outside the cue rather than clamping to an end token', () => {
    // Clamping would leave the last character highlighted during the pause
    // after the sentence.
    assert.equal(activeTokenIndex(tokens, -1), -1);
    assert.equal(activeTokenIndex(tokens, 3.5), -1);
    assert.equal(activeTokenIndex([], 0), -1);
    assert.equal(activeTokenIndex(null, 0), -1);
  });
});

describe('tokensRevealed', () => {
  const tokens = buildTokens('中文测试', 0, 4);

  it('reveals up to the active token', () => {
    assert.equal(tokensRevealed(tokens, 0.5), '中');
    assert.equal(tokensRevealed(tokens, 2.5), '中文测');
  });

  it('reveals nothing before the cue starts', () => {
    assert.equal(tokensRevealed(tokens, -1), '');
  });

  it('reveals the whole line once the cue is over', () => {
    // Word-by-word must not leave the last character permanently hidden.
    assert.equal(tokensRevealed(tokens, 9), '中文测试');
  });
});
