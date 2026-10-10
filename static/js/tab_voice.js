// Tab 6 - voice cloning and voice management.

import { PcmPlayer, ResilientSocket, VoiceClipRecorder } from '/static/js/audio.js';
import { log, state } from '/static/js/app.js';

let recorder = null;
let clip = null;
let previewSocket = null;
let previewPlayer = null;

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      detail = (await response.json()).detail || detail;
    } catch (_) {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return response.json();
}

function setClip(blob, label) {
  clip = blob;
  document.getElementById('voice-clone').disabled = !blob;
  document.getElementById('voice-download').disabled = !blob;
  if (blob) log('voice-status', `已就绪：${label}`, 'system');
}

function downloadClip() {
  if (!clip) return;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const url = URL.createObjectURL(clip);
  const link = document.createElement('a');
  link.href = url;
  link.download = `voice-sample-${stamp}.wav`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function speakWithVoice(voiceId) {
  if (previewPlayer) previewPlayer.clear();
  if (!previewSocket) {
    const { ResilientSocket } = await import('/static/js/audio.js');
    previewPlayer = previewPlayer || new PcmPlayer(state.config.tts_sample_rate);
    previewSocket = new ResilientSocket('/ws/tts', {
      onBinary: (buffer) => previewPlayer.push(new Int16Array(buffer)),
      onStatus: () => {},
    });
    previewSocket.open();
  }
  await previewPlayer.resume();
  const text =
    document.getElementById('voice-play-text').value.trim() ||
    '这是用复刻音色合成的语音。';
  previewSocket.send({ type: 'tts.synthesize', text, voice: voiceId });
  document.getElementById('voice-play-select').value = voiceId;
}

async function refreshVoices() {
  const container = document.getElementById('voice-list');
  const select = document.getElementById('voice-play-select');
  try {
    const { voices } = await api('/api/voices');
    const list = Array.isArray(voices) ? voices : [];
    container.innerHTML = '';
    select.innerHTML = '';

    if (!list.length) {
      container.innerHTML = '<p class="muted">还没有复刻过音色。</p>';
      return;
    }

    for (const entry of list) {
      const voiceId = entry.voice_id || entry.voiceId || String(entry);

      const row = document.createElement('div');
      row.className = 'voice-row';

      const label = document.createElement('span');
      label.className = 'voice-id';
      label.textContent = voiceId;
      if (entry.target_model) {
        const tag = document.createElement('span');
        tag.className = 'voice-tag';
        tag.textContent = entry.target_model;
        label.appendChild(tag);
      }

      const preview = document.createElement('button');
      preview.className = 'ghost';
      preview.textContent = '试音';
      preview.addEventListener('click', () => {
        log('voice-status', `正在试音：${voiceId}`, 'system');
        speakWithVoice(voiceId);
      });

      const remove = document.createElement('button');
      remove.className = 'ghost danger';
      remove.textContent = '删除';
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          await api(`/api/voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE' });
          log('voice-status', `已删除 ${voiceId}`, 'system');
          refreshVoices();
        } catch (error) {
          remove.disabled = false;
          log('voice-status', error.message, 'error');
        }
      });

      row.append(label, preview, remove);
      container.appendChild(row);

      const option = document.createElement('option');
      option.value = voiceId;
      option.textContent = voiceId;
      select.appendChild(option);
    }
  } catch (error) {
    log('voice-status', `读取音色列表失败：${error.message}`, 'error');
  }
}

async function clearAll() {
  const { voices } = await api('/api/voices').catch(() => ({ voices: [] }));
  const list = Array.isArray(voices) ? voices : [];
  if (!list.length) {
    log('voice-status', '没有可清理的音色', 'system');
    return;
  }
  // Voice quota is limited, so offer a one-click way to reclaim it. Mirrors
  // delete_voice_by_prefix() in the upstream cloned-voice samples.
  for (const entry of list) {
    const voiceId = entry.voice_id || entry.voiceId || String(entry);
    await api(`/api/voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE' }).catch(
      () => {}
    );
  }
  log('voice-status', `已清理 ${list.length} 个音色`, 'system');
  refreshVoices();
}

async function clone() {
  if (!clip) return;
  const form = new FormData();
  form.append('audio', clip, 'sample.wav');
  form.append('prefix', document.getElementById('voice-prefix').value.trim());
  form.append('target_model', document.getElementById('voice-model').value);

  document.getElementById('voice-clone').disabled = true;
  log('voice-status', '正在复刻，通常需要几秒…', 'system');

  try {
    const { voice_id: voiceId } = await api('/api/voices', { method: 'POST', body: form });
    log('voice-status', `复刻成功：${voiceId}`, 'system');
    await refreshVoices();
    document.getElementById('voice-play-select').value = voiceId;
  } catch (error) {
    log('voice-status', `复刻失败：${error.message}`, 'error');
  } finally {
    document.getElementById('voice-clone').disabled = !clip;
  }
}

async function playPreview() {
  const voice = document.getElementById('voice-play-select').value;
  const text = document.getElementById('voice-play-text').value.trim();
  if (!voice || !text) return;

  if (!previewSocket) {
    previewPlayer = previewPlayer || new PcmPlayer(state.config.tts_sample_rate);
    previewSocket = new ResilientSocket('/ws/tts', {
      onBinary: (buffer) => previewPlayer.push(new Int16Array(buffer)),
      onStatus: () => {},
    });
    previewSocket.open();
    await previewSocket.whenOpen();
    await previewPlayer.resume();
  }

  previewSocket.send({ type: 'tts.synthesize', text, voice });
}

async function toggleRecording() {
  const button = document.getElementById('voice-record');

  if (recorder) {
    const active = recorder;
    recorder = null;
    button.textContent = '开始录音';
    document.getElementById('voice-level').style.width = '0';
    const seconds = active.seconds.toFixed(1);
    setClip(await active.stop(), `录音 ${seconds}s`);
    return;
  }

  try {
    recorder = new VoiceClipRecorder(state.config.enroll_target_seconds, (level) => {
      document.getElementById('voice-level').style.width = `${Math.min(100, level * 320)}%`;
    });
    await recorder.start();
    button.textContent = '停止录音';
    log('voice-status', '录音中…', 'system');
  } catch (error) {
    recorder = null;
    log('voice-status', `无法访问麦克风：${error.message}`, 'error');
  }
}

export function init() {
  document.getElementById('voice-record').addEventListener('click', toggleRecording);
  document.getElementById('voice-clone').addEventListener('click', clone);
  document.getElementById('voice-play').addEventListener('click', playPreview);
  document.getElementById('voice-refresh').addEventListener('click', refreshVoices);
  document.getElementById('voice-download').addEventListener('click', downloadClip);
  document.getElementById('voice-clear').addEventListener('click', clearAll);

  document.getElementById('voice-file').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (file) setClip(file, file.name);
  });

  refreshVoices();
}