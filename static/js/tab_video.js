// Tab 5 - short video.
//
// The renderer is short-video-maker (Node/Remotion) bundled into the same
// container; the browser never talks to it directly. Everything here goes
// through /api/video, which carries the session cookie and hides the internal
// port. The only reason this tab exists is the split: the workbench owns the
// script, the voice and the AI; the renderer owns Pexels b-roll, captions and
// the Remotion template.
//
// Scene text is deliberately plain. Emotion tags are stripped server-side
// before TTS: the renderer would read `[excited]` aloud and paint it into the
// caption, which is exactly the kind of thing that looks fine in the editor and
// wrong on the finished video.

import { actionButton } from '/static/js/actions.js';
import { el, state } from '/static/js/app.js';
import { api } from '/static/js/http.js';
import { error as logError } from '/static/js/debug_log.js';
import { fillSelect } from '/static/js/tag_dialog.js';
import { MAX_SCENES, splitLocal, termsToText, textToTerms } from '/static/js/video_split.js';

const DRAFT_KEY = 'video.draft';
const POLL_MS = 3000;
const POLL_LIMIT_MS = 15 * 60 * 1000;

const MUSIC_LABELS = {
  sad: '伤感',
  melancholic: '忧郁',
  happy: '开心',
  'euphoric/high': '亢奋',
  excited: '兴奋',
  chill: '轻松',
  uneasy: '不安',
  angry: '愤怒',
  dark: '暗黑',
  hopeful: '希望',
  contemplative: '沉思',
  'funny/quirky': '搞怪',
};

const CAPTION_LABELS = { top: '顶部', center: '中间', bottom: '底部' };
const ORIENTATION_LABELS = { portrait: '竖屏 9:16', landscape: '横屏 16:9' };
const VOLUME_LABELS = { muted: '静音', low: '轻', medium: '中', high: '重' };
const PADDING_CHOICES = [
  { ms: 0, label: '0 秒' },
  { ms: 500, label: '0.5 秒' },
  { ms: 1500, label: '1.5 秒' },
  { ms: 3000, label: '3 秒' },
];

/** `{ text, searchTerms }[]`, the same shape the API takes. */
let scenes = [];
let options = null;
let polling = null;
let currentVideoId = null;
let draftTimer = null;

function setStatus(text, kind) {
  const node = el('video-status');
  if (!node) return;
  node.textContent = text;
  node.dataset.state = kind || '';
}

function disabled(message) {
  const note = el('video-disabled');
  note.hidden = false;
  note.textContent = message;
  for (const id of ['video-script', 'video-split-ai', 'video-split-local', 'video-create']) {
    const node = el(id);
    if (node) node.disabled = true;
  }
}

// ---- draft ----------------------------------------------------------------

function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try {
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({
          script: el('video-script').value,
          scenes,
          voice: el('video-voice').value,
          music: el('video-music').value,
          musicVolume: el('video-musicvolume').value,
          captionPosition: el('video-caption').value,
          orientation: el('video-orientation').value,
          // Empty until fillOptions runs; storing 0 here would silently change
          // the default to "no tail" on the next visit.
          paddingBack: el('video-padding').value === ''
            ? undefined
            : Number(el('video-padding').value),
        })
      );
    } catch (_) {
      /* storage full or disabled: the draft is a convenience, not the data */
    }
  }, 300);
}

function readDraft() {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null') || {};
  } catch (_) {
    return {};
  }
}

// ---- scenes ---------------------------------------------------------------

function renderScenes() {
  const box = el('video-scenes');
  box.innerHTML = '';
  if (!scenes.length) {
    const empty = document.createElement('p');
    empty.className = 'muted small';
    empty.textContent = '还没有场景。先写稿，再点「AI 拆场景」。';
    box.appendChild(empty);
    return;
  }

  scenes.forEach((scene, index) => {
    const card = document.createElement('div');
    card.className = 'vscene';
    card.dataset.index = String(index);

    const head = document.createElement('div');
    head.className = 'vscene-head';
    const no = document.createElement('span');
    no.className = 'vscene-no';
    no.textContent = String(index + 1);
    const remove = actionButton('删除', {
      className: 'ghost danger',
      create: document.createElement.bind(document),
      onClick: () => {
        scenes.splice(index, 1);
        renderScenes();
        saveDraft();
      },
    });
    head.append(no, remove);

    const text = document.createElement('textarea');
    text.rows = 2;
    text.className = 'vscene-text';
    text.value = scene.text || '';
    text.placeholder = '这一场要念的话';
    text.addEventListener('input', () => {
      scene.text = text.value;
      saveDraft();
    });

    const terms = document.createElement('input');
    terms.type = 'text';
    terms.className = 'vscene-terms';
    terms.value = termsToText(scene.searchTerms);
    terms.placeholder = '英文检索词，逗号分隔：city night, coffee pouring';
    terms.addEventListener('input', () => {
      scene.searchTerms = textToTerms(terms.value);
      saveDraft();
    });

    card.append(head, text, terms);
    box.appendChild(card);
  });
}

function applyScenes(list) {
  scenes = list
    .map((item) => ({
      text: String(item.text || '').trim(),
      searchTerms: (item.searchTerms || []).map((term) => String(term).trim()).filter(Boolean),
    }))
    .filter((item) => item.text)
    .slice(0, MAX_SCENES);
  renderScenes();
  saveDraft();
}

async function splitWithAI() {
  const script = el('video-script').value.trim();
  if (!script) {
    setStatus('先写一段口播稿', 'error');
    return;
  }
  const status = el('video-split-status');
  status.textContent = '拆分中…';
  status.dataset.state = 'connecting';
  el('video-split-ai').disabled = true;
  try {
    const payload = await api('/api/video/scenes', {
      method: 'POST',
      body: JSON.stringify({ script }),
    });
    applyScenes(payload.scenes || []);
    status.textContent = payload.warning || `已拆成 ${scenes.length} 场`;
    status.dataset.state = payload.warning ? 'connecting' : 'connected';
  } catch (error) {
    status.textContent = error.message;
    status.dataset.state = 'error';
  } finally {
    el('video-split-ai').disabled = false;
  }
}

function splitBySentence() {
  const script = el('video-script').value.trim();
  if (!script) {
    setStatus('先写一段口播稿', 'error');
    return;
  }
  const parts = splitLocal(script);
  // Keep whatever search terms the user already typed for the same position:
  // re-splitting is common, retyping keywords is not.
  applyScenes(
    parts.map((text, index) => ({
      text,
      searchTerms: scenes[index]?.searchTerms || [],
    }))
  );
  el('video-split-status').textContent = `已拆成 ${scenes.length} 场`;
  el('video-split-status').dataset.state = 'connected';
}

// ---- options --------------------------------------------------------------

function voiceName(voice) {
  const model = voice.model || '音色';
  const tail = voice.id.slice(-8);
  const state = voice.status && voice.status !== 'OK' ? ` · ${voice.status}` : '';
  return `${model} · …${tail}${state}`;
}

function fillOptions() {
  const video = state.config.video || {};
  const draft = readDraft();

  fillSelect(
    el('video-music'),
    (options.music || []).map((id) => ({ id, name: MUSIC_LABELS[id] || id })),
    draft.music || options.defaults.music
  );
  fillSelect(
    el('video-musicvolume'),
    (video.music_volumes || ['muted', 'low', 'medium', 'high']).map((id) => ({
      id,
      name: VOLUME_LABELS[id] || id,
    })),
    draft.musicVolume || options.defaults.musicVolume
  );
  fillSelect(
    el('video-caption'),
    (video.captions || ['top', 'center', 'bottom']).map((id) => ({
      id,
      name: CAPTION_LABELS[id] || id,
    })),
    draft.captionPosition || options.defaults.captionPosition
  );
  fillSelect(
    el('video-orientation'),
    (video.orientations || ['portrait', 'landscape']).map((id) => ({
      id,
      name: ORIENTATION_LABELS[id] || id,
    })),
    draft.orientation || options.defaults.orientation
  );

  const padding = el('video-padding');
  padding.innerHTML = '';
  for (const choice of PADDING_CHOICES) {
    const optionEl = document.createElement('option');
    optionEl.value = String(choice.ms);
    optionEl.textContent = choice.label;
    padding.appendChild(optionEl);
  }
  padding.value = String(draft.paddingBack ?? options.defaults.paddingBack ?? 1500);

  const voices = [];
  const seen = new Set();
  const add = (voice) => {
    if (!voice.id || seen.has(voice.id)) return;
    seen.add(voice.id);
    voices.push(voice);
  };
  add({ id: options.defaults.voice, name: `默认 · ${options.defaults.voice}` });
  for (const voice of options.voices || []) {
    if (voice.status && voice.status !== 'OK') continue;
    add({ ...voice, name: voiceName(voice) });
  }
  fillSelect(el('video-voice'), voices, draft.voice || voices[1]?.id || voices[0]?.id);
}

// ---- history --------------------------------------------------------------

function shortId(id) {
  return String(id || '').slice(-8);
}

function statusBadge(status) {
  const labels = { ready: '完成', processing: '渲染中', error: '失败' };
  const kinds = { ready: 'ok', processing: 'warn', error: 'err' };
  const badge = document.createElement('span');
  badge.className = `hbadge ${kinds[status] || ''}`;
  badge.textContent = labels[status] || status || '未知';
  return badge;
}

function playVideo(id) {
  const player = el('video-player');
  player.src = `/api/video/${id}/file`;
  player.hidden = false;
  player.scrollIntoView({ behavior: 'smooth', block: 'center' });
  player.play().catch(() => {});
  el('video-download').href = player.src;
  el('video-download').download = `short-${shortId(id)}.mp4`;
  el('video-download').hidden = false;
}

async function deleteVideo(id) {
  if (!confirm('删除这条视频？')) return;
  try {
    await api(`/api/video/${id}`, { method: 'DELETE' });
    await loadHistory();
    if (currentVideoId === id) {
      el('video-player').hidden = true;
      el('video-download').hidden = true;
      currentVideoId = null;
    }
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

function historyCard(video) {
  const card = document.createElement('div');
  card.className = 'hcard';

  const head = document.createElement('div');
  head.className = 'hhead';

  const meta = document.createElement('div');
  meta.className = 'hmeta';
  const title = document.createElement('div');
  title.className = 'htitle';
  title.textContent = `视频 …${shortId(video.id)}`;
  const sub = document.createElement('div');
  sub.className = 'hsub';
  sub.textContent = video.status === 'ready' ? 'Pexels 素材 + 复刻音色' : '渲染中，通常 1–3 分钟';
  meta.append(title, sub);

  const badges = document.createElement('div');
  badges.className = 'htags';
  badges.appendChild(statusBadge(video.status));

  const actions = document.createElement('div');
  actions.className = 'hactions';
  if (video.status === 'ready') {
    actions.append(
      actionButton('播放', {
        create: document.createElement.bind(document),
        onClick: () => playVideo(video.id),
      }),
      actionButton('下载', {
        className: '',
        create: document.createElement.bind(document),
        onClick: () => {
          const link = document.createElement('a');
          link.href = `/api/video/${video.id}/file`;
          link.download = `short-${shortId(video.id)}.mp4`;
          link.click();
        },
      })
    );
  }
  actions.append(
    actionButton('删除', {
      className: 'ghost danger',
      create: document.createElement.bind(document),
      onClick: () => deleteVideo(video.id),
    })
  );

  head.append(meta, badges, actions);
  card.appendChild(head);
  return card;
}

async function loadHistory() {
  const box = el('video-history');
  if (!options?.enabled) {
    box.innerHTML = '';
    return;
  }
  try {
    const payload = await api('/api/video');
    const videos = [...(payload.videos || [])].reverse();
    box.innerHTML = '';
    if (!videos.length) {
      const empty = document.createElement('p');
      empty.className = 'muted small';
      empty.textContent = '还没有生成过视频。';
      box.appendChild(empty);
      return;
    }
    for (const video of videos) box.appendChild(historyCard(video));
  } catch (error) {
    box.innerHTML = '';
    const note = document.createElement('p');
    note.className = 'muted small';
    note.textContent = `视频记录加载失败：${error.message}`;
    box.appendChild(note);
  }
}

// ---- create ---------------------------------------------------------------

function stopPolling() {
  if (polling) {
    clearTimeout(polling.timer);
    polling = null;
  }
}

function fail(text) {
  stopPolling();
  el('video-progress').hidden = true;
  el('video-progress').classList.remove('running');
  setStatus(text, 'error');
  el('video-create').disabled = false;
}

function finish(video) {
  stopPolling();
  el('video-progress').hidden = true;
  el('video-progress').classList.remove('running');
  currentVideoId = video.id;
  setStatus('完成', 'connected');
  el('video-create').disabled = false;
  playVideo(video.id);
  loadHistory();
}

async function pollStatus(videoId, started) {
  if (!polling || polling.id !== videoId) return;
  if (Date.now() - started > POLL_LIMIT_MS) {
    fail('渲染超时，去检查一下渲染服务的日志');
    return;
  }
  try {
    const response = await fetch(`/api/video/${videoId}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.status === 'ready') {
      finish(payload);
      return;
    }
    if (payload.status === 'error') {
      fail('渲染失败，详情见渲染服务日志');
      return;
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    setStatus(`渲染中… 已 ${seconds} 秒`, 'connecting');
    el('video-progress-text').textContent = `排队/渲染中 · 已 ${seconds} 秒 · 通常 1–3 分钟`;
  } catch (error) {
    // A single poll failure is not fatal: the renderer may be restarting.
    logError('轮询短视频状态失败', { message: error.message });
  }
  polling.timer = setTimeout(() => pollStatus(videoId, started), POLL_MS);
}

async function createVideo() {
  const usable = scenes.filter((scene) => scene.text.trim());
  if (!usable.length) {
    setStatus('先拆出至少一个场景', 'error');
    return;
  }
  const missing = usable.findIndex((scene) => !scene.searchTerms.length);
  if (missing >= 0) {
    setStatus(`第 ${missing + 1} 场缺少检索词`, 'error');
    const card = el('video-scenes').querySelector(`[data-index="${missing}"]`);
    card?.classList.add('missing');
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  el('video-create').disabled = true;
  el('video-progress').hidden = false;
  el('video-progress').classList.add('running');
  el('video-progress-text').textContent = '正在提交…';
  setStatus('提交中…', 'connecting');
  try {
    const payload = await api('/api/video', {
      method: 'POST',
      body: JSON.stringify({
        scenes: usable.map((scene) => ({
          text: scene.text.trim(),
          searchTerms: scene.searchTerms,
        })),
        config: {
          voice: el('video-voice').value,
          music: el('video-music').value,
          musicVolume: el('video-musicvolume').value,
          captionPosition: el('video-caption').value,
          orientation: el('video-orientation').value,
          paddingBack: Number(el('video-padding').value) || 0,
        },
      }),
    });
    currentVideoId = payload.videoId;
    setStatus('已提交，等待渲染', 'connecting');
    el('video-progress-text').textContent = '排队中…';
    stopPolling();
    polling = { id: payload.videoId, timer: null };
    pollStatus(payload.videoId, Date.now());
    loadHistory();
  } catch (error) {
    fail(error.message);
  }
}

// ---- init -----------------------------------------------------------------

export function init() {
  const video = state.config?.video;
  if (!video?.enabled) {
    disabled('这个部署没有内置短视频渲染服务，页签只读。');
    return;
  }

  el('video-split-ai').addEventListener('click', splitWithAI);
  el('video-split-local').addEventListener('click', splitBySentence);
  el('video-create').addEventListener('click', createVideo);
  el('video-script').addEventListener('input', saveDraft);
  for (const id of [
    'video-voice',
    'video-music',
    'video-musicvolume',
    'video-caption',
    'video-orientation',
    'video-padding',
  ]) {
    el(id).addEventListener('change', saveDraft);
  }

  const draft = readDraft();
  if (draft.script) el('video-script').value = draft.script;
  if (Array.isArray(draft.scenes) && draft.scenes.length) {
    applyScenes(draft.scenes);
  } else {
    renderScenes();
  }

  api('/api/video/options')
    .then((payload) => {
      options = payload;
      if (!payload.enabled) {
        disabled('这个部署没有内置短视频渲染服务。');
        return;
      }
      if (payload.renderer !== 'ok') {
        setStatus('渲染服务暂时不可用', 'error');
        el('video-create').disabled = true;
      }
      fillOptions();
      loadHistory();
    })
    .catch((error) => {
      disabled(`短视频不可用：${error.message}`);
    });
}

export { splitLocal, textToTerms };
