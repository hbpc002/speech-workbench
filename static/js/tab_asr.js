// Tab 2 - realtime speech recognition.

import { MicRecorder, ResilientSocket, arrayBufferToBase64 } from '/static/js/audio.js';
import { appendMsg, applySocketStatus, el, log, updateMsg } from '/static/js/app.js';

let socket = null;
let recorder = null;
let recording = false;
let currentNode = null;

function start() {
  const params = new URLSearchParams({ language: el('asr-language').value });
  socket = new ResilientSocket(`/ws/asr?${params.toString()}`, {
    onOpen: () => {
      applySocketStatus('asr-status', 'connected');
      log('asr-log', '已连接，开始说话即可');
    },
    onMessage(raw) {
      const event = JSON.parse(raw);
      if (event.type === 'asr.sentence') {
        if (event.is_end) {
          currentNode = appendMsg('asr-log', event.text);
        } else if (currentNode) {
          updateMsg(currentNode, event.text);
        } else {
          currentNode = appendMsg('asr-log', event.text);
        }
      } else if (event.type === 'error') {
        log('asr-log', event.error?.message || '识别出错', 'error');
      } else if (event.type === 'asr.stopped') {
        currentNode = null;
      }
    },
    onStatus(raw) {
      applySocketStatus('asr-status', raw);
      if (raw === 'reconnecting') currentNode = null;
    },
  });
  socket.open();
}

function stop() {
  if (socket) socket.send('stop');
  if (socket) socket.close();
  socket = null;
  currentNode = null;
  if (recorder) recorder.stop();
  recorder = null;
  recording = false;
  el('asr-toggle').textContent = '开始录音';
}

async function toggle() {
  if (recording) {
    stop();
    return;
  }
  start();
  await socket.whenOpen();
  recorder = new MicRecorder((chunk) => {
    socket?.send({ type: 'client.audio', data: arrayBufferToBase64(chunk.buffer) });
  });
  await recorder.start();
  recording = true;
  el('asr-toggle').textContent = '停止录音';
}

export function init() {
  el('asr-toggle').addEventListener('click', toggle);
}