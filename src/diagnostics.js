import { isoNow } from './schema.js';
import { effectiveDue, reminderOccurrence } from './engine.js';
import { validateState } from './schema.js';

/** @typedef {import('./types.js').AppState} AppState */
/** @typedef {import('./types.js').DiagnosticsState} DiagnosticsState */

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ALLOWED_META = ['page', 'view', 'scope', 'result', 'reason', 'count', 'durationMs', 'status', 'source', 'flow', 'type', 'fieldCount', 'itemCount', 'categoryCount'];
const DIAGNOSTIC_MESSAGE_MAX = 240;
const DIAGNOSTIC_LABEL_MAX = 80;
const REDACTED_MESSAGE = 'Diagnostic message redacted';

const TECHNICAL_MESSAGE_HINTS = /\b(?:error|exception|failed|failure|invalid|missing|required|unavailable|unsupported|timeout|timed out|quota|storage|database|indexeddb|service worker|network|fetch|sync|drive|authorization|permission|blocked|cycle|validation|migration|restore|import|export|reminder|not found|conflict|offline|parse|format|schema|state|snapshot|request|response|connection|oauth)\b/i;
const TOKEN_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:ya29\.|1\/\/|AIza[0-9A-Za-z_-]{20,}|sk-[0-9A-Za-z_-]{16,}|gh[pousr]_[0-9A-Za-z_\-]{16,}|xox[baprs]-[0-9A-Za-z-]{16,})[0-9A-Za-z._~+\/-]*/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];
const URL_PATTERN = /\b(?:https?|file|data|javascript):\/\/[^\s<>"']+/gi;
const PATH_PATTERN = /(?:^|\s)(?:\/(?:Users|private|tmp|var|Volumes|home|Applications|System|opt)\/[^\s,;]+|[A-Za-z]:\\[^\s,;]+)/gi;

function safeLabel(value, fallback = 'unknown') {
  const normalized = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, DIAGNOSTIC_LABEL_MAX);
  return /^[A-Za-z0-9_.:-]+$/.test(normalized) ? normalized : fallback;
}

function sanitizeMessageResult(value) {
  const original = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!original) return { message: null, redacted: true };
  let message = original.slice(0, DIAGNOSTIC_MESSAGE_MAX);
  let redacted = message !== original;
  for (const pattern of TOKEN_PATTERNS) {
    const next = message.replace(pattern, '[redacted-token]');
    redacted ||= next !== message;
    message = next;
  }
  const nextUrl = message.replace(URL_PATTERN, '[redacted-url]');
  redacted ||= nextUrl !== message;
  message = nextUrl;
  const nextPath = message.replace(PATH_PATTERN, ' [redacted-path]');
  redacted ||= nextPath !== message;
  message = nextPath.trim();
  if (!TECHNICAL_MESSAGE_HINTS.test(message) && !redacted) return { message: null, redacted: true };
  return { message: message.slice(0, DIAGNOSTIC_MESSAGE_MAX), redacted };
}

export function sanitizeDiagnosticMessage(value) { return sanitizeMessageResult(value).message ?? REDACTED_MESSAGE; }

function safeErrorCode(value) {
  const code = String(value ?? '').trim().slice(0, DIAGNOSTIC_LABEL_MAX);
  return /^[A-Za-z0-9_.:-]+$/.test(code) ? code : null;
}

function safeTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime()) ? value : null;
}

export function serializeSafeDiagnosticError(entry = {}) {
  const serialized = {
    id: safeLabel(entry.id, 'error'),
    name: safeLabel(entry.name, 'Error'),
    errorCode: safeErrorCode(entry.errorCode),
    source: safeLabel(entry.source, 'unknown'),
    at: safeTimestamp(entry.at),
    classification: entry.classification === 'technical' ? 'technical' : 'redacted',
  };
  const message = sanitizeMessageResult(entry.message).message;
  if (message && entry.classification === 'technical' && entry.redacted !== true) serialized.message = message;
  return serialized;
}

function serializeSafePerformance(entry = {}) {
  const durationMs = Number(entry.durationMs);
  return {
    id: safeLabel(entry.id, 'performance'),
    metric: safeLabel(entry.metric, 'unknown_metric'),
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs * 100) / 100) : 0,
    metadata: safeMeta(entry.metadata),
    at: safeTimestamp(entry.at),
  };
}

function serializeSafeAggregates(aggregates = {}) {
  const result = {};
  for (const [key, value] of Object.entries(aggregates)) {
    const label = safeLabel(key, '');
    if (!label || !value || typeof value !== 'object') continue;
    result[label] = {
      count: Number.isFinite(Number(value.count)) ? Math.max(0, Math.floor(Number(value.count))) : 0,
      firstAt: safeTimestamp(value.firstAt),
      lastAt: safeTimestamp(value.lastAt),
    };
  }
  return result;
}

/** @param {Record<string, unknown>} [meta] @returns {Record<string, unknown>} */
function safeMeta(meta = /** @type {Record<string, unknown>} */ ({})) {
  const result = /** @type {Record<string, unknown>} */ ({});
  for (const key of ALLOWED_META) {
    const value = meta[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      const normalized = value.slice(0, 120).replace(/[\u0000-\u001f\u007f]/g, '').trim();
      if (/^[A-Za-z0-9_.:/-]+$/.test(normalized)) result[key] = normalized;
    }
    else if (typeof value === 'number' || typeof value === 'boolean') result[key] = value;
  }
  return result;
}

function trimDiagnostics(state, now = new Date()) {
  const cutoff = now.getTime() - RETENTION_MS;
  state.diagnostics.events = (state.diagnostics.events ?? []).filter((event) => new Date(event.at).getTime() >= cutoff);
  state.diagnostics.errors = (state.diagnostics.errors ?? []).slice(-500);
}

/** @param {AppState} state @param {string} type @param {Record<string, unknown>} [metadata] @param {string} [at] @returns {boolean} */
export function recordSemantic(state, type, metadata = /** @type {Record<string, unknown>} */ ({}), at = isoNow()) {
  if (!state.settings.developerEnabled) return false;
  const eventType = safeLabel(type, 'unknown_event');
  state.diagnostics.events.push({ id: `event_${Date.now()}_${Math.random().toString(36).slice(2)}`, type: eventType, metadata: safeMeta(metadata), at });
  const aggregate = state.diagnostics.aggregates[eventType] ?? { count: 0, firstAt: at, lastAt: at };
  aggregate.count += 1; aggregate.lastAt = at;
  state.diagnostics.aggregates[eventType] = aggregate;
  trimDiagnostics(state);
  return true;
}

/** @param {AppState} state @param {unknown} error @param {string} [source] @param {string} [at] @returns {boolean} */
export function recordError(state, error, source = 'unknown', at = isoNow()) {
  if (!state.settings.developerEnabled) return false;
  const value = error instanceof Error ? error : new Error(String(error));
  const safeMessage = sanitizeMessageResult(value.message);
  state.diagnostics.errors.push({
    id: `error_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    name: safeLabel(value.name, 'Error'),
    message: safeMessage.message,
    errorCode: safeErrorCode(/** @type {Error & {code?: unknown}} */ (value).code),
    source: safeLabel(source),
    at,
    classification: safeMessage.message && !safeMessage.redacted ? 'technical' : 'redacted',
    redacted: safeMessage.redacted,
  });
  trimDiagnostics(state);
  return true;
}

/** @param {AppState} state @param {string} metric @param {number} durationMs @param {Record<string, unknown>} [metadata] @param {string} [at] @returns {boolean} */
export function recordPerformance(state, metric, durationMs, metadata = /** @type {Record<string, unknown>} */ ({}), at = isoNow()) {
  if (!state.settings.developerEnabled) return false;
  state.performance.push({ id: `perf_${Date.now()}_${Math.random().toString(36).slice(2)}`, metric: safeLabel(metric, 'unknown_metric'), durationMs: Math.max(0, Math.round(Number(durationMs) * 100) / 100), metadata: safeMeta(metadata), at });
  state.performance = state.performance.slice(-1000);
  return true;
}

export function clearDiagnostics(state) {
  state.diagnostics.events = [];
  state.diagnostics.errors = [];
  state.diagnostics.aggregates = {};
  state.performance = [];
}

/** @param {AppState} state @returns {{ok:boolean,errors:Array<Record<string, any>>,checkedAt:string,counts:{categories:number,items:number,history:number,reminders:number}}} */
export function dataHealth(state) {
  /** @type {Array<Record<string, any>>} */
  const errors = [...validateState(state)];
  const itemIds = new Set(state.items.map((item) => item.id));
  for (const reminder of state.reminders) {
    if (!itemIds.has(reminder.itemId)) errors.push({ type: 'reminder_inconsistency', reminderId: reminder.id });
    if (reminder.type === 'absolute' && reminder.at && Number.isNaN(new Date(reminder.at).getTime())) errors.push({ type: 'invalid_reminder_date', reminderId: reminder.id });
  }
  for (const item of state.items) {
    if (item.dueMode === 'explicit' && item.dueDate && Number.isNaN(new Date(item.dueDate).getTime())) errors.push({ type: 'invalid_date', itemId: item.id, field: 'dueDate' });
    if (item.plannedStart && Number.isNaN(new Date(item.plannedStart).getTime())) errors.push({ type: 'invalid_date', itemId: item.id, field: 'plannedStart' });
    for (const reminder of state.reminders.filter((candidate) => candidate.itemId === item.id)) {
      if (reminder.type === 'relative' && !effectiveDue(state, item.id).value) errors.push({ type: 'reminder_without_due', reminderId: reminder.id });
      try { reminderOccurrence(state, reminder); } catch { errors.push({ type: 'reminder_calculation_exception', reminderId: reminder.id }); }
    }
  }
  return { ok: errors.length === 0, errors, checkedAt: isoNow(), counts: { categories: state.categories.length, items: state.items.length, history: state.history.length, reminders: state.reminders.length } };
}

export function capabilityReport() {
  return {
    indexedDB: Boolean(globalThis.indexedDB), serviceWorker: Boolean(globalThis.navigator?.serviceWorker), notifications: Boolean(globalThis.Notification),
    vibration: Boolean(globalThis.navigator?.vibrate) && /Android/i.test(globalThis.navigator?.userAgent ?? ''),
    storageEstimate: Boolean(globalThis.navigator?.storage?.estimate), push: Boolean(globalThis.PushManager), googleIdentityServices: Boolean(globalThis.google?.accounts?.oauth2),
    generatedAt: isoNow(),
  };
}

function bytes(value) {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { return 0; }
}

/** @param {AppState} state @param {string} [appVersion] */
export function diagnosticReport(state, appVersion = '1.0.0') {
  trimDiagnostics(state);
  const health = dataHealth(state);
  return {
    reportVersion: 1, generatedAt: isoNow(), appVersion, dbVersion: state.meta.schemaVersion,
    dataset: { datasetId: state.meta.datasetId, revision: state.meta.revision, itemCount: state.items.length, categoryCount: state.categories.length },
    errors: state.diagnostics.errors.map((entry) => serializeSafeDiagnosticError(entry)), performance: state.performance.map((entry) => serializeSafePerformance(entry)), usageAggregates: serializeSafeAggregates(state.diagnostics.aggregates),
    dataHealth: health, capabilities: capabilityReport(),
    semanticEventMetadata: { eventCount: state.diagnostics.events.length, retainedSince: state.diagnostics.events[0]?.at ?? null },
    storageBytes: { diagnostics: bytes(state.diagnostics), performance: bytes(state.performance) },
    privacy: { includesUserContent: false, includesOAuthTokens: false, includesCredentials: false },
  };
}

export function sessionWasAbnormal(state) {
  return Boolean(state.meta.lastSession && state.meta.lastSession.normal === false && state.meta.lastSession.startedAt);
}

export function purgeDiagnostics(state, now = new Date()) { trimDiagnostics(state, now); }
