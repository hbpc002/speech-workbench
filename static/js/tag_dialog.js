// The AI dialogs behind 加情感标签 / 快速标注 / 写口播稿, shared by both tabs.
//
// One `<dialog>` in the markup serves the synthesis tab and the clone-generation
// tab. That forces everything here to be told, at open time, *which* script box
// it is working on -- the failure mode otherwise is an `apply` handler that
// writes into the other tab's textarea, which looks like "the AI tags my script
// and the text never changes" and is invisible until someone uses both tabs.
//
// So the module holds only what belongs to the dialog (the preview it is showing,
// which entry point opened it), and every per-tab fact arrives as an argument:
//
//   textarea      the box the result goes into
//   scriptBox     its undo stack, so an applied result can be walked back
//   supportsTags  does the current model understand `[tags]`? Re-checked at
//                 apply time, because the model can be switched while the
//                 dialog is open and the tags would then be read out literally
//   readOptions   this tab's 标注模型 / 密度 / 拟声标签
//   report        where a refusal ("请先输入文本") is shown
//   label         what this tab calls its script box, for the apply button
//
// DOM is injected for `createTagTagger`'s per-tab pieces and reached through
// `el()` for the dialog's own ids. The imports are deliberately `./http.js` and
// `./dom.js` rather than `./app.js`: importing app.js runs boot(), so a module
// that did that could never be imported under `node --test` again.

import { el, state } from './dom.js';
import { splitSentences } from './audio.js';
import { applyRules } from './tag_rules.js';
import { api } from './http.js';
import { VOICEOVER_PROMPT } from './voiceover_prompt.js';

/** Sentinel option value meaning "let me type my own". */
const CUSTOM = '__custom__';

/** What the dialog is currently previewing. */
let pendingResult = null;

// Which entry opened the dialog. The 返回 step only makes sense for the script
// form (写稿 → 生成 → 改参数重来); the two tagging entries have no earlier screen,
// so they must not offer a way back into the script form.
let dialogOrigin = null;

/** The tab that opened it, as given to the last open*() call. */
let target = null;

/** How to send the request that just failed, for the 重试 button. */
let retryAction = null;

/** Pending slow-response hint, so it can be cancelled. */
let slowTimer = null;

let wired = false;

/**
 * Wire the dialog's own buttons, exactly once.
 *
 * Both tabs call createTagTagger() at init; if each also wired these ids, every
 * click would run the handler twice -- generating twice, and with two different
 * target boxes racing to be written to.
 */
function wireDialog() {
  if (wired) return;
  wired = true;

  el('tts-ai-run').addEventListener('click', () => requestScript());
  el('tts-ai-retry').addEventListener('click', retry);
  el('tts-ai-close').addEventListener('click', closeDialog);
  el('tts-ai-cancel').addEventListener('click', closeDialog);
  el('tts-ai-apply').addEventListener('click', applyResult);
  el('tts-ai-back').addEventListener('click', backFromResult);
  el('tag-help-close').addEventListener('click', () => el('tag-help').close());
  el('tag-help-copy').addEventListener('click', copyTagHelp);
}

/**
 * The three entry points, bound to one script box.
 *
 * `renderPresets` is separate because the preset dropdowns and the topic hints
 * live in the dialog, which is shared, while the 标注参数 dropdowns live in each
 * panel. Both tabs call it; it is idempotent.
 */
export function createTagTagger({
  textarea,
  scriptBox,
  supportsTags,
  readOptions,
  report = () => {},
  label = '文本框',
}) {
  if (!textarea || !scriptBox) throw new Error('createTagTagger needs a textarea and a scriptBox');
  wireDialog();
  renderPresets();

  const bind = (as) => () => {
    target = { textarea, scriptBox, supportsTags, readOptions, report, label };
    as();
  };

  return {
    openTags: bind(requestTags),
    openFast: bind(requestFastTags),
    openScript: bind(openScriptDialog),
  };
}

/** Is a tagging provider configured at all? Absent `llm` predates the feature. */
export function aiConfigured() {
  const tagger = state.config && state.config.llm;
  return !!(tagger && tagger.configured);
}

/**
 * Grey out the AI buttons when no provider is configured or tags are moot.
 *
 * Shared so the two tabs cannot disagree about when 快速标注 -- which needs no
 * network at all -- is still offered.
 */
export function syncTagActions({ ids, supported, configured = aiConfigured(), syncStrip = () => {} }) {
  const ready = supported && configured;
  for (const id of [ids.ai, ids.write]) {
    el(id).disabled = !ready;
  }
  // The local rules need no provider, so only the tag support matters.
  el(ids.fast).disabled = !supported;
  syncStrip();

  const note = el(ids.note);
  if (!supported) {
    note.hidden = false;
    note.textContent = '当前模型不支持情感标签';
  } else if (!configured) {
    note.hidden = false;
    note.textContent = '未配置 LLM_API_KEY，AI 功能不可用';
  } else {
    note.hidden = true;
  }
}

// ---- options ---------------------------------------------------------------

function tagOptions() {
  return target.readOptions();
}

/** Local rules only understand the on/off distinction, not the budget. */
function richAllowed() {
  return tagOptions().rich_level !== 'off';
}

/**
 * Fill a `<select>` from a preset list.
 *
 * `allowCustom` appends a 自定义… escape hatch. The model picker must not have
 * one -- the server validates model ids against a whitelist, so a free-text
 * option would only ever be rejected -- but 时长/语气/听众 are prompt fragments,
 * and locking users into a preset list would strand anyone with an unusual
 * audience.
 */
export function fillSelect(node, items, selected, allowCustom = false) {
  node.innerHTML = '';
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name;
    node.appendChild(option);
  }
  if (allowCustom) {
    const option = document.createElement('option');
    option.value = CUSTOM;
    option.textContent = '自定义…';
    node.appendChild(option);
  }
  const ids = items.map((item) => item.id);
  const wanted = selected && ids.includes(selected) ? selected : ids[0];
  node.value = wanted || CUSTOM;
}

/** The preset, or whatever the user typed when they picked 自定义…. */
function scriptField(selectId, inputId) {
  const select = el(selectId);
  return select.value === CUSTOM ? el(inputId).value.trim() : select.value;
}

/**
 * The presets inside the shared dialog: 时长 / 语气 / 目标听众, the topic hints,
 * and the 自定义… boxes that follow them.
 *
 * Idempotent and called by both tabs, because the dialog it fills is shared. The
 * `change` listeners are guarded for the same reason: a second one would only
 * duplicate the work.
 */
export function renderPresets() {
  const tags = (state.config && state.config.tags) || {};

  fillSelect(el('tts-ai-duration'), tags.durations || [], '60 秒', true);
  fillSelect(el('tts-ai-tone'), tags.tones || [], '亲切自然', true);
  fillSelect(el('tts-ai-audience'), tags.audiences || [], '宝妈', true);

  const hints = el('tts-ai-topic-hints');
  hints.innerHTML = '';
  for (const hint of tags.topic_hints || []) {
    const option = document.createElement('option');
    option.value = hint;
    hints.appendChild(option);
  }

  for (const [selectId, wrapId] of [
    ['tts-ai-duration', 'tts-ai-duration-wrap'],
    ['tts-ai-tone', 'tts-ai-tone-wrap'],
    ['tts-ai-audience', 'tts-ai-audience-wrap'],
  ]) {
    const select = el(selectId);
    const wrap = el(wrapId);
    const sync = () => {
      wrap.hidden = select.value !== CUSTOM;
    };
    if (!select.dataset.presetsWired) {
      select.dataset.presetsWired = '';
      select.addEventListener('change', sync);
    }
    sync();
  }
}

// ---- dialog plumbing -------------------------------------------------------

function closeDialog() {
  const dialog = el('tts-ai');
  if (dialog.open) dialog.close();
  pendingResult = null;
  dialogOrigin = null;
  retryAction = null;
  clearSlowHint();
}

/** showModal() throws if the dialog is already up, which 返回 would otherwise hit. */
function showDialog() {
  const dialog = el('tts-ai');
  if (!dialog.open) dialog.showModal();
}

/**
 * After this long, say so -- a long script can legitimately take a while, and a
 * silent dialog with two dead buttons reads as a hang.
 */
const SLOW_AFTER_MS = 5000;

/**
 * Show the loading screen, run `request()`, then land on the result or the error.
 *
 * `request` is a function, not a promise, so the failure path can offer to send
 * the exact same request again: closing the dialog and reopening it means
 * retyping the topic, and that is the moment an operator gives up on a feature
 * that would have worked on the second try.
 */
async function withLoading(title, request) {
  el('tts-ai-title').textContent = title;
  el('tts-ai-form').hidden = true;
  el('tts-ai-result').hidden = false;
  el('tts-ai-compare').hidden = true;
  el('tts-ai-warnings').hidden = true;
  const error = el('tts-ai-error');
  error.hidden = true;
  el('tts-ai-summary').textContent = '模型正在处理…';
  // Nothing to apply until there is a result, and nothing to retry yet either.
  el('tts-ai-apply').hidden = true;
  el('tts-ai-retry').hidden = true;
  retryAction = null;
  showDialog();
  startSlowHint();

  try {
    showResult(await request());
  } catch (err) {
    error.hidden = false;
    error.textContent = err.message || String(err);
    el('tts-ai-summary').textContent = '';
    retryAction = request;
    el('tts-ai-retry').hidden = false;
  } finally {
    clearSlowHint();
  }
}

/** Swap the spinner line for a reassurance once it has been going a while. */
function startSlowHint() {
  clearSlowHint();
  slowTimer = setTimeout(() => {
    const summary = el('tts-ai-summary');
    // Only while the same screen is up; a result that arrived meanwhile clears it.
    if (summary.textContent === '模型正在处理…') {
      summary.textContent = '模型响应较慢，仍在等待…（被限流时服务端会自动重试两次）';
    }
  }, SLOW_AFTER_MS);
}

/** Drop a pending slow hint, so it cannot fire onto the next request's screen. */
function clearSlowHint() {
  if (slowTimer) {
    clearTimeout(slowTimer);
    slowTimer = null;
  }
}

function retry() {
  if (!retryAction) return;
  const again = retryAction;
  withLoading(el('tts-ai-title').textContent, again);
}

function showResult(payload) {
  pendingResult = payload;
  el('tts-ai-summary').textContent = `已插入 ${payload.inserted} 个标签`;
  // Named after the box the result is about to land in: 「文本框」 on the
  // synthesis tab, 「生成文本」 on the clone one.
  el('tts-ai-apply').textContent = `应用到${(target && target.label) || '文本框'}`;
  el('tts-ai-apply').hidden = false;
  // A result is in hand: there is nothing left to retry.
  retryAction = null;
  el('tts-ai-retry').hidden = true;

  const warnings = el('tts-ai-warnings');
  warnings.innerHTML = '';
  const list = payload.warnings || [];
  warnings.hidden = list.length === 0;
  for (const item of list) {
    const li = document.createElement('li');
    li.textContent = item;
    warnings.appendChild(li);
  }

  // Script mode invents the text, so there is no "before" to compare against.
  const compare = el('tts-ai-compare');
  compare.hidden = !payload.before;
  el('tts-ai-before').value = payload.before || '';
  el('tts-ai-after').value = payload.text || '';

  // Only the script form sits behind this result screen.
  el('tts-ai-back').hidden = dialogOrigin !== 'script';
}

// ---- the three entries -----------------------------------------------------

function requestTags() {
  const text = target.textarea.value.trim();
  if (!text) {
    target.report('请先输入文本');
    return;
  }
  // Read once, here: 重试 re-sends this closure, and the operator may have typed
  // in the meantime -- the request that was rejected was the one for this text.
  const options = tagOptions();
  dialogOrigin = 'tag';
  return withLoading('AI 加情感标签', () => api('/api/tts/tag', {
    method: 'POST',
    body: JSON.stringify({ text, ...options }),
  }).then((body) => ({ ...body, before: text })));
}

function requestScript() {
  const topic = el('tts-ai-topic').value.trim();
  if (!topic) {
    el('tts-ai-error').hidden = false;
    el('tts-ai-error').textContent = '请填写主题';
    return;
  }
  const options = tagOptions();
  const body = {
    topic,
    duration: scriptField('tts-ai-duration', 'tts-ai-duration-custom'),
    tone: scriptField('tts-ai-tone', 'tts-ai-tone-custom'),
    audience: scriptField('tts-ai-audience', 'tts-ai-audience-custom'),
    ...options,
  };
  dialogOrigin = 'script';
  return withLoading('AI 写口播稿', () => api('/api/tts/script', {
    method: 'POST',
    body: JSON.stringify(body),
  }).then((res) => ({ ...res, before: '' })));
}

/** The offline path: same preview, no network. */
function requestFastTags() {
  const text = target.textarea.value;
  if (!text.trim()) {
    target.report('请先输入文本');
    return;
  }
  const { density } = tagOptions();
  const { text: tagged, inserted } = applyRules(text, splitSentences(text), density, richAllowed());
  el('tts-ai-title').textContent = '快速标注';
  el('tts-ai-form').hidden = true;
  el('tts-ai-result').hidden = false;
  el('tts-ai-error').hidden = true;
  dialogOrigin = 'fast';
  showDialog();
  showResult({ text: tagged, before: text, inserted, warnings: [] });
}

function openScriptDialog() {
  dialogOrigin = 'script';
  el('tts-ai-title').textContent = 'AI 写口播稿';
  el('tts-ai-form').hidden = false;
  el('tts-ai-result').hidden = true;
  el('tts-ai-error').hidden = true;
  showDialog();
  el('tts-ai-topic').focus();
}

/** 返回 only rewinds to the brief; anything else just dismisses. */
function backFromResult() {
  if (dialogOrigin === 'script') openScriptDialog();
  else closeDialog();
}

function applyResult() {
  if (!pendingResult || !target) return;
  // The model may have been switched while the dialog was open, in which case
  // the tags would be read aloud verbatim.
  if (!target.supportsTags()) {
    closeDialog();
    target.report('当前模型不支持情感标签，未应用');
    return;
  }

  target.scriptBox.push(target.textarea.value);
  target.scriptBox.setText(pendingResult.text);
  closeDialog();
}

// ---- the prompt for an external AI ----------------------------------------

export function openHelp() {
  const dialog = el('tag-help');
  el('tag-help-body').value = VOICEOVER_PROMPT;
  el('tag-help-status').textContent = '';
  dialog.showModal();
}

async function copyTagHelp() {
  const body = el('tag-help-body');
  const status = el('tag-help-status');
  try {
    await navigator.clipboard.writeText(body.value);
    status.textContent = '已复制到剪贴板';
  } catch (_) {
    // Clipboard API needs a secure context; fall back to manual selection.
    body.select();
    status.textContent = '请手动复制（已全选）';
  }
}