// In-memory diagnostic log for the browser.
//
// Deliberately not persisted: these entries contain request ids and upstream
// messages that are useful for the current incident but stale by the next
// reload. The server scrubs credentials before putting anything in `debug`;
// this module still avoids touching request bodies, headers or audio.

export const MAX_ENTRIES = 500;

const LABELS = {
  cmd: 'cmd',
  ok: 'ok',
  info: 'info',
  warn: 'warn',
  error: 'err',
  system: 'sys',
};

let entries = [];
let nextId = 1;
let revision = 0;
const listeners = new Set();

function now() {
  return Date.now();
}

function normalizeDetail(detail) {
  if (detail === undefined || detail === null) return null;
  if (detail instanceof Error) {
    return { name: detail.name, message: detail.message };
  }
  return detail;
}

function notify(event) {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (_) {
      // A broken renderer must not break the request that logged the entry.
    }
  }
}

function push(level, message, detail = null) {
  const entry = {
    id: nextId++,
    at: now(),
    level: LABELS[level] ? level : 'info',
    message: String(message ?? ''),
    detail: normalizeDetail(detail),
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(entries.length - MAX_ENTRIES);
  }
  revision += 1;
  notify({ type: 'record', entry, revision });
  return entry;
}

export function record(level, message, detail = null) {
  return push(level, message, detail);
}

export function command(message, detail = null) {
  return push('cmd', message, detail);
}

export function info(message, detail = null) {
  return push('info', message, detail);
}

export function ok(message, detail = null) {
  return push('ok', message, detail);
}

export function warn(message, detail = null) {
  return push('warn', message, detail);
}

export function error(message, detail = null) {
  return push('error', message, detail);
}

export function system(message, detail = null) {
  return push('system', message, detail);
}

export function snapshot() {
  return entries.map((entry) => ({ ...entry }));
}

export function revisionOf() {
  return revision;
}

export function errorCount() {
  return entries.filter((entry) => entry.level === 'error').length;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clear() {
  entries = [];
  revision += 1;
  notify({ type: 'clear', revision });
}

export function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

export function formatTime(ts) {
  const date = new Date(ts);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function formatDetail(detail) {
  if (detail === null || detail === undefined) return '';
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail, null, 2);
  } catch (_) {
    return String(detail);
  }
}

export function formatEntry(entry, { includeDetail = true } = {}) {
  const time = formatTime(entry.at);
  const label = (LABELS[entry.level] || entry.level).padEnd(3);
  let text = `${time} [${label}] ${entry.message}`;
  if (includeDetail) {
    const detail = formatDetail(entry.detail);
    if (detail) text += `\n${detail.split('\n').map((line) => `  ${line}`).join('\n')}`;
  }
  return text;
}

export function formatAll({ includeDetail = true } = {}) {
  return entries.map((entry) => formatEntry(entry, { includeDetail })).join('\n\n');
}
