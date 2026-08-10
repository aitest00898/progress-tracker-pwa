import { clone, dateKey, isoNow, makeCategory, makeItem, newId, normalizeState, validateState } from './schema.js';
import { ancestorsOf, descendantsOf, getCategory, getItem, pathString } from './engine.js';

export const PTMD_VERSION = 1;

function yamlValue(value) {
  if (value === true || value === false || typeof value === 'number') return String(value);
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function formatFrontmatter({ exportedAt, timezone, scope }) {
  return ['---', 'progress_tracker_export: true', `format_version: ${PTMD_VERSION}`, `exported_at: ${yamlValue(exportedAt)}`, `timezone: ${yamlValue(timezone)}`, `scope: ${yamlValue(scope)}`, '---'].join('\n');
}

function taskMarker(status) {
  if (status === 'completed') return 'x';
  if (status === 'skipped') return '-';
  return ' ';
}

function itemMetadata(state, item) {
  return {
    id: item.id, status: item.status, categoryId: item.categoryId, parentId: item.parentId, activeOrder: item.activeOrder,
    completedOrder: item.completedOrder, priority: item.priority, importance: item.importance, plannedStart: item.plannedStart,
    dueMode: item.dueMode, dueDate: item.dueDate, tags: item.tags, notes: item.notes, createdAt: item.createdAt,
    firstCompletedAt: item.firstCompletedAt, completedAt: item.completedAt, reopenedAt: item.reopenedAt,
    revision: item.revision, baseRevision: item.baseRevision, fieldRevisions: item.fieldRevisions,
    reminders: state.reminders.filter((reminder) => reminder.itemId === item.id),
    history: state.history.filter((entry) => entry.itemId === item.id),
  };
}

function treeOrder(state, roots) {
  const rows = [];
  const visit = (item, depth) => {
    rows.push({ item, depth });
    const children = state.items.filter((candidate) => candidate.parentId === item.id && candidate.categoryId === item.categoryId)
      .sort((a, b) => (a.status === 'completed') - (b.status === 'completed') || (a.status === 'skipped') - (b.status === 'skipped') || (a.activeOrder ?? 0) - (b.activeOrder ?? 0));
    for (const child of children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return rows;
}

function appendTree(state, lines, categoryId, roots) {
  const rows = treeOrder(state, roots);
  for (const { item, depth } of rows) {
    const indent = '  '.repeat(depth);
    lines.push(`${indent}- [${taskMarker(item.status)}] ${item.title}`);
    lines.push(`${indent}<!-- pt:item ${JSON.stringify(itemMetadata(state, item))} -->`);
    if (item.notes) {
      for (const noteLine of item.notes.split('\n')) lines.push(`${indent}  > ${noteLine}`);
    }
  }
  return categoryId;
}

function subsetState(state, scope, targetId) {
  const result = clone(state);
  if (scope === 'full') return result;
  if (scope === 'category') {
    result.categories = result.categories.filter((category) => category.id === targetId);
    result.items = result.items.filter((item) => item.categoryId === targetId);
  } else if (scope === 'item') {
    const root = getItem(state, targetId);
    const ids = root ? [root.id, ...descendantsOf(state, root.id).map((item) => item.id)] : [];
    result.categories = result.categories.filter((category) => category.id === root?.categoryId);
    result.items = result.items.filter((item) => ids.includes(item.id));
    result.history = result.history.filter((entry) => ids.includes(entry.itemId));
    result.reminders = result.reminders.filter((reminder) => ids.includes(reminder.itemId));
    result.today.items = Object.fromEntries(Object.entries(result.today.items).filter(([id]) => ids.includes(id)));
  }
  result.deleted = [];
  result.conflicts = [];
  result.conflictArchive = [];
  result.syncChanges = [];
  result.backupMeta = [];
  return result;
}

export function exportPTMD(inputState, { scope = 'full', targetId = null, exportedAt = isoNow(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  const state = subsetState(inputState, scope, targetId);
  const lines = [formatFrontmatter({ exportedAt, timezone, scope })];
  if (scope === 'full') {
    lines.push(`<!-- pt:backup ${JSON.stringify({ state })} -->`);
  }
  for (const category of [...state.categories].sort((a, b) => a.order - b.order)) {
    lines.push('', `# ${category.title}`, `<!-- pt:category ${JSON.stringify({ id: category.id, order: category.order, createdAt: category.createdAt })} -->`);
    const roots = state.items.filter((item) => item.categoryId === category.id && item.parentId === null)
      .sort((a, b) => (a.status === 'completed') - (b.status === 'completed') || (a.status === 'skipped') - (b.status === 'skipped') || (a.activeOrder ?? 0) - (b.activeOrder ?? 0));
    appendTree(state, lines, category.id, roots);
  }
  if (scope !== 'full') lines.push('', `<!-- pt:scope ${JSON.stringify({ scope, targetId, exportedAt })} -->`);
  return `${lines.join('\n')}\n`;
}

function parseFrontmatter(lines) {
  if (lines[0]?.trim() !== '---') return { values: {}, end: -1 };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return { values: {}, end: -1 };
  const values = {};
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim().replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (/^\d+$/.test(value)) value = Number(value);
    values[match[1].trim()] = value;
  }
  return { values, end };
}

function safeJSON(value) {
  try { return JSON.parse(value); } catch { return null; }
}

export function parsePTMD(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'malformed' };
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const frontmatter = parseFrontmatter(lines);
  const version = frontmatter.values.format_version;
  if (frontmatter.values.progress_tracker_export !== true || version !== PTMD_VERSION) return { ok: false, reason: 'unsupported', version };
  const result = { ok: true, version, scope: frontmatter.values.scope ?? 'unknown', categories: [], backupState: null, warnings: [] };
  let currentCategory = null;
  let currentItems = [];
  const stack = [];
  for (let index = Math.max(0, frontmatter.end + 1); index < lines.length; index += 1) {
    const line = lines[index];
    const backupMatch = line.match(/^<!--\s*pt:backup\s+(.+)\s*-->$/);
    if (backupMatch) {
      const parsed = safeJSON(backupMatch[1]);
      if (parsed?.state) result.backupState = normalizeState(parsed.state);
      continue;
    }
    const categoryMetaMatch = line.match(/^<!--\s*pt:category\s+(.+)\s*-->$/);
    if (categoryMetaMatch && currentCategory) {
      const meta = safeJSON(categoryMetaMatch[1]);
      if (meta) Object.assign(currentCategory, meta);
      continue;
    }
    const heading = line.match(/^#\s+(.+)$/);
    if (heading) {
      currentCategory = { id: null, title: heading[1].trim(), order: result.categories.length, items: [] };
      result.categories.push(currentCategory);
      currentItems = currentCategory.items;
      stack.length = 0;
      continue;
    }
    const task = line.match(/^(\s*)-\s+\[([ xX-])\]\s*(.*)$/);
    if (task && currentCategory) {
      const indent = task[1].replace(/\t/g, '  ').length;
      const depth = Math.floor(indent / 2);
      const status = task[2].toLowerCase() === 'x' ? 'completed' : task[2] === '-' ? 'skipped' : 'active';
      const parent = stack.at(-1);
      const sourceKey = `line_${index}`;
      const node = { id: null, title: task[3].trim(), status, depth, sourceKey, parentSourceKey: parent?.sourceKey ?? null, metadata: {}, notes: '' };
      while (stack.length > depth) stack.pop();
      node.parentId = stack.at(-1)?.id ?? null;
      currentItems.push(node);
      stack.push(node);
      continue;
    }
    const itemMetaMatch = line.match(/^\s*<!--\s*pt:item\s+(.+)\s*-->$/);
    if (itemMetaMatch && stack.length) {
      const meta = safeJSON(itemMetaMatch[1]);
      if (meta) {
        const node = stack.at(-1);
        Object.assign(node.metadata, meta);
        if (meta.id) node.id = meta.id;
        if (meta.status) node.status = meta.status;
        if (typeof meta.notes === 'string') node.notes = meta.notes;
      }
      continue;
    }
    const noteMatch = line.match(/^\s{2,}>\s?(.*)$/);
    if (noteMatch && stack.length) {
      const node = stack.at(-1);
      node.notes = node.notes ? `${node.notes}\n${noteMatch[1]}` : noteMatch[1];
    }
  }
  if (!result.categories.length && !result.backupState) return { ok: false, reason: 'malformed' };
  return result;
}

function flattenNodes(categories) {
  return categories.flatMap((category) => category.items.map((node) => ({ ...node, categoryId: category.id, categoryTitle: category.title })));
}

function nodeSourceKey(node, index) {
  return node.id ?? node.sourceKey ?? `${node.categoryTitle}:${node.depth}:${node.title}:${index}`;
}

export function previewImport(inputState, parsed, { language = 'zh-TW', now = isoNow() } = {}) {
  if (!parsed?.ok) return { ok: false, reason: parsed?.reason ?? 'malformed' };
  const currentIds = new Set(inputState.items.map((item) => item.id));
  const currentCategoryIds = new Set(inputState.categories.map((category) => category.id));
  const importedNodes = flattenNodes(parsed.categories);
  const skipped = importedNodes.filter((node) => node.id && currentIds.has(node.id));
  const pending = importedNodes.filter((node) => !node.id || !currentIds.has(node.id));
  const categoryMap = new Map();
  const newCategories = [];
  for (const category of parsed.categories) {
    const id = category.id ?? newId('cat');
    if (currentCategoryIds.has(id)) categoryMap.set(category.title, id);
    else {
      const categoryRecord = makeCategory(category.title, inputState.categories.length + newCategories.length, now);
      categoryRecord.id = id;
      newCategories.push(categoryRecord);
      categoryMap.set(category.title, id);
    }
  }
  const imported = [];
  const idMap = new Map();
  pending.forEach((node, index) => {
    const assignedId = node.id ?? newId('item');
    idMap.set(nodeSourceKey(node, index), assignedId);
    if (node.sourceKey) idMap.set(node.sourceKey, assignedId);
  });
  let isolatedCategory = null;
  const isolateTitle = language === 'en' ? `Imported items — ${dateKey(now)}` : `匯入項目 — ${dateKey(now)}`;
  const ensureIsolation = () => {
    if (!isolatedCategory) {
      isolatedCategory = makeCategory(isolateTitle, inputState.categories.length + newCategories.length, now);
      newCategories.push(isolatedCategory);
    }
    return isolatedCategory.id;
  };
  const byDepth = new Map();
  for (const node of pending) {
    const sourceKey = nodeSourceKey(node, imported.length);
    const id = idMap.get(sourceKey);
    const categoryId = categoryMap.get(node.categoryTitle) ?? ensureIsolation();
    const declaredParentId = node.metadata?.parentId ?? node.parentId;
    const parentCandidate = declaredParentId ? idMap.get(declaredParentId) ?? declaredParentId : node.parentSourceKey ? idMap.get(node.parentSourceKey) : null;
    const parentRecord = parentCandidate ? imported.find((item) => item.id === parentCandidate) ?? inputState.items.find((item) => item.id === parentCandidate) : null;
    const safeParent = parentCandidate && parentRecord?.categoryId === categoryId ? parentCandidate : null;
    const isUnsafeRoot = !safeParent && (node.depth > 0 || Boolean(declaredParentId));
    const finalCategoryId = isUnsafeRoot ? ensureIsolation() : categoryId;
    const parentId = isUnsafeRoot ? null : safeParent;
    const metadata = node.metadata ?? {};
    const item = makeItem({ categoryId: finalCategoryId, parentId, title: node.title, order: imported.length, now });
    Object.assign(item, {
      id, status: ['active', 'completed', 'skipped'].includes(node.status) ? node.status : 'active',
      priority: ['none', 'low', 'medium', 'high'].includes(metadata.priority) ? metadata.priority : 'none',
      importance: [0, 1, 2, 3].includes(Number(metadata.importance)) ? Number(metadata.importance) : 0,
      plannedStart: metadata.plannedStart ?? null, dueMode: ['explicit', 'inherit', 'none'].includes(metadata.dueMode) ? metadata.dueMode : 'inherit', dueDate: metadata.dueDate ?? null,
      tags: Array.isArray(metadata.tags) ? metadata.tags : [], notes: typeof node.notes === 'string' ? node.notes : '',
      activeOrder: Number(metadata.activeOrder ?? imported.length), completedOrder: Number(metadata.completedOrder ?? imported.length),
      createdAt: metadata.createdAt ?? now, firstCompletedAt: metadata.firstCompletedAt ?? null, completedAt: item.status === 'completed' ? (metadata.completedAt ?? now) : null,
      revision: 0, baseRevision: 0, fieldRevisions: {}, updatedAt: now,
    });
    imported.push(item);
    byDepth.set(node.depth, item);
  }
  const importedReminders = [];
  const importedHistory = [];
  for (const node of pending) {
    const sourceKey = nodeSourceKey(node, pending.indexOf(node));
    const id = idMap.get(sourceKey);
    for (const reminder of node.metadata?.reminders ?? []) importedReminders.push({ ...clone(reminder), id: newId('rem'), itemId: id, enabled: false, suspendedByCompletion: false, createdAt: now, updatedAt: now });
    for (const entry of node.metadata?.history ?? []) importedHistory.push({ ...clone(entry), id: newId('hist'), itemId: id });
  }
  const preview = {
    ok: true, state: clone(inputState), importedCategories: newCategories, importedItems: imported, importedReminders, importedHistory,
    skippedCount: skipped.length, isolated: Boolean(isolatedCategory), warnings: [],
  };
  preview.state.categories.push(...newCategories);
  preview.state.items.push(...imported);
  preview.state.reminders.push(...importedReminders);
  preview.state.history.push(...importedHistory);
  const validation = validateState(preview.state);
  if (validation.length) return { ok: false, reason: 'validation', validation };
  return preview;
}

export function applyImportPreview(state, preview, at = isoNow()) {
  if (!preview?.ok) return { ok: false, reason: 'invalid_preview' };
  const next = clone(state);
  const categoryIds = new Set(next.categories.map((category) => category.id));
  for (const category of preview.importedCategories ?? []) if (!categoryIds.has(category.id)) { next.categories.push(clone(category)); categoryIds.add(category.id); }
  const itemIds = new Set(next.items.map((item) => item.id));
  const addedIds = new Set();
  for (const item of preview.importedItems ?? []) if (!itemIds.has(item.id)) { next.items.push(clone(item)); itemIds.add(item.id); addedIds.add(item.id); }
  const reminderIds = new Set(next.reminders.map((reminder) => reminder.id));
  for (const reminder of preview.importedReminders ?? []) if (addedIds.has(reminder.itemId) && !reminderIds.has(reminder.id)) { next.reminders.push(clone(reminder)); reminderIds.add(reminder.id); }
  const historyIds = new Set(next.history.map((entry) => entry.id));
  for (const entry of preview.importedHistory ?? []) if (addedIds.has(entry.itemId) && !historyIds.has(entry.id)) { next.history.push(clone(entry)); historyIds.add(entry.id); }
  next.meta.updatedAt = at;
  next.meta.revision += 1;
  for (const item of preview.importedItems ?? []) if (addedIds.has(item.id)) {
    if (!next.history.some((entry) => entry.itemId === item.id && entry.type === 'created')) next.history.push({ id: newId('hist'), itemId: item.id, type: 'created', metadata: { imported: true }, at });
  }
  const normalized = normalizeState(next, at);
  const validation = validateState(normalized);
  if (validation.length) return { ok: false, reason: 'validation', validation };
  return { ok: true, state: normalized };
}

export function isFullBackup(parsed) {
  return Boolean(parsed?.ok && parsed.backupState && parsed.scope === 'full');
}

export function restorePreview(currentState, parsed) {
  if (!isFullBackup(parsed)) return { ok: false, reason: 'not_full_backup' };
  const incoming = normalizeState(parsed.backupState);
  const currentIds = new Set(currentState.items.map((item) => item.id));
  const incomingIds = new Set(incoming.items.map((item) => item.id));
  return {
    ok: true, incoming, summary: {
      currentItems: currentIds.size, incomingItems: incomingIds.size,
      added: [...incomingIds].filter((id) => !currentIds.has(id)).length,
      removed: [...currentIds].filter((id) => !incomingIds.has(id)).length,
      categories: incoming.categories.length, deleted: incoming.deleted.length,
    },
  };
}
