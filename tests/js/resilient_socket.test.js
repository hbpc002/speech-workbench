import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    FakeWebSocket.instances.push(this);
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: 'done', wasClean: true });
  }
}

globalThis.location = { protocol: 'https:', host: 'example.test' };
globalThis.WebSocket = FakeWebSocket;

const { ResilientSocket } = await import('../../static/js/audio.js');

describe('ResilientSocket', () => {
  it('connects, sends, and reports close code and reason', () => {
    FakeWebSocket.instances.length = 0;
    const statuses = [];
    const closes = [];
    const opens = [];
    const socket = new ResilientSocket('/ws/tts', {
      onOpen: () => opens.push(true),
      onStatus: (status) => statuses.push(status),
      onClose: (info) => closes.push(info),
    });

    socket.open();
    const ws = FakeWebSocket.instances[0];
    assert.equal(ws.url, 'wss://example.test/ws/tts');

    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen();
    assert.deepEqual(opens, [true]);
    assert.deepEqual(statuses, ['connected']);
    assert.equal(socket.send({ type: 'tts.synthesize' }), true);
    assert.deepEqual(JSON.parse(ws.sent[0]), { type: 'tts.synthesize' });

    socket.close();
    assert.deepEqual(closes, [{ code: 1000, reason: 'done', wasClean: true }]);
    assert.deepEqual(statuses, ['connected', 'closed']);
  });
});
