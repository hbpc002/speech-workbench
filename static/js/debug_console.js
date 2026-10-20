// The bottom drawer that makes `debug_log.js` usable without devtools.
//
// It is deliberately a mirror, not a source of truth: closing or clearing the
// drawer does not affect a request, and the log is memory-only so a refresh
// starts from a clean page.

import { el } from './dom.js';
import {
  clear,
  errorCount,
  formatAll,
  formatDetail,
  formatTime,
  snapshot,
  subscribe,
} from './debug_log.js';

let bound = false;
let initialized = false;
let toggleNode = null;
let panelNode = null;
let linesNode = null;
let summaryNode = null;
let countNode = null;
let errorsOnlyNode = null;
let errorsOnly = false;
let isOpen = false;

function setStatus(text) {
  if (!summaryNode) return;
  summaryNode.textContent = text;
}

function bind() {
  if (bound) return;
  toggleNode = el('debug-toggle');
  panelNode = el('debug-console');
  linesNode = el('debug-lines');
  summaryNode = el('debug-summary');
  countNode = el('debug-count');
  errorsOnlyNode = el('debug-errors-only');
  if (!toggleNode || !panelNode || !linesNode) return;
  bound = true;
}

function updateBadge() {
  const count = errorCount();
  if (countNode) {
    countNode.hidden = count === 0;
    countNode.textContent = String(count);
  }
  toggleNode?.classList.toggle('has-error', count > 0);
}

function addLine(parent, className, text) {
  const node = document.createElement('div');
  node.className = className;
  node.textContent = text;
  parent.appendChild(node);
  return node;
}

export function renderDebugConsole() {
  bind();
  if (!linesNode) return;
  const entries = snapshot();
  const visible = errorsOnly ? entries.filter((entry) => entry.level === 'error') : entries;
  const nearBottom =
    (linesNode.scrollTop || 0) + (linesNode.clientHeight || 0) >= (linesNode.scrollHeight || 0) - 24;

  linesNode.innerHTML = '';
  if (!visible.length) {
    addLine(linesNode, 'debug-empty', errorsOnly ? '没有错误日志。' : '暂无日志。');
  }
  for (const entry of visible) {
    const row = document.createElement('div');
    row.className = `debug-entry debug-${entry.level}`;
    const head = document.createElement('div');
    head.className = 'debug-line';
    addLine(head, 'debug-time', formatTime(entry.at));
    addLine(head, 'debug-level', `[${entry.level}]`);
    addLine(head, 'debug-message', entry.message);
    row.appendChild(head);
    const detail = formatDetail(entry.detail);
    if (detail) addLine(row, 'debug-detail', detail);
    linesNode.appendChild(row);
  }
  updateBadge();
  setStatus(`仅当前页面 · ${entries.length} 条`);
  if (nearBottom) linesNode.scrollTop = linesNode.scrollHeight;
}

export function openDebugConsole() {
  bind();
  if (!panelNode) return;
  isOpen = true;
  panelNode.hidden = false;
  toggleNode?.setAttribute('aria-expanded', 'true');
  renderDebugConsole();
  linesNode.scrollTop = linesNode.scrollHeight;
}

export function closeDebugConsole() {
  bind();
  if (!panelNode) return;
  isOpen = false;
  panelNode.hidden = true;
  toggleNode?.setAttribute('aria-expanded', 'false');
}

function toggleDebugConsole() {
  if (isOpen) closeDebugConsole();
  else openDebugConsole();
}

async function copyLog() {
  const text = formatAll();
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    setStatus('已复制到剪贴板');
  } catch (_) {
    setStatus('复制失败，请手动选择日志');
  }
}

export function initDebugConsole() {
  bind();
  if (!bound || initialized) return;
  initialized = true;
  panelNode.hidden = true;
  toggleNode.setAttribute('aria-expanded', 'false');
  subscribe((event) => {
    renderDebugConsole();
    if (
      event.type === 'record' &&
      event.entry.level === 'error' &&
      Number(event.entry.detail?.status) >= 500
    ) {
      openDebugConsole();
    }
  });
  toggleNode.addEventListener('click', toggleDebugConsole);
  el('debug-close')?.addEventListener('click', closeDebugConsole);
  el('debug-clear')?.addEventListener('click', () => {
    clear();
    renderDebugConsole();
    setStatus('已清空');
  });
  el('debug-copy')?.addEventListener('click', copyLog);
  errorsOnlyNode?.addEventListener('change', () => {
    errorsOnly = Boolean(errorsOnlyNode.checked);
    renderDebugConsole();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen) closeDebugConsole();
  });
  renderDebugConsole();
}
