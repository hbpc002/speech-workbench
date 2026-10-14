// WAV wrapping and PCM assembly.
//
// The regression worth guarding: `pcmToWavBlob` takes a *list* of chunks, and
// handing it a bare Int16Array produced a valid-looking 44-byte WAV containing
// digital silence -- no error, no warning, and DashScope would have enrolled it
// into a useless voice.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Blob only exists in a browser; the header math is what is under test.
globalThis.Blob = class {
  constructor(parts) {
    this.parts = parts;
    this.size = parts.reduce((n, p) => n + (p.byteLength ?? p.length ?? 0), 0);
  }
};

const { concatInt16, pcmToWavBlob } = await import('../../static/js/audio.js');

const HEADER = 44;

function readHeader(blob) {
  const view = new DataView(blob.parts[0].buffer || blob.parts[0]);
  const text = (at, len) =>
    Array.from({ length: len }, (_, i) => String.fromCharCode(view.getUint8(at + i))).join('');
  return {
    riff: text(0, 4),
    wave: text(8, 4),
    fmt: text(12, 4),
    data: text(36, 4),
    sampleRate: view.getUint32(24, true),
    channels: view.getUint16(22, true),
    bits: view.getUint16(34, true),
    dataBytes: view.getUint32(40, true),
  };
}

describe('concatInt16', () => {
  it('joins chunks in order', () => {
    const out = concatInt16([new Int16Array([1, 2]), new Int16Array([3])]);
    assert.deepEqual([...out], [1, 2, 3]);
  });

  it('returns an empty buffer for no chunks', () => {
    assert.equal(concatInt16([]).length, 0);
  });
});

describe('pcmToWavBlob', () => {
  it('writes a valid RIFF/WAVE header', () => {
    const head = readHeader(pcmToWavBlob([new Int16Array(16000)], 16000));
    assert.equal(head.riff, 'RIFF');
    assert.equal(head.wave, 'WAVE');
    assert.equal(head.fmt, 'fmt ');
    assert.equal(head.data, 'data');
    assert.equal(head.sampleRate, 16000);
    assert.equal(head.channels, 1);
    assert.equal(head.bits, 16);
  });

  it('records the sample count in the header', () => {
    const pcm = new Int16Array(8000).fill(1234);
    const blob = pcmToWavBlob([pcm], 16000);
    assert.equal(readHeader(blob).dataBytes, 16000);
    assert.equal(blob.size, HEADER + 16000);
  });

  it('accepts several chunks and concatenates them', () => {
    const blob = pcmToWavBlob([new Int16Array(4), new Int16Array(6)], 22050);
    assert.equal(readHeader(blob).dataBytes, 20);
  });

  it('accepts a bare Int16Array as a single chunk', () => {
    // The silent regression: passing the array directly used to iterate its
    // numbers, get an undefined length, and emit a header-only "WAV".
    const pcm = new Int16Array(16000).fill(1000);
    const blob = pcmToWavBlob(pcm, 16000);
    assert.equal(blob.size, HEADER + pcm.length * 2);
    assert.equal(readHeader(blob).dataBytes, pcm.length * 2);
  });

  it('preserves the samples themselves', () => {
    const pcm = new Int16Array([1, -1, 32767, -32768]);
    const blob = pcmToWavBlob(pcm, 16000);
    const view = new Int16Array(blob.parts[0], HEADER, 4);
    assert.deepEqual([...view], [1, -1, 32767, -32768]);
  });

  it('defaults to 22050 Hz', () => {
    assert.equal(readHeader(pcmToWavBlob([new Int16Array(2)])).sampleRate, 22050);
  });
});