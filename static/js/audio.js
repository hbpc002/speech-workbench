// Shared browser-side audio plumbing: microphone capture, PCM playback,
// WAV encoding for voice cloning, and a reconnecting WebSocket wrapper.
//
// The AudioWorklet processor itself is the one shipped in
// samples/gallery/paraformer-realtime-js/recorder_worklet.js, copied verbatim so
// the two demos stay comparable.

export const INPUT_SAMPLE_RATE = 16000;

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Captures microphone audio as 16 kHz mono 16-bit PCM, 100 ms per chunk. */
export class MicRecorder {
  constructor(onChunk) {
    this.onChunk = onChunk;
    this.stream = null;
    this.context = null;
    this.node = null;
    this.source = null;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: INPUT_SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    this.context = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: INPUT_SAMPLE_RATE,
    });
    await this.context.audioWorklet.addModule('/static/js/recorder_worklet.js');

    this.source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, 'pcm-processor');
    this.node.port.onmessage = (event) => {
      if (event.data instanceof Int16Array) this.onChunk(event.data);
    };
    this.source.connect(this.node);
    // Worklet needs a sink to stay alive, but must not echo the mic to speakers.
    const mute = this.context.createGain();
    mute.gain.value = 0;
    this.node.connect(mute);
    mute.connect(this.context.destination);
  }

  stop() {
    if (this.node) {
      this.node.port.postMessage('stop');
      this.node.disconnect();
      this.node = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.context) {
      this.context.close();
      this.context = null;
    }
  }
}

/**
 * Gapless PCM playback.
 *
 * Buffers are scheduled back to back against a running `nextStartTime` rather
 * than started on arrival, otherwise every chunk boundary is audible. Same
 * approach as the player in
 * samples/conversation/fun-audiochat-realtime/demo_app/web/index.html.
 */
export class PcmPlayer {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.context = null;
    this.nextStartTime = 0;
    this.active = new Set();
  }

  ensureContext() {
    if (!this.context || this.context.state === 'closed') {
      this.context = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: this.sampleRate,
      });
    }
    if (this.context.state === 'suspended') this.context.resume();
    return this.context;
  }

  async resume() {
    const context = this.ensureContext();
    if (context.state === 'suspended') await context.resume();
  }

  push(int16Array) {
    const context = this.ensureContext();
    const buffer = context.createBuffer(1, int16Array.length, this.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < int16Array.length; i++) channel[i] = int16Array[i] / 32768;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    const startAt = Math.max(context.currentTime, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;

    this.active.add(source);
    source.onended = () => {
      this.active.delete(source);
      source.disconnect();
    };
  }

  /** Drop everything queued and silence what is already playing (barge-in). */
  clear() {
    for (const source of this.active) {
      try {
        source.stop();
      } catch (_) {
        /* already finished */
      }
      source.disconnect();
    }
    this.active.clear();
    if (this.context) this.nextStartTime = 0;
  }

  close() {
    this.clear();
    if (this.context) {
      this.context.close();
      this.context = null;
    }
  }
}

/** Records the browser microphone into a 16 kHz mono WAV blob for cloning. */
export class VoiceClipRecorder {
  constructor(targetSeconds = 10, onLevel = () => {}) {
    this.targetSamples = targetSeconds * INPUT_SAMPLE_RATE;
    this.collected = [];
    this.collectedSamples = 0;
    this.onLevel = onLevel;
    this.context = null;
    this.node = null;
    this.source = null;
    this.stream = null;
    this.analyser = null;
    this.levelTimer = null;
  }

  async start() {
    this.collected = [];
    this.collectedSamples = 0;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: INPUT_SAMPLE_RATE, channelCount: 1, echoCancellation: true },
    });
    this.context = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: INPUT_SAMPLE_RATE,
    });
    await this.context.audioWorklet.addModule('/static/js/recorder_worklet.js');

    this.source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, 'pcm-processor');
    this.node.port.onmessage = (event) => {
      if (!(event.data instanceof Int16Array)) return;
      const remaining = this.targetSamples - this.collectedSamples;
      if (remaining <= 0) return;
      const take = remaining >= event.data.length ? event.data : event.data.slice(0, remaining);
      this.collected.push(take);
      this.collectedSamples += take.length;
    };
    this.source.connect(this.node);
    const mute = this.context.createGain();
    mute.gain.value = 0;
    this.node.connect(mute);
    mute.connect(this.context.destination);

    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.source.connect(this.analyser);
    const samples = new Float32Array(this.analyser.fftSize);
    this.levelTimer = setInterval(() => {
      this.analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      this.onLevel(Math.sqrt(sum / samples.length));
    }, 100);
  }

  get seconds() {
    return this.collectedSamples / INPUT_SAMPLE_RATE;
  }

  get isFull() {
    return this.collectedSamples >= this.targetSamples;
  }

  /**
   * The raw captured PCM, so callers can inspect or trim it before it is
   * wrapped in a WAV header. Copying is not necessary: `collected` is reset by
   * start() and this array is never mutated afterwards.
   */
  samples() {
    return concatInt16(this.collected);
  }

  async stop() {
    if (this.levelTimer) clearInterval(this.levelTimer);
    if (this.node) {
      this.node.disconnect();
      this.node = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    return this.toWavBlob();
  }

  /** Wraps the raw PCM in a 44-byte RIFF header. */
  toWavBlob() {
    const total = this.collected.reduce((n, c) => n + c.length, 0);
    const pcm = new Int16Array(total);
    let offset = 0;
    for (const chunk of this.collected) {
      pcm.set(chunk, offset);
      offset += chunk.length;
    }

    const buffer = new ArrayBuffer(44 + pcm.length * 2);
    const view = new DataView(buffer);
    const writeText = (at, text) => {
      for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
    };

    writeText(0, 'RIFF');
    view.setUint32(4, 36 + pcm.length * 2, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, INPUT_SAMPLE_RATE, true);
    view.setUint32(28, INPUT_SAMPLE_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, 'data');
    view.setUint32(40, pcm.length * 2, true);

    new Int16Array(buffer, 44).set(pcm);
    return new Blob([buffer], { type: 'audio/wav' });
  }
}

/**
 * WebSocket with exponential backoff.
 *
 * Vercel Hobby caps a function at 300 s, so for tab 1 the upstream DashScope
 * session dies every five minutes. `onReconnect` is where the tab replays its
 * transcript to rebuild context.
 */
export class ResilientSocket {
  constructor(path, { onOpen, onMessage, onBinary, onClose, onStatus } = {}) {
    this.path = path;
    this.onOpen = onOpen || (() => {});
    this.onMessage = onMessage || (() => {});
    this.onBinary = onBinary || (() => {});
    this.onClose = onClose || (() => {});
    this.onStatus = onStatus || (() => {});
    this.socket = null;
    this.delay = 1000;
    this.wantOpen = false;
    this.reconnectCount = 0;
    this._openWaiters = [];
  }

  open() {
    this.wantOpen = true;
    this._connect();
  }

  /** Resolves once the socket is OPEN; a send before that is silently dropped. */
  whenOpen() {
    if (this.socket && this.socket.readyState === 1) return Promise.resolve();
    return new Promise((resolve) => this._openWaiters.push(resolve));
  }

  _flushOpenWaiters() {
    const waiters = this._openWaiters;
    this._openWaiters = [];
    for (const resolve of waiters) resolve();
  }

  _connect() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}${this.path}`);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.delay = 1000;
      this.onStatus('connected');
      this._flushOpenWaiters();
      this.onOpen(this.reconnectCount > 0);
    };
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') this.onMessage(event.data);
      else this.onBinary(event.data);
    };
    socket.onclose = () => {
      if (!this.wantOpen) {
        this.onStatus('closed');
        return;
      }
      this.reconnectCount += 1;
      this.onStatus('reconnecting');
      setTimeout(() => this._connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 15000);
    };
    socket.onerror = () => socket.close();
  }

  send(payload) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  close() {
    this.wantOpen = false;
    this.reconnectCount = 0;
    this._flushOpenWaiters();
    if (this.socket) this.socket.close();
  }
}

export { arrayBufferToBase64, base64ToArrayBuffer };
/**
 * Splits text into sentences on Chinese and ASCII terminators.
 *
 * Long text is generated one sentence at a time so any single sentence can be
 * re-generated without touching the rest, and the pieces are stitched back
 * together on download.
 */
export function splitSentences(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  // Keep the terminator attached to its sentence; split on lookbehind.
  const parts = trimmed.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [trimmed];
  const sentences = parts.map((s) => s.trim()).filter((s) => s.length > 0);
  if (!sentences.length) return [trimmed];
  return sentences;
}

/** Concatenates Int16Array PCM chunks into a single contiguous buffer. */
export function concatInt16(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Wraps Int16 PCM in a 44-byte RIFF/WAVE header.
 *
 * Downloads always go through here, which is why a partially regenerated
 * document still exports as one complete file: the segments are reassembled
 * into a single PCM buffer before the header is written.
 */
export function pcmToWavBlob(chunks, sampleRate = 22050) {
  const pcm = chunks.length === 1 && chunks[0] instanceof Int16Array
    ? chunks[0]
    : concatInt16(chunks);

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
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, pcm.length * 2, true);

  new Int16Array(buffer, 44).set(pcm);
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Triggers a browser download for a blob. */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Decodes any audio file the browser understands and renders it as 16 kHz mono
 * PCM, which is what DashScope's enrollment endpoint wants.
 *
 * Two reasons this exists rather than posting the file as-is:
 *   - the old code hardcoded a `.wav` filename on whatever the user picked, so
 *     an mp3 was presented as a wav and the server's format check was a fiction
 *   - stereo or 48 kHz sources are not what the endpoint documents, and
 *     resampling here means the quality check sees the same samples the server
 *     will get, not the ones the browser happened to decode
 *
 * OfflineAudioContext does the resampling, so there is no hand-rolled filter to
 * get wrong.
 */
export async function decodeToPcm16k(blob) {
  const source = await blob.arrayBuffer();
  const context = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try {
    decoded = await context.decodeAudioData(source);
  } finally {
    await context.close();
  }

  const sourceSampleRate = decoded.sampleRate;
  const sourceChannels = decoded.numberOfChannels;
  const needsResample = sourceSampleRate !== INPUT_SAMPLE_RATE || sourceChannels !== 1;

  let rendered = decoded;
  if (needsResample) {
    const frames = Math.max(1, Math.ceil((decoded.duration * INPUT_SAMPLE_RATE)));
    const offline = new OfflineAudioContext(1, frames, INPUT_SAMPLE_RATE);
    const sourceNode = offline.createBufferSource();
    sourceNode.buffer = decoded;
    sourceNode.connect(offline.destination);
    sourceNode.start();
    rendered = await offline.startRendering();
  }

  return {
    samples: floatToInt16(rendered.getChannelData(0)),
    seconds: rendered.duration,
    sourceSampleRate,
    sourceChannels,
    wasResampled: needsResample,
  };
}

/** Float samples in -1..1 to Int16, which is what every other helper here uses. */
export function floatToInt16(source) {
  const out = new Int16Array(source.length);
  for (let i = 0; i < source.length; i++) {
    const clamped = Math.max(-1, Math.min(1, source[i]));
    out[i] = Math.round(clamped * 32767);
  }
  return out;
}

/**
 * IndexedDB stores for generated audio.
 *
 * localStorage is not an option: a single ~1 s sentence is ~45 KB of PCM, so a
 * handful of segments would blow the 5 MB string quota.
 *
 * Each generated run is one record holding its own sentence list, so history
 * survives a refresh and nothing is ever overwritten in place.
 *
 * One module owns the database. Two openers disagreeing about the version
 * number is the classic way to end up with a store that exists in one tab and
 * not the next, so the store list lives here rather than at the call sites.
 */
const DB_NAME = 'speech-workbench';
const DB_VERSION = 2;
const STORES = ['tts-records', 'voice-previews', 'voice-clones'];

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!request.result.objectStoreNames.contains(name)) {
          request.result.createObjectStore(name, { keyPath: 'id' });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(storeName, mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const request = run(transaction.objectStore(storeName));
        transaction.oncomplete = () => resolve(request && request.result);
        transaction.onerror = () => reject(transaction.error);
      })
  );
}

/**
 * Records are read newest-first. `sortKey` lets the clone log order by
 * attempt time while the preview history orders by playback.
 */
function newestFirst(rows, sortKey = 'createdAt') {
  return (rows || []).sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0));
}

/** One generic pair per store; the tab code reads better with named exports. */
const saveIn = (name) => (record) => {
  // Structured clone handles the nested Int16Array, so PCM round-trips intact.
  return tx(name, 'readwrite', (store) => store.put(record));
};
const loadFrom = (name, sortKey) =>
  () => tx(name, 'readonly', (store) => store.getAll()).then((rows) => newestFirst(rows, sortKey));
const removeFrom = (name) => (id) => tx(name, 'readwrite', (store) => store.delete(id));
const clearStore = (name) => () => tx(name, 'readwrite', (store) => store.clear());

export const saveTtsRecord = saveIn('tts-records');
export const loadTtsRecords = loadFrom('tts-records');
export const deleteTtsRecord = removeFrom('tts-records');
export const clearTtsRecords = clearStore('tts-records');

export const saveVoicePreview = saveIn('voice-previews');
export const loadVoicePreviews = loadFrom('voice-previews');
export const deleteVoicePreview = removeFrom('voice-previews');
export const clearVoicePreviews = clearStore('voice-previews');

export const saveVoiceClone = saveIn('voice-clones');
export const loadVoiceClones = loadFrom('voice-clones', 'attemptedAt');
export const deleteVoiceClone = removeFrom('voice-clones');
export const clearVoiceClones = clearStore('voice-clones');

/** Stable id for one sentence inside one record. */
export function segmentKey(recordId, index) {
  return `${recordId}:${index}`;
}
