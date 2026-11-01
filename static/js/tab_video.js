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
import { MAX_SCENES, pcmToWavBlob, splitLocal, termsToText, textToTerms } from '/static/js/video_split.js';
import { SHORT_VIDEO_EVENT } from '/static/js/short_video_request.js';

const DRAFT_KEY = 'video.draft';
const JOB_LOG_KEY = 'video.jobs';

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
let pollTimer = null;
let lastVideos = [];
/** Jobs submitted from this browser, including ones that failed (the renderer
 * forgets failures: no file, no queue entry, so the server list cannot show
 * them). Newest first, capped. */
let jobLog = [];
let currentVideoId = null;
let currentStartedAt = null;
let draftTimer = null;
/**
 * Whether the option selects exist yet.
 *
 * init() restores the draft's scenes before /api/video/options answers. That
 * restore used to call saveDraft() with every select empty, which overwrote
 * the saved voice/music with "" -- the next reload then forgot them. Nothing
 * is written until fillOptions() has run.
 */
let draftReady = false;
/** A record handed over from the synthesis tab, waiting for options to load. */
let pendingPrefill = null;

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
  if (!draftReady) return;
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

function updateSceneNote() {
  const note = el('video-scene-note');
  if (!note) return;
  note.textContent = scenes.some((scene) => scene.audioToken)
    ? '本组场景使用语音记录里的现成音频，不会再合成；字幕直接取口播稿（去掉情感标签）。'
    : '每场一段旁白；检索词用英文（Pexels 按它找画面），2–3 个最稳。素材会自动过滤掉有人物出镜的镜头。';
}

function renderScenes() {
  const box = el('video-scenes');
  box.innerHTML = '';
  updateSceneNote();
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
    if (scene.audioToken) {
      const badge = document.createElement('span');
      badge.className = 'hbadge ok';
      badge.textContent = '记录音频';
      head.appendChild(badge);
    }
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
      // A pre-rendered audio token survives re-renders and reloads; the
      // renderer will reuse that WAV instead of synthesising again.
      audioToken: String(item.audioToken || ''),
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

/**
 * Fill the search terms of scenes that have none.
 *
 * 按句拆分 is local and free, so it leaves terms empty on purpose. Re-running
 * the AI split would overwrite text the user edited; this only asks for terms
 * and matches them back by position.
 */
async function fillMissingTerms() {
  const targets = scenes.filter((scene) => scene.text.trim() && !scene.searchTerms.length);
  const status = el('video-split-status');
  if (!targets.length) {
    status.textContent = '所有场景都有检索词了';
    status.dataset.state = 'connected';
    return;
  }
  const button = el('video-fill-terms');
  button.disabled = true;
  status.textContent = `生成 ${targets.length} 场检索词…`;
  status.dataset.state = 'connecting';
  try {
    const payload = await api('/api/video/terms', {
      method: 'POST',
      body: JSON.stringify({ texts: targets.map((scene) => scene.text) }),
    });
    targets.forEach((scene, index) => {
      scene.searchTerms = (payload.terms?.[index] || []).slice(0, 4);
    });
    renderScenes();
    saveDraft();
    const filled = targets.filter((scene) => scene.searchTerms.length).length;
    status.textContent =
      filled === targets.length
        ? `已补 ${filled} 场`
        : `补了 ${filled} / ${targets.length} 场，剩下的手动填一下`;
    status.dataset.state = filled === targets.length ? 'connected' : 'connecting';
  } catch (error) {
    status.textContent = error.message;
    status.dataset.state = 'error';
  } finally {
    button.disabled = false;
  }
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
  // A `model:voice` from a synthesis record is not in the cloned list; keep it
  // selectable so a reload does not silently switch the voice.
  if (draft.voice && !seen.has(draft.voice)) {
    add({ id: draft.voice, name: `上次使用 · ${draft.voice}` });
  }
  fillSelect(el('video-voice'), voices, draft.voice || voices[1]?.id || voices[0]?.id);
  draftReady = true;
}

// ---- history --------------------------------------------------------------

function shortId(id) {
  return String(id || '').slice(-8);
}

function statusBadge(status) {
  const labels = { ready: '完成', processing: '渲染中', failed: '失败', error: '失败', cancelled: '已取消' };
  const kinds = { ready: 'ok', processing: 'warn', failed: 'err', error: 'err', cancelled: 'warn' };
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
    jobLog = jobLog.filter((entry) => entry.id !== id);
    saveJobLog();
    await refreshVideos();
    if (currentVideoId === id) {
      el('video-player').hidden = true;
      el('video-download').hidden = true;
      currentVideoId = null;
    }
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

const STAGES = {
  queue: '排队',
  audio: '准备配音',
  search: '找素材',
  download: '下载素材',
  render: '渲染画面',
  done: '完成',
};

function stageLabel(progress) {
  if (!progress) return '渲染中';
  const label = STAGES[progress.stage] || '渲染中';
  return progress.percent == null ? label : `${label} ${progress.percent}%`;
}

const reportedFailures = new Set();

function formatLogLine(line) {
  try {
    const entry = JSON.parse(line);
    const when = entry.time ? `${entry.time.slice(11, 19)} ` : '';
    const level = String(entry.level || 'info').toUpperCase();
    const message = entry.err?.message || entry.msg || '';
    return `${when}${level} ${message}`;
  } catch (_) {
    return line;
  }
}

async function openRenderLog() {
  const body = el('video-log-body');
  el('video-log').showModal();
  body.textContent = '加载中…';
  try {
    const payload = await api('/api/video/logs?lines=200');
    body.textContent = (payload.lines || []).map(formatLogLine).join('\n') || '（没有日志）';
  } catch (error) {
    body.textContent = `日志加载失败：${error.message}`;
  }
}

async function reportRenderFailure(video) {
  if (!video?.id || reportedFailures.has(video.id)) return;
  reportedFailures.add(video.id);
  const detail = video.error || '渲染失败，详情见渲染日志';
  setStatus(`渲染失败：${detail.slice(0, 120)}`, 'error');
  try {
    const payload = await api('/api/video/logs?lines=400');
    const errors = (payload.lines || [])
      .filter((line) => {
        try {
          return JSON.parse(line).level === 'error';
        } catch (_) {
          return false;
        }
      })
      .slice(-5);
    for (const line of errors) {
      logError(`渲染服务：${formatLogLine(line).slice(0, 500)}`, { source: 'renderer' });
    }
  } catch (_) {
    /* status already points at the log button */
  }
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`;
}

/** "今天 14:32" / "10-29 14:32" / cross-year with the year. */
function formatWhen(ms) {
  if (!ms) return '';
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hm}`;
  return date.getFullYear() === now.getFullYear() ? md : `${date.getFullYear()}-${md}`;
}

function historyCard(video) {
  const card = document.createElement('div');
  card.className = `hcard${video.status === 'processing' ? ' busy' : ''}`;

  const head = document.createElement('div');
  head.className = 'hhead';

  const meta = document.createElement('div');
  meta.className = 'hmeta';
  const title = document.createElement('div');
  title.className = 'htitle';
  const when = formatWhen(video.createdAt);
  title.textContent = video.title || `视频 …${shortId(video.id)}`;
  const sub = document.createElement('div');
  sub.className = 'hsub';
  const detail =
    video.status === 'ready'
      ? 'Pexels 素材 + 语音配音'
      : video.status === 'processing'
        ? stageLabel(video.progress)
        : video.status === 'cancelled'
          ? '已取消'
          : '渲染失败';
  const elapsed =
    video.status === 'processing' && video.createdAt ? Date.now() - video.createdAt : null;
  const took = video.tookMs != null ? `用时 ${formatDuration(video.tookMs)}` : '';
  const ticking = elapsed != null ? `已 ${formatDuration(elapsed)}` : '';
  sub.textContent = [when, ticking || took, `…${shortId(video.id)}`, detail]
    .filter(Boolean)
    .join(' · ');
  meta.append(title, sub);

  const badges = document.createElement('div');
  badges.className = 'htags';
  badges.appendChild(statusBadge(video.status));

  const actions = document.createElement('div');
  actions.className = 'hactions';
  if (video.status === 'ready') {
    actions.append(
      actionButton('编辑', {
        create: document.createElement.bind(document),
        onClick: () => editVideo(video.id),
      }),
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
  if (video.status === 'processing') {
    actions.append(
      actionButton('取消', {
        className: 'ghost danger',
        create: document.createElement.bind(document),
        onClick: () => cancelVideo(video.id),
      })
    );
  }
  if (video.status === 'failed' || video.status === 'error') {
    actions.append(
      actionButton('日志', {
        create: document.createElement.bind(document),
        onClick: () => openRenderLog(video.id),
      })
    );
  }
  if (video.status !== 'processing') {
    actions.append(
      actionButton('删除', {
        className: 'ghost danger',
        create: document.createElement.bind(document),
        onClick: () => deleteVideo(video.id),
      })
    );
  }

  head.append(meta, badges, actions);
  card.appendChild(head);

  if (video.status === 'processing') {
    const body = document.createElement('div');
    body.className = 'hbody';
    const bar = document.createElement('div');
    bar.className = 'hprogress';
    const fill = document.createElement('span');
    // No percentage yet (queueing / old jobs): leave it at 0 rather than
    // pretending; the stage label still says what is happening.
    fill.style.width = `${video.progress?.percent ?? 0}%`;
    bar.appendChild(fill);
    body.appendChild(bar);
    card.appendChild(body);
  }
  return card;
}

function renderHistory(videos) {
  const box = el('video-history');
  box.innerHTML = '';
  if (!videos.length) {
    const empty = document.createElement('p');
    empty.className = 'muted small';
    empty.textContent = '还没有生成过视频。';
    box.appendChild(empty);
    return;
  }
  for (const video of videos) box.appendChild(historyCard(video));
}

/** Header badge: visible on every tab while a job is rendering. */
function updateBadge(videos) {
  const badge = el('render-badge');
  if (!badge) return;
  const processing = videos.filter((video) => video.status === 'processing');
  if (!processing.length) {
    badge.hidden = true;
    return;
  }
  badge.hidden = false;
  badge.textContent =
    processing.length > 1
      ? `渲染中 ${processing.length} 个 · ${stageLabel(processing[0].progress)}`
      : `渲染中 · ${stageLabel(processing[0].progress)}`;
}

function updateProgressBar(progress) {
  const bar = el('video-progress');
  const fill = el('video-fill');
  if (!bar || !fill) return;
  bar.hidden = false;
  if (progress?.percent != null) {
    bar.classList.remove('running');
    fill.style.width = `${progress.percent}%`;
  } else {
    bar.classList.add('running');
    fill.style.width = '';
  }
}

/** Follow the job this tab submitted; other jobs are visible in the list. */
function trackCurrent(videos) {
  if (!currentVideoId) return;
  const video = videos.find((item) => item.id === currentVideoId);
  if (!video) return;
  if (video.status === 'ready') {
    currentVideoId = null;
    currentStartedAt = null;
    markJob(video.id, 'ready', video.progress);
    el('video-progress').hidden = true;
    el('video-progress').classList.remove('running');
    setStatus('完成', 'connected');
    playVideo(video.id);
    return;
  }
  if (video.status === 'failed' || video.status === 'error') {
    currentVideoId = null;
    currentStartedAt = null;
    markJob(video.id, 'failed', video.progress);
    el('video-progress').hidden = true;
    el('video-progress').classList.remove('running');
    el('video-create').disabled = false;
    reportRenderFailure(video);
    return;
  }
  const started = video.createdAt || currentStartedAt;
  const elapsed = started ? Date.now() - started : null;
  const suffix = elapsed != null ? ` · 已 ${formatDuration(elapsed)}` : '';
  setStatus(`渲染中 · ${stageLabel(video.progress)}${suffix}`, 'connecting');
  updateProgressBar(video.progress);
  el('video-progress-text').textContent =
    `${stageLabel(video.progress)}${suffix} · 可以离开这个页签，任务在后台继续`;
}

function readJobLog() {
  try {
    const parsed = JSON.parse(localStorage.getItem(JOB_LOG_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && entry.id).slice(0, 30) : [];
  } catch (_) {
    return [];
  }
}

function saveJobLog() {
  try {
    localStorage.setItem(JOB_LOG_KEY, JSON.stringify(jobLog.slice(0, 30)));
  } catch (_) {
    /* storage full: the log is a convenience, the server list still works */
  }
}

function rememberJob(id) {
  jobLog = [{ id, at: Date.now(), status: 'processing' }, ...jobLog.filter((entry) => entry.id !== id)].slice(0, 30);
  saveJobLog();
}

function markJob(id, status, progress) {
  const entry = jobLog.find((item) => item.id === id);
  if (!entry) return;
  entry.status = status;
  entry.progress = progress || null;
  saveJobLog();
}

async function mergeLocalJobs(serverVideos) {
  const known = new Set(serverVideos.map((video) => video.id));
  const extras = [];
  let changed = false;
  for (const entry of jobLog) {
    if (known.has(entry.id)) continue;
    if (entry.status === 'failed' || entry.status === 'cancelled') {
      extras.push({
        id: entry.id,
        status: entry.status,
        progress: entry.progress || null,
        url: null,
        title: entry.title || '',
        createdAt: entry.createdAt || entry.at,
        error: entry.error || '',
      });
      continue;
    }
    try {
      const response = await fetch(`/api/video/${entry.id}`);
      if (!response.ok) continue;
      const payload = await response.json();
      if (!payload.status) continue;
      extras.push({
        id: entry.id,
        status: payload.status,
        progress: payload.progress || null,
        url: payload.url || null,
        title: payload.title || entry.title || '',
        createdAt: payload.createdAt || entry.at,
        error: payload.error || entry.error || '',
      });
      if (entry.status !== payload.status) {
        entry.status = payload.status;
        entry.progress = payload.progress || null;
        changed = true;
      }
      if (payload.title) entry.title = payload.title;
      if (payload.createdAt) entry.createdAt = payload.createdAt;
      if (payload.error) entry.error = payload.error;
    } catch (_) {
      /* one missing status must not hide the rest of the history */
    }
  }
  if (changed) saveJobLog();
  return extras;
}

async function refreshVideos() {
  if (!options?.enabled) return;
  try {
    // Plain fetch, not api(): this runs every few seconds and would otherwise
    // flood the debug console with one line per poll.
    const response = await fetch('/api/video');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const serverVideos = [...(payload.videos || [])].reverse();
    const extras = await mergeLocalJobs(serverVideos);
    lastVideos = [...extras, ...serverVideos].sort(
      (a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0)
    );
    renderHistory(lastVideos);
    updateBadge(lastVideos);
    trackCurrent(lastVideos);
  } catch (error) {
    logError('刷新短视频任务失败', { message: error.message });
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  const busy = lastVideos.some((video) => video.status === 'processing');
  pollTimer = setTimeout(async () => {
    await refreshVideos();
    schedulePoll();
  }, busy ? 1000 : 8000);
}

async function cancelVideo(id) {
  if (!confirm('取消这个渲染任务？已经渲染的部分会丢弃。')) return;
  try {
    await api(`/api/video/${id}/cancel`, { method: 'POST' });
    if (!jobLog.some((entry) => entry.id === id)) {
      const video = lastVideos.find((item) => item.id === id);
      jobLog.unshift({
        id,
        at: video?.createdAt || Date.now(),
        title: video?.title || '',
        status: 'cancelled',
      });
    } else {
      const entry = jobLog.find((item) => item.id === id);
      entry.status = 'cancelled';
    }
    saveJobLog();
    if (currentVideoId === id) {
      currentVideoId = null;
      currentStartedAt = null;
      el('video-progress').hidden = true;
      el('video-progress').classList.remove('running');
      setStatus('已取消', '');
    }
    await refreshVideos();
    schedulePoll();
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

// ---- 素材预览与素材库 -------------------------------------------------------

let review = null;

function openReview(payload, mode) {
  review = {
    projectId: payload.projectId,
    title: payload.title || '',
    config: payload.config || {},
    mode,
    scenes: (payload.scenes || []).map((item, index) => ({
      index: index + 1,
      text: item.text,
      searchTerms: item.searchTerms || [],
      duration: item.duration || item.audio?.duration || 0,
      clip: item.clip || null,
    })),
  };
  el('video-review-picker').hidden = true;
  el('video-review-picker').innerHTML = '';
  el('video-review-status').textContent =
    mode === 'edit' ? '改完点「确认生成」会重新渲染一条新视频' : '';
  paintReviewScenes();
  el('video-review').showModal();
}

function paintReviewScenes() {
  const box = el('video-review-scenes');
  box.innerHTML = '';
  for (const [index, scene] of review.scenes.entries()) {
    const row = document.createElement('div');
    row.className = 'review-scene';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = scene.clip?.preview || '';
    const meta = document.createElement('div');
    meta.className = 'review-meta';
    const title = document.createElement('div');
    title.className = 'rtitle';
    title.textContent = `${index + 1}. ${scene.text}`;
    const sub = document.createElement('div');
    sub.className = 'rsub';
    sub.textContent = [
      scene.clip ? `素材 ${scene.clip.id}` : '未选素材',
      scene.clip?.duration ? `${Math.round(scene.clip.duration)} 秒` : '',
      scene.searchTerms.join(', '),
    ]
      .filter(Boolean)
      .join(' · ');
    meta.append(title, sub);
    const swap = actionButton('换一个', {
      create: document.createElement.bind(document),
      onClick: () => showPicker(index),
    });
    row.append(img, meta, swap);
    box.appendChild(row);
  }
}

async function showPicker(index) {
  const scene = review.scenes[index];
  const box = el('video-review-picker');
  const status = el('video-review-status');
  box.hidden = false;
  box.textContent = '搜索素材中…';
  try {
    const params = new URLSearchParams({
      term: (scene.searchTerms.join(',') || scene.text).slice(0, 80),
      orientation: review.config.orientation || 'portrait',
      duration: String(scene.duration || 10),
      exclude: scene.clip?.id || '',
      limit: '8',
    });
    const payload = await api(`/api/video/clips?${params.toString()}`);
    box.innerHTML = '';
    if (!(payload.clips || []).length) {
      box.textContent = '没有更多合规素材，换个检索词试试';
      return;
    }
    status.textContent = '点一个素材替换';
    for (const clip of payload.clips) {
      const button = document.createElement('button');
      button.type = 'button';
      const img = document.createElement('img');
      img.src = clip.preview;
      img.loading = 'lazy';
      const label = document.createElement('span');
      label.textContent = `${Math.round(clip.duration || 0)} 秒${clip.source === 'library' ? ' · 库' : ''}`;
      button.append(img, label);
      button.addEventListener('click', () => {
        scene.clip = clip;
        box.hidden = true;
        status.textContent = '已替换，确认后重新生成';
        paintReviewScenes();
      });
      box.appendChild(button);
    }
  } catch (error) {
    box.textContent = error.message;
  }
}

async function renderReview() {
  if (!review) return;
  const status = el('video-review-status');
  status.textContent = '提交渲染中…';
  el('video-review-render').disabled = true;
  try {
    const clips = review.scenes.map((scene) => ({
      id: scene.clip?.id || '',
      url: scene.clip?.url || '',
      preview: scene.clip?.preview || '',
      duration: scene.clip?.duration || 0,
    }));
    if (clips.some((clip) => !clip.id)) throw new Error('还有场景没有素材');
    const payload = await api(`/api/video/${review.projectId}/render`, {
      method: 'POST',
      body: JSON.stringify({ clips }),
    });
    currentVideoId = payload.videoId;
    currentStartedAt = Date.now();
    rememberJob(payload.videoId);
    el('video-review').close();
    review = null;
    setStatus('已提交，后台渲染中；可以继续做别的', 'connecting');
    el('video-progress').hidden = false;
    updateProgressBar(null);
    el('video-progress-text').textContent = '排队中…';
    await refreshVideos();
    schedulePoll();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    el('video-review-render').disabled = false;
  }
}

async function editVideo(id) {
  try {
    const payload = await api(`/api/video/${id}/project`);
    openReview(payload, 'edit');
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function openLibrary() {
  el('video-library').showModal();
  await loadLibrary();
}

async function loadLibrary() {
  const box = el('video-library-list');
  box.textContent = '加载中…';
  try {
    const payload = await api('/api/library');
    const showBlacklisted = el('video-library-show-blacklisted').checked;
    const clips = (payload.clips || []).filter((clip) => showBlacklisted || !clip.blacklisted);
    el('video-library-count').textContent = `${clips.length} 条`;
    box.innerHTML = '';
    for (const clip of clips) {
      const card = document.createElement('div');
      card.className = `library-card${clip.blacklisted ? ' blacklisted' : ''}`;
      const img = document.createElement('img');
      img.src = clip.preview;
      img.loading = 'lazy';
      const meta = document.createElement('div');
      meta.className = 'lmeta';
      const line1 = document.createElement('span');
      line1.textContent = `${Math.round(clip.duration || 0)} 秒 · 用过 ${clip.usedCount || 0} 次`;
      const line2 = document.createElement('span');
      line2.textContent = (clip.tags || []).join(', ') || '（无标签）';
      meta.append(line1, line2);
      const acts = document.createElement('div');
      acts.className = 'lacts';
      acts.append(
        actionButton(clip.blacklisted ? '移出黑名单' : '黑名单', {
          className: 'ghost',
          create: document.createElement.bind(document),
          onClick: async () => {
            await api(`/api/library/${clip.id}/blacklist`, {
              method: 'POST',
              body: JSON.stringify({ blacklisted: !clip.blacklisted }),
            });
            await loadLibrary();
          },
        }),
        actionButton('删除', {
          className: 'ghost danger',
          create: document.createElement.bind(document),
          onClick: async () => {
            if (!confirm(`删除素材 ${clip.id}？`)) return;
            await api(`/api/library/${clip.id}`, { method: 'DELETE' });
            await loadLibrary();
          },
        })
      );
      card.append(img, meta, acts);
      box.appendChild(card);
    }
    if (!clips.length) box.textContent = '素材库还是空的；生成视频时下载的片段会自动进来。';
  } catch (error) {
    box.textContent = `素材库加载失败：${error.message}`;
  }
}

// ---- create ---------------------------------------------------------------

function fail(text) {
  el('video-progress').hidden = true;
  el('video-progress').classList.remove('running');
  setStatus(text, 'error');
  el('video-create').disabled = false;
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
  setStatus('准备素材中…', 'connecting');
  try {
    const payload = await api('/api/video/prepare', {
      method: 'POST',
      body: JSON.stringify({
        scenes: usable.map((scene) => ({
          text: scene.text.trim(),
          searchTerms: scene.searchTerms,
          audioToken: scene.audioToken || '',
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
    openReview(payload, 'new');
    el('video-create').disabled = false;
    setStatus('素材已准备好，预览后点「确认生成」', 'connected');
    return;
  } catch (error) {
    fail(error.message);
  }
}

// ---- hand-off from a synthesis record -------------------------------------

/**
 * Fill the tab from a record and split it immediately.
 *
 * The voice is kept as `model:voice`: the renderer re-synthesises the text,
 * and the bridge needs the model to know which endpoint a preset voice belongs
 * to. Without it every record would fall back to the default clone.
 */
async function uploadAudio(pcm, sampleRate) {
  const blob = pcmToWavBlob([pcm], sampleRate);
  const form = new FormData();
  form.append('file', blob, 'scene.wav');
  return api('/api/video/audio', { method: 'POST', body: form });
}

async function applyPrefill() {
  if (!pendingPrefill || !options?.enabled) return;
  const detail = pendingPrefill;
  pendingPrefill = null;

  el('video-script').value = detail.text;
  if (detail.model && detail.voice) {
    const id = `${detail.model}:${detail.voice}`;
    const select = el('video-voice');
    if (![...select.options].some((option) => option.value === id)) {
      const optionEl = document.createElement('option');
      optionEl.value = id;
      optionEl.textContent = `语音记录 · ${detail.voice}`;
      select.appendChild(optionEl);
    }
    select.value = id;
  }
  const status = el('video-split-status');
  const usable = (detail.sentences || [])
    .filter((sentence) => sentence.text && sentence.pcm && sentence.pcm.length)
    .slice(0, MAX_SCENES);

  // 声音复刻的预览是一整段录音；文本一长就是几十秒，Pexels 找不到那么长的
  // 竖屏素材，渲染必失败。这种「单段长音频」退回文本拆分，用同一个
  // model:voice 逐句合成 —— 会重新合成，但音色和记录一致。
  const singleLong = usable.length === 1 && [...usable[0].text].length > 60;

  if (usable.length && detail.sampleRate && !singleLong) {
    status.textContent = `正在载入 ${usable.length} 段记录音频…`;
    status.dataset.state = 'connecting';
    try {
      const uploaded = await Promise.all(
        usable.map((sentence) => uploadAudio(sentence.pcm, detail.sampleRate))
      );
      scenes = usable.map((sentence, index) => ({
        text: sentence.text,
        searchTerms: [],
        audioToken: uploaded[index].token,
      }));
      renderScenes();
      saveDraft();
      status.textContent = '已使用记录里的音频，正在补检索词…';
      await fillMissingTerms();
    } catch (error) {
      status.textContent = `记录音频载入失败：${error.message}`;
      status.dataset.state = 'error';
    }
    return;
  }

  // No samples, or one long clip: fall back to the text path. For the long
  // clip the same voice is re-synthesised sentence by sentence.
  saveDraft();
  status.textContent = singleLong
    ? '整段录音太长，自动拆句后会用同一音色重新合成…'
    : '来自语音记录，正在拆场景…';
  status.dataset.state = 'connecting';
  splitWithAI();
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
  el('video-fill-terms').addEventListener('click', fillMissingTerms);
  el('video-create').addEventListener('click', createVideo);
  el('video-logs-open')?.addEventListener('click', () => openRenderLog());
  el('video-library-open')?.addEventListener('click', () => openLibrary());
  el('video-library-close')?.addEventListener('click', () => el('video-library').close());
  el('video-library-refresh')?.addEventListener('click', () => loadLibrary());
  el('video-library-show-blacklisted')?.addEventListener('change', () => loadLibrary());
  el('video-review-close')?.addEventListener('click', () => el('video-review').close());
  el('video-review-render')?.addEventListener('click', () => renderReview());
  el('video-log-close')?.addEventListener('click', () => el('video-log').close());
  el('video-log-refresh')?.addEventListener('click', () => openRenderLog());
  el('video-log-copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el('video-log-body').textContent || '');
      el('video-log-copy').textContent = '已复制';
      setTimeout(() => (el('video-log-copy').textContent = '复制'), 1500);
    } catch (_) {
      /* clipboard permission is not worth an error banner */
    }
  });
  el('render-badge')?.addEventListener('click', () => document.querySelector('[data-tab="video"]')?.click());
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

  window.addEventListener(SHORT_VIDEO_EVENT, (event) => {
    pendingPrefill = event.detail || null;
    document.querySelector('[data-tab="video"]')?.click();
    applyPrefill();
  });

  jobLog = readJobLog();
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
      refreshVideos();
      schedulePoll();
      applyPrefill();
    })
    .catch((error) => {
      disabled(`短视频不可用：${error.message}`);
    });
}

export { splitLocal, textToTerms };
