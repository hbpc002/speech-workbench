// Tab 1 - realtime voice chat.
//
// Closely follows samples/conversation/fun-audiochat-realtime/demo_app/web/index.html.
// One difference: the transcript is kept on the client so it can be replayed
// after a reconnect. Vercel Hobby terminates a function at 300 s, which kills
// the upstream DashScope session; replaying through `client.replay` rebuilds
// the model's context instead of starting a blank conversation.

import {
  MicRecorder,
  PcmPlayer,
  ResilientSocket,
  arrayBufferToBase64,
  base64ToArrayBuffer,
} from '/static/js/audio.js';
import { appendMsg, applySocketStatus, el, log, state, updateMsg } from '/static/js/app.js';

const PLAYBACK_SAMPLE_RATE = 24000;

let socket = null;
let player = null;
let recorder = null;
let recording = false;
let connected = false;

// Conversation state, client-side so it survives a dropped socket.
let history = [];
let currentUserNode = null;
let currentAssistantNode = null;
let currentUserText = '';
let currentAssistantText = '';
let isResponding = false;
let speechStoppedAt = 0;
let firstTextAt = 0;
let firstAudioAt = 0;

function buildPath() {
  const params = new URLSearchParams({
    model: el('chat-model').value.trim(),
    voice: el('chat-voice').value,
    vad: el('chat-vad').value,
    silence: el('chat-silence').value,
  });
  return `/ws/chat?${params.toString()}`;
}

function sessionUpdate() {
  const scenario = el('chat-scenario').value;
  const instructions = el('chat-instructions').value.trim();
  const session = {
    modalities: ['text', 'audio'],
    voice: el('chat-voice').value,
    input_audio_format: 'pcm',
    output_audio_format: 'pcm',
    turn_detection: {
      type: el('chat-vad').value,
      threshold: 0.1,
      silence_duration_ms: parseInt(el('chat-silence').value, 10),
    },
  };
  const base = state.prompts.base_constraints || '';
  const scenarioPrompt = state.prompts[scenario] || '';
  session.instructions = [base, scenarioPrompt, instructions].filter(Boolean).join('\n');
  return { type: 'session.update', session };
}

function pushHistory(role, text) {
  const clean = (text || '').trim();
  if (!clean) return;
  history.push({ role, text: clean });
  // The server caps the replay; mirror it so both ends agree.
  if (history.length > 40) history = history.slice(-40);
}

function onOpen(isReconnect) {
  applySocketStatus('chat-status', 'connected');
  connected = true;
  el('chat-connect').textContent = '断开';

  socket.send(sessionUpdate());
  if (isReconnect && history.length) {
    socket.send({ type: 'client.replay', items: history });
    log('chat-log', `连接已重建，重放 ${history.length} 条历史`, 'system');
  } else {
    player.clear();
  }
}

function onBinary() {
  // The realtime API ships base64 audio inside JSON text frames, so binary
  // frames are not expected here; kept so a future protocol change is visible.
  console.warn('unexpected binary frame on /ws/chat');
}

function onMessage(raw) {
  const event = JSON.parse(raw);

  switch (event.type) {
    case 'server.hello':
      break;

    case 'server.history_replayed':
      log('chat-log', `上下文已恢复（${event.count} 条）`, 'system');
      break;

    case 'input_audio_buffer.speech_started':
      // Barge-in: stop talking over the user.
      if (isResponding) socket.send({ type: 'response.cancel' });
      if (player) player.clear();
      break;

    case 'input_audio_buffer.speech_stopped':
      speechStoppedAt = Date.now();
      firstTextAt = 0;
      firstAudioAt = 0;
      updateLatency();
      break;

    case 'response.created':
      isResponding = true;
      currentAssistantText = '';
      currentUserNode = appendMsg('chat-log', '…');
      break;

    case 'response.audio.delta':
      if (firstAudioAt === 0 && speechStoppedAt) {
        firstAudioAt = Date.now();
        updateLatency();
      }
      player.push(new Int16Array(base64ToArrayBuffer(event.delta)));
      break;

    case 'response.audio_transcript.delta':
      if (firstTextAt === 0 && speechStoppedAt) {
        firstTextAt = Date.now();
        updateLatency();
      }
      currentAssistantText += event.delta || '';
      if (!currentAssistantNode) {
        currentAssistantNode = appendMsg('chat-log', currentAssistantText, 'assistant');
      } else {
        updateMsg(currentAssistantNode, currentAssistantText);
      }
      break;

    case 'conversation.item.input_audio_transcription.completed':
      currentUserText = event.transcript || '';
      if (currentUserNode) {
        updateMsg(currentUserNode, currentUserText);
      } else {
        currentUserNode = appendMsg('chat-log', currentUserText);
      }
      break;

    case 'response.function_call_arguments.done':
      log('chat-log', `调用工具 ${event.name}(${event.arguments || '{}'})`, 'reasoning');
      break;

    case 'response.done':
      isResponding = false;
      pushHistory('user', currentUserText);
      pushHistory('assistant', currentAssistantText);
      currentUserNode = null;
      currentAssistantNode = null;
      currentUserText = '';
      currentAssistantText = '';
      break;

    case 'error': {
      const message = (event.error && event.error.message) || JSON.stringify(event);
      log('chat-log', message, 'error');
      break;
    }
  }
}

function onStatus(raw) {
  applySocketStatus('chat-status', raw);
  if (raw === 'reconnecting') {
    player.clear();
  }
  if (raw === 'closed') {
    connected = false;
    el('chat-connect').textContent = '连接';
    stopRecording();
  }
}

function updateLatency() {
  if (!speechStoppedAt) return;
  const parts = [];
  if (firstTextAt) parts.push(`S2T ${firstTextAt - speechStoppedAt}ms`);
  if (firstAudioAt) parts.push(`S2A ${firstAudioAt - speechStoppedAt}ms`);
  el('chat-latency').textContent = parts.join('  ');
}

function connect() {
  player = player || new PcmPlayer(PLAYBACK_SAMPLE_RATE);
  socket = new ResilientSocket(buildPath(), {
    onOpen,
    onMessage,
    onBinary,
    onStatus,
  });
  socket.open();
}

function disconnect() {
  if (socket) socket.close();
  socket = null;
  connected = false;
  stopRecording();
  el('chat-connect').textContent = '连接';
  applySocketStatus('chat-status', 'closed');
}

async function startRecording() {
  if (!connected) {
    log('chat-log', '请先建立连接', 'error');
    return;
  }
  await player.resume();
  recorder = new MicRecorder((chunk) => {
    socket.send({
      type: 'input_audio_buffer.append',
      audio: arrayBufferToBase64(chunk.buffer),
    });
  });
  await recorder.start();
  recording = true;
  el('chat-mic').textContent = '停止录音';
}

function stopRecording() {
  if (recorder) recorder.stop();
  recorder = null;
  if (recording) {
    recording = false;
    el('chat-mic').textContent = '开始录音';
  }
}

function applyScenario() {
  el('chat-instructions').value = state.prompts[el('chat-scenario').value] || '';
}

export function init() {
  el('chat-connect').addEventListener('click', () => {
    if (socket) disconnect();
    else connect();
  });
  el('chat-mic').addEventListener('click', async () => {
    if (recording) {
      stopRecording();
      if (connected) socket.send({ type: 'input_audio_buffer.commit' });
    } else {
      await startRecording();
    }
  });
  el('chat-scenario').addEventListener('change', applyScenario);
  el('chat-full-duplex').addEventListener('change', async (event) => {
    if (event.target.checked) await startRecording();
    else stopRecording();
  });

  applyScenario();
}