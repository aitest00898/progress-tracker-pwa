import { clone, dateKey, isoNow } from './schema.js';
import { effectiveDue, reminderOccurrence } from './engine.js';
import { validateState } from './schema.js';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ALLOWED_META = ['page', 'view', 'scope', 'result', 'reason', 'count', 'durationMs', 'status', 'source', 'flow', 'type', 'fieldCount', 'itemCount', 'categoryCount'];

function safeMeta(meta = {}) {
  const result = {};
  for (const key of ALLOWED_META) {
    const value = meta[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') result[key] = value.slice(0, 120).replace(/[\u0000-\u001f]/g, '');
    else if (typeof value === 'number' || typeof value === 'boolean') result[key] = value;
  }
  return result;
}

function trimDiagnostics(state, now = new Date()) {
  const cutoff = now.getTime() - RETENTION_MS;
  state.diagnostics.events = (state.diagnostics.events ?? []).filter((event) => new Date(event.at).getTime() >= cutoff);
  state.diagnostics.errors = (state.diagnostics.errors ?? []).slice(-500);
}

export function recordSemantic(state, type, metadata = {}, at = isoNow()) {
  if (!state.settings.developerEnabled) return false;
  state.diagnostics.events.push({ id: `event_${Date.now()}_${Math.random().toString(36).slice(2)}`, type: String(type).slice(0, 80), metadata: safeMeta(metadata), at });
  const aggregate = state.diagnostics.aggregates[type] ?? { count: 0, firstAt: at, lastAt: at };
  aggregate.count += 1; aggregate.lastAt = at;
  state.diagnostics.aggregates[type] = aggregate;
  trimDiagnostics(state);
  return true;
}

export function recordError(state, error, source = 'unknown', at = isoNow()) {
  if (!state.settings.developerEnabled) return false;
  const value = error instanceof Error ? error : new Error(String(error));
  state.diagnostics.errors.push({ id: `error_${Date.now()}_${Math.random().toString(36).slice(2)}`, name: value.name.slice(0, 80), message: value.name.slice(0, 80), source: String(source).slice(0, 80), at });
  trimDiagnostics(state);
  return true;
}

export function recordPerformance(state, metric, durationMs, metadata = {}, at = isoNow()) {
  if (!state.settings.developerEnabled) return false;
  state.performance.push({ id: `perf_${Date.now()}_${Math.random().toString(36).slice(2)}`, metric: String(metric).slice(0, 80), durationMs: Math.max(0, Math.round(Number(durationMs) * 100) / 100), metadata: safeMeta(metadata), at });
  state.performance = state.performance.slice(-1000);
  return true;
}

export function clearDiagnostics(state) {
  state.diagnostics.events = [];
  state.diagnostics.errors = [];
  state.diagnostics.aggregates = {};
  state.performance = [];
}

export function dataHealth(state) {
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

export function diagnosticReport(state, appVersion = '1.0.0') {
  trimDiagnostics(state);
  const health = dataHealth(state);
  return {
    reportVersion: 1, generatedAt: isoNow(), appVersion, dbVersion: state.meta.schemaVersion,
    dataset: { datasetId: state.meta.datasetId, revision: state.meta.revision, itemCount: state.items.length, categoryCount: state.categories.length },
    errors: clone(state.diagnostics.errors), performance: clone(state.performance), usageAggregates: clone(state.diagnostics.aggregates),
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
