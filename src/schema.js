export const APP_VERSION = '1.0.0';
export const SCHEMA_VERSION = 1;
export const DAY_MS = 24 * 60 * 60 * 1000;

export function newId(prefix = 'id') {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random}`;
}

export function isoNow() {
  return new Date().toISOString();
}

export function dateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function emptySettings() {
  return {
    language: 'zh-TW',
    theme: 'system',
    defaultPage: 'categories',
    defaultCategoryId: null,
    defaultSmartView: 'today',
    smartSort: false,
    showCompleted: true,
    overdueExpanded: true,
    developerEnabled: false,
    experimental: {
      enabled: true,
      smart: true,
      routine: true,
      reminderLearning: true,
    },
    defaultReminderTime: '09:00',
    cloudSync: { enabled: false, clientId: '', authorized: false, status: 'disabled', accountId: null, fileId: null, backupFolderId: null, visibleBackups: [], lastSyncAt: null },
    focusByCategory: {},
    expandedByCategory: {},
    smartOrders: {},
    firstHints: {},
  };
}

export function makeCategory(title, order = 0, now = isoNow()) {
  return {
    id: newId('cat'),
    title,
    order,
    createdAt: now,
    updatedAt: now,
  };
}

export function makeItem({ categoryId, parentId = null, title, order = 0, now = isoNow() }) {
  return {
    id: newId('item'),
    categoryId,
    parentId,
    title,
    status: 'active',
    activeOrder: order,
    completedOrder: order,
    priority: 'none',
    importance: 0,
    plannedStart: null,
    dueMode: 'inherit',
    dueDate: null,
    notes: '',
    tags: [],
    createdAt: now,
    firstCompletedAt: null,
    completedAt: null,
    reopenedAt: null,
    reopenOrder: null,
    revision: 0,
    baseRevision: 0,
    fieldRevisions: {},
    updatedAt: now,
  };
}

export function makeEmptyState(now = isoNow()) {
  const category = makeCategory('我的計畫', 0, now);
  const settings = emptySettings();
  settings.defaultCategoryId = category.id;
  return {
    meta: {
      schemaVersion: SCHEMA_VERSION,
      appVersion: APP_VERSION,
      datasetId: newId('dataset'),
      revision: 0,
      baseRevision: 0,
      clientId: newId('client'),
      accountId: null,
      createdAt: now,
      updatedAt: now,
      lastRolloverDate: dateKey(now),
      recoveryMode: false,
      lastSession: { startedAt: now, endedAt: now, normal: true },
    },
    categories: [category],
    items: [],
    history: [],
    reminders: [],
    today: { lastRolloverDate: dateKey(now), items: {} },
    settings,
    smartOrders: {},
    syncChanges: [],
    conflicts: [],
    conflictArchive: [],
    deleted: [],
    backupMeta: [],
    migrationSnapshots: [],
    recoverySnapshots: [],
    diagnostics: { events: [], errors: [], aggregates: {}, lastSession: null },
    performance: [],
    capabilities: {},
  };
}

export function normalizeState(input, now = isoNow()) {
  const state = clone(input ?? makeEmptyState(now));
  const fallback = makeEmptyState(now);
  state.meta = { ...fallback.meta, ...(state.meta ?? {}) };
  state.meta.schemaVersion = SCHEMA_VERSION;
  state.meta.appVersion = APP_VERSION;
  state.categories = Array.isArray(state.categories) ? state.categories : [];
  state.items = Array.isArray(state.items) ? state.items : [];
  state.history = Array.isArray(state.history) ? state.history : [];
  state.reminders = Array.isArray(state.reminders) ? state.reminders : [];
  state.today = { ...fallback.today, ...(state.today ?? {}), items: { ...(state.today?.items ?? {}) } };
  state.settings = {
    ...fallback.settings,
    ...(state.settings ?? {}),
    experimental: { ...fallback.settings.experimental, ...(state.settings?.experimental ?? {}) },
    cloudSync: { ...fallback.settings.cloudSync, ...(state.settings?.cloudSync ?? {}) },
    focusByCategory: { ...(state.settings?.focusByCategory ?? {}) },
    expandedByCategory: { ...(state.settings?.expandedByCategory ?? {}) },
    smartOrders: { ...(state.settings?.smartOrders ?? {}) },
    firstHints: { ...(state.settings?.firstHints ?? {}) },
  };
  state.settings.cloudSync.visibleBackups = Array.isArray(state.settings.cloudSync.visibleBackups) ? state.settings.cloudSync.visibleBackups : [];
  state.smartOrders = { ...(state.smartOrders ?? {}) };
  state.syncChanges = Array.isArray(state.syncChanges) ? state.syncChanges : [];
  state.conflicts = Array.isArray(state.conflicts) ? state.conflicts : [];
  state.conflictArchive = Array.isArray(state.conflictArchive) ? state.conflictArchive : [];
  state.deleted = Array.isArray(state.deleted) ? state.deleted : [];
  state.backupMeta = Array.isArray(state.backupMeta) ? state.backupMeta : [];
  state.migrationSnapshots = Array.isArray(state.migrationSnapshots) ? state.migrationSnapshots : [];
  state.recoverySnapshots = Array.isArray(state.recoverySnapshots) ? state.recoverySnapshots : [];
  state.diagnostics = { ...fallback.diagnostics, ...(state.diagnostics ?? {}) };
  state.diagnostics.events = Array.isArray(state.diagnostics.events) ? state.diagnostics.events : [];
  state.diagnostics.errors = Array.isArray(state.diagnostics.errors) ? state.diagnostics.errors : [];
  state.diagnostics.aggregates = { ...(state.diagnostics.aggregates ?? {}) };
  state.performance = Array.isArray(state.performance) ? state.performance : [];
  state.capabilities = { ...(state.capabilities ?? {}) };
  if (!state.settings.defaultCategoryId || !state.categories.some((category) => category.id === state.settings.defaultCategoryId)) {
    state.settings.defaultCategoryId = state.categories[0]?.id ?? null;
  }
  state.categories = state.categories.map((category, index) => ({
    id: category.id ?? newId('cat'), title: String(category.title ?? ''), order: Number(category.order ?? index),
    createdAt: category.createdAt ?? now, updatedAt: category.updatedAt ?? now,
  }));
  state.items = state.items.map((item, index) => ({
    ...makeItem({ categoryId: item.categoryId ?? state.categories[0]?.id ?? null, title: String(item.title ?? ''), order: index, now }),
    ...item,
    id: item.id ?? newId('item'),
    title: String(item.title ?? ''),
    status: ['active', 'completed', 'skipped'].includes(item.status) ? item.status : 'active',
    priority: ['none', 'low', 'medium', 'high'].includes(item.priority) ? item.priority : 'none',
    importance: [0, 1, 2, 3].includes(Number(item.importance)) ? Number(item.importance) : 0,
    tags: Array.isArray(item.tags) ? [...new Set(item.tags.map((tag) => String(tag).trim()).filter(Boolean))] : [],
    fieldRevisions: { ...(item.fieldRevisions ?? {}) },
    updatedAt: item.updatedAt ?? now,
  }));
  state.reminders = state.reminders.map((reminder) => ({
    id: reminder.id ?? newId('rem'), itemId: reminder.itemId, type: reminder.type === 'relative' ? 'relative' : 'absolute',
    offsetDays: Number(reminder.offsetDays ?? 0), time: reminder.time ?? '09:00', at: reminder.at ?? null,
    enabled: reminder.enabled !== false, keepAfterComplete: reminder.keepAfterComplete === true,
    suspendedByCompletion: reminder.suspendedByCompletion === true,
    snoozedUntil: reminder.snoozedUntil ?? null, suppressedDay: reminder.suppressedDay ?? null,
    lastTriggeredAt: reminder.lastTriggeredAt ?? null, createdAt: reminder.createdAt ?? now, updatedAt: reminder.updatedAt ?? now,
  }));
  return state;
}

export function categoryItems(state, categoryId) {
  return state.items.filter((item) => item.categoryId === categoryId);
}

export function itemChildren(state, itemId) {
  return state.items.filter((item) => item.parentId === itemId);
}

export function validateState(state) {
  const errors = [];
  const categoryIds = new Set();
  for (const category of state.categories) {
    if (!category.id || categoryIds.has(category.id)) errors.push({ type: 'duplicate_category_id', id: category.id });
    categoryIds.add(category.id);
  }
  const itemIds = new Set();
  for (const item of state.items) {
    if (!item.id || itemIds.has(item.id)) errors.push({ type: 'duplicate_id', id: item.id });
    itemIds.add(item.id);
    if (!categoryIds.has(item.categoryId)) errors.push({ type: 'invalid_category', id: item.id });
    if (item.parentId !== null) {
      const parent = state.items.find((candidate) => candidate.id === item.parentId);
      if (!parent) errors.push({ type: 'orphan_item', id: item.id, parentId: item.parentId });
      else if (parent.categoryId !== item.categoryId) errors.push({ type: 'cross_category_parent', id: item.id });
    }
    if (item.plannedStart && Number.isNaN(new Date(item.plannedStart).getTime())) errors.push({ type: 'invalid_date', id: item.id, field: 'plannedStart' });
    if (item.dueMode === 'explicit' && item.dueDate && Number.isNaN(new Date(item.dueDate).getTime())) errors.push({ type: 'invalid_date', id: item.id, field: 'dueDate' });
    const seen = new Set([item.id]);
    let cursor = item.parentId;
    while (cursor) {
      if (seen.has(cursor)) { errors.push({ type: 'hierarchy_cycle', id: item.id }); break; }
      seen.add(cursor);
      cursor = state.items.find((candidate) => candidate.id === cursor)?.parentId ?? null;
    }
  }
  for (const reminder of state.reminders) {
    if (!itemIds.has(reminder.itemId)) errors.push({ type: 'orphan_reminder', id: reminder.id });
    if (reminder.type === 'absolute' && reminder.at && Number.isNaN(new Date(reminder.at).getTime())) errors.push({ type: 'invalid_reminder_date', id: reminder.id });
  }
  return errors;
}
