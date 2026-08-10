import { clone, dateKey, DAY_MS, isoNow, makeItem, newId } from './schema.js';
import { createEngineIndex } from './engine-index.js';

export { createEngineIndex } from './engine-index.js';

const IMPORTANCE_MULTIPLIER = { 0: 1, 1: 1.5, 2: 2, 3: 3 };
const ATTENTION_WEIGHTS = {
  created: 0.2, edited: 1, add_child: 1.8, completed: 2.4, reopened: 2.6, note_edited: 1.2,
  due_changed: 1.3, priority_changed: 0.9, importance_changed: 0.7, reminder_changed: 0.8,
  moved: 1.1, tag_changed: 0.6, today_added: 0.8, today_removed: 0.4,
};

export function getItem(state, itemId, index = null) {
  return index?.itemById.get(itemId) ?? state.items.find((item) => item.id === itemId) ?? null;
}

export function getCategory(state, categoryId, index = null) {
  return index?.categoryById.get(categoryId) ?? state.categories.find((category) => category.id === categoryId) ?? null;
}

export function childrenOf(state, itemId, index = null) {
  return index ? index.childrenByParent.get(itemId) ?? [] : state.items.filter((item) => item.parentId === itemId);
}

export function descendantsOf(state, itemId, index = null) {
  const context = index ?? createEngineIndex(state);
  const descendants = [];
  const queue = [...childrenOf(state, itemId, context)];
  const seen = new Set([itemId]);
  let cursor = 0;
  while (cursor < queue.length) {
    const item = queue[cursor];
    cursor += 1;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    descendants.push(item);
    queue.push(...childrenOf(state, item.id, context));
  }
  return descendants;
}

export function ancestorsOf(state, itemId, index = null) {
  const context = index ?? createEngineIndex(state);
  const result = [];
  let cursor = getItem(state, itemId, context)?.parentId ?? null;
  const seen = new Set();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = getItem(state, cursor, context);
    if (!parent) break;
    result.unshift(parent);
    cursor = parent.parentId;
  }
  return result;
}

export function itemPath(state, itemId, index = null) {
  const context = index ?? createEngineIndex(state);
  if (context.pathByItem.has(itemId)) return context.pathByItem.get(itemId);
  const item = getItem(state, itemId, context);
  if (!item) return [];
  const path = [...ancestorsOf(state, item.id, context), item];
  context.pathByItem.set(itemId, path);
  return path;
}

export function sortItems(items, status = 'active') {
  const orderField = status === 'completed' ? 'completedOrder' : 'activeOrder';
  return [...items].sort((a, b) => (a[orderField] ?? 0) - (b[orderField] ?? 0) || a.createdAt.localeCompare(b.createdAt));
}

export function siblingItems(state, item, status = item.status) {
  return sortItems(state.items.filter((candidate) => candidate.categoryId === item.categoryId && candidate.parentId === item.parentId && candidate.status === status), status);
}

export function nextOrder(state, categoryId, parentId, status = 'active') {
  return siblingItems(state, { categoryId, parentId, status }).reduce((max, item) => Math.max(max, (status === 'completed' ? item.completedOrder : item.activeOrder) ?? 0), -1) + 1;
}

export function pathString(state, itemId, index = null) {
  const context = index ?? createEngineIndex(state);
  const category = getCategory(state, getItem(state, itemId, context)?.categoryId, context);
  return [category?.title, ...itemPath(state, itemId, context).map((item) => item.title)].filter(Boolean).join(' › ');
}

export function canMove(state, itemId, { categoryId, parentId }) {
  const item = getItem(state, itemId);
  if (!item) return { ok: false, reason: 'missing' };
  if (parentId === itemId) return { ok: false, reason: 'cycle' };
  if (parentId && descendantsOf(state, itemId).some((candidate) => candidate.id === parentId)) return { ok: false, reason: 'cycle' };
  if (parentId) {
    const parent = getItem(state, parentId);
    if (!parent || parent.categoryId !== categoryId) return { ok: false, reason: 'invalid_parent' };
  } else if (!getCategory(state, categoryId)) {
    return { ok: false, reason: 'invalid_category' };
  }
  return { ok: true };
}

export function recordHistory(state, itemId, type, metadata = {}, at = isoNow()) {
  state.history.push({ id: newId('hist'), itemId, type, metadata: clone(metadata), at });
}

export function touchItem(state, item, changedFields = [], at = isoNow()) {
  item.revision = Number(item.revision ?? 0) + 1;
  item.updatedAt = at;
  item.fieldRevisions = { ...(item.fieldRevisions ?? {}) };
  for (const field of changedFields) item.fieldRevisions[field] = item.revision;
  state.meta.revision = Number(state.meta.revision ?? 0) + 1;
  state.meta.updatedAt = at;
}

export function createCategory(state, title, at = isoNow(), adjacentToCategoryId = null) {
  const cleanTitle = String(title ?? '').trim();
  if (!cleanTitle) return { ok: false, reason: 'required' };
  const category = { id: newId('cat'), title: cleanTitle, order: state.categories.length, createdAt: at, updatedAt: at };
  state.categories.push(category);
  if (adjacentToCategoryId && getCategory(state, adjacentToCategoryId)) {
    const ordered = [...state.categories].sort((a, b) => a.order - b.order).filter((candidate) => candidate.id !== category.id);
    const index = ordered.findIndex((candidate) => candidate.id === adjacentToCategoryId);
    ordered.splice(index < 0 ? ordered.length : index + 1, 0, category);
    ordered.forEach((candidate, order) => { candidate.order = order; candidate.updatedAt = at; });
  }
  if (!state.settings.defaultCategoryId) state.settings.defaultCategoryId = category.id;
  state.meta.updatedAt = at;
  return { ok: true, category };
}

export function renameCategory(state, categoryId, title, at = isoNow()) {
  const category = getCategory(state, categoryId);
  const cleanTitle = String(title ?? '').trim();
  if (!category || !cleanTitle) return { ok: false, reason: 'required' };
  category.title = cleanTitle;
  category.updatedAt = at;
  state.meta.updatedAt = at;
  return { ok: true, category };
}

export function reorderCategories(state, categoryId, beforeCategoryId, at = isoNow()) {
  const ordered = [...state.categories].sort((a, b) => a.order - b.order);
  const index = ordered.findIndex((category) => category.id === categoryId);
  if (index < 0) return { ok: false, reason: 'missing' };
  const [moved] = ordered.splice(index, 1);
  const target = beforeCategoryId ? ordered.findIndex((category) => category.id === beforeCategoryId) : ordered.length;
  ordered.splice(target < 0 ? ordered.length : target, 0, moved);
  ordered.forEach((category, order) => { category.order = order; category.updatedAt = at; });
  state.categories = ordered;
  state.meta.updatedAt = at;
  return { ok: true };
}

export function createItem(state, { categoryId, parentId = null, title }, at = isoNow()) {
  const cleanTitle = String(title ?? '').trim();
  if (!cleanTitle) return { ok: false, reason: 'required' };
  if (!getCategory(state, categoryId)) return { ok: false, reason: 'invalid_category' };
  if (parentId) {
    const parent = getItem(state, parentId);
    if (!parent || parent.categoryId !== categoryId) return { ok: false, reason: 'invalid_parent' };
  }
  const item = makeItem({ categoryId, parentId, title: cleanTitle, order: nextOrder(state, categoryId, parentId, 'active'), now: at });
  state.items.push(item);
  recordHistory(state, item.id, 'created', {}, at);
  touchItem(state, item, ['title', 'parentId', 'categoryId'], at);
  return { ok: true, item };
}

export function renameItem(state, itemId, title, at = isoNow()) {
  const item = getItem(state, itemId);
  const cleanTitle = String(title ?? '').trim();
  if (!item || !cleanTitle) return { ok: false, reason: 'required' };
  item.title = cleanTitle;
  touchItem(state, item, ['title'], at);
  recordHistory(state, itemId, 'edited', { fields: ['title'] }, at);
  return { ok: true, item };
}

export function reorderSiblings(state, itemId, beforeItemId, at = isoNow()) {
  const item = getItem(state, itemId);
  const before = beforeItemId ? getItem(state, beforeItemId) : null;
  if (!item) return { ok: false, reason: 'missing' };
  if (before && (before.categoryId !== item.categoryId || before.parentId !== item.parentId || before.status !== item.status)) return { ok: false, reason: 'not_sibling' };
  const siblings = siblingItems(state, item);
  const from = siblings.findIndex((candidate) => candidate.id === itemId);
  if (from < 0) return { ok: false, reason: 'missing' };
  siblings.splice(from, 1);
  const target = before ? siblings.findIndex((candidate) => candidate.id === beforeItemId) : siblings.length;
  siblings.splice(target < 0 ? siblings.length : target, 0, item);
  const orderField = item.status === 'completed' ? 'completedOrder' : 'activeOrder';
  siblings.forEach((candidate, index) => { candidate[orderField] = index; touchItem(state, candidate, [orderField], at); });
  recordHistory(state, itemId, 'reordered', { scope: 'siblings' }, at);
  return { ok: true };
}

export function moveSubtree(state, itemId, { categoryId, parentId = null }, at = isoNow()) {
  const check = canMove(state, itemId, { categoryId, parentId });
  if (!check.ok) return check;
  const item = getItem(state, itemId);
  const previous = { categoryId: item.categoryId, parentId: item.parentId };
  const subtree = [item, ...descendantsOf(state, itemId)];
  item.categoryId = categoryId;
  item.parentId = parentId;
  for (const child of subtree.slice(1)) child.categoryId = categoryId;
  for (const entry of subtree) touchItem(state, entry, ['categoryId', 'parentId'], at);
  recordHistory(state, itemId, 'moved', { from: previous, to: { categoryId, parentId }, descendants: subtree.length - 1 }, at);
  return { ok: true, item, subtreeCount: subtree.length, previous };
}

export function progressForItem(state, itemId, memo = null, trail = new Set(), index = null) {
  const context = index ?? createEngineIndex(state);
  const progressMemo = memo ?? context.progressByItem;
  if (progressMemo.has(itemId)) return progressMemo.get(itemId);
  if (trail.has(itemId)) return 0;
  const item = getItem(state, itemId, context);
  if (!item) return 0;
  const children = childrenOf(state, itemId, context);
  if (!children.length) {
    const value = item.status === 'completed' ? 100 : 0;
    progressMemo.set(itemId, value); return value;
  }
  if (item.status === 'skipped') { progressMemo.set(itemId, 0); return 0; }
  const nextTrail = new Set(trail).add(itemId);
  const valid = children.filter((child) => child.status !== 'skipped');
  if (!valid.length) { progressMemo.set(itemId, 0); return 0; }
  const totalWeight = valid.reduce((sum, child) => sum + (IMPORTANCE_MULTIPLIER[child.importance] ?? 1), 0);
  const weighted = valid.reduce((sum, child) => sum + progressForItem(state, child.id, progressMemo, nextTrail, context) * (IMPORTANCE_MULTIPLIER[child.importance] ?? 1), 0);
  const value = Math.round((weighted / totalWeight) * 10) / 10;
  progressMemo.set(itemId, value);
  return value;
}

export function importanceMultiplier(importance) {
  return IMPORTANCE_MULTIPLIER[importance] ?? 1;
}

export function completionNeedsConfirmation(state, itemId) {
  const item = getItem(state, itemId);
  return Boolean(item && item.status !== 'completed' && descendantsOf(state, itemId).some((candidate) => candidate.status === 'active'));
}

export function setItemStatus(state, itemId, status, { force = false, at = isoNow() } = {}) {
  const item = getItem(state, itemId);
  if (!item || !['active', 'completed', 'skipped'].includes(status)) return { ok: false, reason: 'missing' };
  if (status === 'completed' && completionNeedsConfirmation(state, itemId) && !force) return { ok: false, reason: 'confirmation_required' };
  const previous = item.status;
  if (previous === status) return { ok: true, item, changed: false };
  item.status = status;
  let remindersChanged = false;
  if (status === 'completed') {
    item.reopenOrder = item.activeOrder;
    item.firstCompletedAt ??= at;
    item.completedAt = at;
    item.reopenedAt = null;
    for (const reminder of state.reminders.filter((candidate) => candidate.itemId === itemId)) {
      if (!reminder.keepAfterComplete && !reminder.suspendedByCompletion) { reminder.suspendedByCompletion = true; reminder.updatedAt = at; remindersChanged = true; }
    }
    recordHistory(state, itemId, 'completed', {}, at);
  } else if (previous === 'completed' && status === 'active') {
    item.reopenedAt = at;
    item.completedAt = null;
    for (const reminder of state.reminders.filter((candidate) => candidate.itemId === itemId)) {
      if (reminder.suspendedByCompletion) {
        const occurrence = reminderOccurrence(state, reminder, at);
        reminder.suspendedByCompletion = false;
        reminder.updatedAt = at;
        remindersChanged = true;
        if (occurrence && occurrence.getTime() > new Date(at).getTime()) reminder.enabled = true;
        else if (occurrence) reminder.lastTriggeredAt = occurrence.toISOString();
      }
    }
    recordHistory(state, itemId, 'reopened', {}, at);
  } else if (status === 'skipped') {
    recordHistory(state, itemId, 'skipped', {}, at);
  } else {
    recordHistory(state, itemId, 'edited', { fields: ['status'] }, at);
  }
  const siblings = state.items.filter((candidate) => candidate.id !== item.id && candidate.categoryId === item.categoryId && candidate.parentId === item.parentId && candidate.status === status);
  const previousOrderField = previous === 'completed' ? 'completedOrder' : 'activeOrder';
  const currentOrderField = status === 'completed' ? 'completedOrder' : 'activeOrder';
  const maxCurrentOrder = siblings.reduce((max, candidate) => Math.max(max, Number(candidate[currentOrderField] ?? -1)), -1);
  item[currentOrderField] = status === 'active' && previous === 'completed' && item.reopenOrder !== null ? Math.min(Number(item.reopenOrder), maxCurrentOrder + 1) : maxCurrentOrder + 1;
  siblings.sort((a, b) => (a[currentOrderField] ?? 0) - (b[currentOrderField] ?? 0));
  siblings.forEach((sibling, index) => { sibling[currentOrderField] = index >= item[currentOrderField] ? index + 1 : index; });
  if (status === 'active' && previous === 'completed') item.reopenOrder = null;
  touchItem(state, item, ['status', currentOrderField, ...(remindersChanged ? ['reminders'] : [])], at);
  return { ok: true, item, changed: true, previous };
}

export function effectiveDue(state, itemId, index = null) {
  const context = index ?? createEngineIndex(state);
  if (context.dueByItem.has(itemId)) return context.dueByItem.get(itemId);
  const item = getItem(state, itemId, context);
  if (!item) return { value: null, source: 'none', sourceItemId: null };
  if (item.dueMode === 'explicit' && item.dueDate) {
    const result = { value: item.dueDate, source: 'explicit', sourceItemId: item.id };
    context.dueByItem.set(itemId, result);
    return result;
  }
  if (item.dueMode === 'none') {
    const result = { value: null, source: 'none', sourceItemId: item.id };
    context.dueByItem.set(itemId, result);
    return result;
  }
  let cursor = item.parentId;
  const seen = new Set([itemId]);
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const ancestor = getItem(state, cursor, context);
    if (!ancestor) break;
    if (ancestor.dueMode === 'explicit' && ancestor.dueDate) {
      const result = { value: ancestor.dueDate, source: 'inherited', sourceItemId: ancestor.id };
      context.dueByItem.set(itemId, result);
      return result;
    }
    cursor = ancestor.parentId;
  }
  const result = { value: null, source: 'none', sourceItemId: null };
  context.dueByItem.set(itemId, result);
  return result;
}

export function effectivePlannedStart(state, itemId, index = null) {
  const context = index ?? createEngineIndex(state);
  if (context.plannedStartByItem.has(itemId)) return context.plannedStartByItem.get(itemId);
  const item = getItem(state, itemId, context);
  if (!item) return null;
  if (item.plannedStart) {
    const result = { value: item.plannedStart, source: 'explicit', sourceItemId: item.id };
    context.plannedStartByItem.set(itemId, result);
    return result;
  }
  let cursor = item.parentId;
  const seen = new Set([itemId]);
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const ancestor = getItem(state, cursor, context);
    if (!ancestor) break;
    if (ancestor.plannedStart) {
      const result = { value: ancestor.plannedStart, source: 'inherited_context', sourceItemId: ancestor.id };
      context.plannedStartByItem.set(itemId, result);
      return result;
    }
    cursor = ancestor.parentId;
  }
  context.plannedStartByItem.set(itemId, null);
  return null;
}

export function dueImpactOnRemoval(state, itemId) {
  const item = getItem(state, itemId);
  if (!item) return { lost: [], changed: [], unaffected: [] };
  const before = new Map(descendantsOf(state, itemId).map((child) => [child.id, effectiveDue(state, child.id)]));
  const draft = clone(state);
  const draftItem = getItem(draft, itemId);
  draftItem.dueMode = 'inherit';
  draftItem.dueDate = null;
  const lost = [], changed = [], unaffected = [];
  for (const child of descendantsOf(draft, itemId)) {
    const after = effectiveDue(draft, child.id);
    const prior = before.get(child.id);
    if (prior?.value && !after.value) lost.push(child.id);
    else if (prior?.value !== after.value) changed.push(child.id);
    else unaffected.push(child.id);
  }
  return { lost, changed, unaffected };
}

export function dateWarnings(state, itemId, index = null) {
  const context = index ?? createEngineIndex(state);
  const item = getItem(state, itemId, context);
  if (!item) return [];
  const due = effectiveDue(state, itemId, context).value;
  const warnings = [];
  if (item.plannedStart && due && new Date(due) < new Date(item.plannedStart)) warnings.push('planned_start_after_due');
  for (const child of childrenOf(state, itemId, context)) {
    const childDue = effectiveDue(state, child.id, context).value;
    if (due && childDue && new Date(childDue) > new Date(due)) warnings.push('child_due_after_parent');
  }
  return warnings;
}

export function moveImpact(state, itemId, target, now = new Date()) {
  const check = canMove(state, itemId, target);
  if (!check.ok) return { ...check, dueChanges: [], reminderChanges: [], warnings: [] };
  const subtree = [getItem(state, itemId), ...descendantsOf(state, itemId)].filter(Boolean);
  const beforeDue = new Map(subtree.map((item) => [item.id, effectiveDue(state, item.id)]));
  const beforeReminders = new Map(state.reminders.filter((reminder) => subtree.some((item) => item.id === reminder.itemId)).map((reminder) => [reminder.id, reminderOccurrence(state, reminder)?.toISOString() ?? null]));
  const draft = clone(state);
  moveSubtree(draft, itemId, target, now.toISOString());
  const dueChanges = [];
  const reminderChanges = [];
  const warnings = new Set();
  for (const item of subtree) {
    const before = beforeDue.get(item.id);
    const after = effectiveDue(draft, item.id);
    if (before?.value !== after?.value) dueChanges.push(item.id);
    if (before?.value && !after?.value && before.source === 'inherited') warnings.add('lost_inherited_due');
    if (after.value && dateKey(after.value) < dateKey(now)) warnings.add('moved_overdue');
    if (after.value && dateKey(after.value) === dateKey(now) && dateKey(before?.value) !== dateKey(now)) warnings.add('moved_today');
    if (item.plannedStart && after.value && new Date(after.value) < new Date(item.plannedStart)) warnings.add('planned_start_after_due');
    if (dateWarnings(draft, item.id).includes('child_due_after_parent')) warnings.add('child_due_after_parent');
  }
  for (const reminder of state.reminders.filter((candidate) => subtree.some((item) => item.id === candidate.itemId) && candidate.type === 'relative')) {
    const before = beforeReminders.get(reminder.id);
    const after = reminderOccurrence(draft, draft.reminders.find((candidate) => candidate.id === reminder.id))?.toISOString() ?? null;
    if (before !== after) reminderChanges.push(reminder.id);
    if (before && after && new Date(after) <= now && new Date(before) > now) warnings.add('relative_reminder_past');
    if (before && !after) warnings.add('relative_reminder_no_due');
  }
  if (subtree.length > 25 || reminderChanges.length > 10) warnings.add('large_impact');
  return { ok: true, subtreeCount: subtree.length, dueChanges, reminderChanges, warnings: [...warnings] };
}

export function setDue(state, itemId, { mode, date }, at = isoNow()) {
  const item = getItem(state, itemId);
  if (!item || !['explicit', 'inherit', 'none'].includes(mode)) return { ok: false, reason: 'invalid' };
  const previous = { mode: item.dueMode, date: item.dueDate };
  item.dueMode = mode;
  item.dueDate = mode === 'explicit' ? (date || null) : null;
  touchItem(state, item, ['dueMode', 'dueDate'], at);
  recordHistory(state, itemId, 'due_changed', { from: previous, to: { mode: item.dueMode, date: item.dueDate } }, at);
  return { ok: true, previous, warnings: dateWarnings(state, itemId) };
}

export function setPriority(state, itemId, priority, at = isoNow()) {
  const item = getItem(state, itemId);
  if (!item || !['none', 'low', 'medium', 'high'].includes(priority)) return { ok: false, reason: 'invalid' };
  if (item.priority === priority) return { ok: true, changed: false };
  const previous = item.priority;
  item.priority = priority;
  touchItem(state, item, ['priority'], at);
  recordHistory(state, itemId, 'priority_changed', { from: previous, to: priority }, at);
  return { ok: true, changed: true };
}

export function setImportance(state, itemId, importance, at = isoNow()) {
  const item = getItem(state, itemId);
  const value = Number(importance);
  if (!item || ![0, 1, 2, 3].includes(value)) return { ok: false, reason: 'invalid' };
  item.importance = value;
  touchItem(state, item, ['importance'], at);
  recordHistory(state, itemId, 'importance_changed', { value }, at);
  return { ok: true };
}

export function setNotes(state, itemId, notes, at = isoNow()) {
  const item = getItem(state, itemId);
  if (!item) return { ok: false, reason: 'missing' };
  item.notes = String(notes ?? '');
  touchItem(state, item, ['notes'], at);
  recordHistory(state, itemId, 'note_edited', {}, at);
  return { ok: true };
}

export function setTags(state, itemId, tags, at = isoNow()) {
  const item = getItem(state, itemId);
  if (!item) return { ok: false, reason: 'missing' };
  item.tags = [...new Set((Array.isArray(tags) ? tags : []).map((tag) => String(tag).trim().replace(/^#/, '')).filter(Boolean))];
  touchItem(state, item, ['tags'], at);
  recordHistory(state, itemId, 'tag_changed', { count: item.tags.length }, at);
  return { ok: true };
}

export function addReminder(state, itemId, input, at = isoNow()) {
  if (state.reminders.filter((reminder) => reminder.itemId === itemId).length >= 3) return { ok: false, reason: 'max' };
  const item = getItem(state, itemId);
  if (!item) return { ok: false, reason: 'missing' };
  if (!['absolute', 'relative'].includes(input.type)) return { ok: false, reason: 'invalid' };
  const type = input.type;
  if (type === 'relative' && !effectiveDue(state, itemId).value) return { ok: false, reason: 'no_due' };
  const reminder = {
    id: newId('rem'), itemId, type, offsetDays: type === 'relative' ? Number(input.offsetDays ?? -1) : 0,
    time: input.time ?? '09:00', at: type === 'absolute' ? (input.at ?? null) : null, enabled: input.enabled !== false,
    keepAfterComplete: input.keepAfterComplete === true, suspendedByCompletion: false, snoozedUntil: null,
    suppressedDay: null, lastTriggeredAt: null, createdAt: at, updatedAt: at,
  };
  state.reminders.push(reminder);
  touchItem(state, item, ['reminders'], at);
  recordHistory(state, itemId, 'reminder_changed', { action: 'added', reminderId: reminder.id }, at);
  return { ok: true, reminder };
}

export function updateReminder(state, reminderId, patch, at = isoNow()) {
  const reminder = state.reminders.find((candidate) => candidate.id === reminderId);
  if (!reminder) return { ok: false, reason: 'missing' };
  const item = getItem(state, reminder.itemId);
  const nextType = patch.type === undefined ? reminder.type : patch.type;
  if (!['absolute', 'relative'].includes(nextType)) return { ok: false, reason: 'invalid' };
  if (nextType === 'relative' && !effectiveDue(state, reminder.itemId).value) return { ok: false, reason: 'no_due' };
  Object.assign(reminder, patch, { type: nextType, updatedAt: at });
  if (item) { touchItem(state, item, ['reminders'], at); recordHistory(state, item.id, 'reminder_changed', { reminderId }, at); }
  return { ok: true, reminder };
}

export function removeReminder(state, reminderId, at = isoNow()) {
  const index = state.reminders.findIndex((reminder) => reminder.id === reminderId);
  if (index < 0) return { ok: false, reason: 'missing' };
  const [reminder] = state.reminders.splice(index, 1);
  const item = getItem(state, reminder.itemId);
  if (item) { touchItem(state, item, ['reminders'], at); recordHistory(state, item.id, 'reminder_changed', { action: 'removed', reminderId }, at); }
  return { ok: true };
}

export function reminderOccurrence(state, reminder, reference = new Date(), index = null) {
  if (!reminder) return null;
  let base;
  if (reminder.type === 'relative') {
    const due = effectiveDue(state, reminder.itemId, index).value;
    if (!due) return null;
    base = new Date(due);
    base.setDate(base.getDate() + Number(reminder.offsetDays ?? 0));
  } else {
    base = reminder.at ? new Date(reminder.at) : null;
  }
  if (!base || Number.isNaN(base.getTime())) return null;
  const [hours, minutes] = String(reminder.time ?? '09:00').split(':').map(Number);
  if (reminder.type === 'relative' || !reminder.at?.includes('T')) base.setHours(hours || 0, minutes || 0, 0, 0);
  return base;
}

export function reminderState(state, reminder, now = new Date(), index = null) {
  const item = getItem(state, reminder.itemId, index);
  const occurrence = reminderOccurrence(state, reminder, now, index);
  if (!item || !occurrence || reminder.enabled === false || reminder.suspendedByCompletion) return 'disabled';
  if (reminder.suppressedDay === dateKey(now)) return 'suppressed';
  if (reminder.snoozedUntil && new Date(reminder.snoozedUntil) > now) return 'snoozed';
  if (item.status === 'completed' && !reminder.keepAfterComplete) return 'suspended';
  if (occurrence < now && reminder.lastTriggeredAt !== occurrence.toISOString()) return 'missed';
  if (dateKey(occurrence) === dateKey(now)) return 'today';
  return occurrence > now ? 'later' : 'handled';
}

export function reminderCenter(state, now = new Date(), index = null) {
  const context = index ?? createEngineIndex(state);
  const groups = { needAction: [], today: [], later: [], handled: [] };
  const byItem = new Map();
  for (const reminder of state.reminders) {
    const item = getItem(state, reminder.itemId, context);
    if (!item) continue;
    const status = reminderState(state, reminder, now, context);
    const occurrence = reminderOccurrence(state, reminder, now, context);
    const entry = byItem.get(item.id) ?? { item, reminders: [], missedCount: 0 };
    entry.reminders.push({ reminder, occurrence, status });
    if (status === 'missed') entry.missedCount += 1;
    byItem.set(item.id, entry);
  }
  for (const entry of byItem.values()) {
    const statuses = entry.reminders.map((candidate) => candidate.status);
    if (statuses.includes('missed')) groups.needAction.push(entry);
    else if (statuses.includes('today')) groups.today.push(entry);
    else if (statuses.includes('later')) groups.later.push(entry);
    else groups.handled.push(entry);
  }
  return groups;
}

export function snoozeReminder(state, reminderId, until, at = isoNow()) {
  const reminder = state.reminders.find((candidate) => candidate.id === reminderId);
  if (!reminder) return { ok: false, reason: 'missing' };
  reminder.snoozedUntil = new Date(until).toISOString();
  reminder.lastTriggeredAt = reminderOccurrence(state, reminder, new Date(at))?.toISOString() ?? reminder.lastTriggeredAt;
  reminder.updatedAt = at;
  const item = getItem(state, reminder.itemId);
  if (item) { touchItem(state, item, ['reminders'], at); recordHistory(state, item.id, 'reminder_changed', { action: 'snoozed', reminderId }, at); }
  return { ok: true };
}

export function suppressReminderToday(state, reminderId, at = new Date()) {
  const reminder = state.reminders.find((candidate) => candidate.id === reminderId);
  if (!reminder) return { ok: false, reason: 'missing' };
  reminder.suppressedDay = dateKey(at);
  const updatedAt = new Date(at).toISOString();
  reminder.updatedAt = updatedAt;
  const item = getItem(state, reminder.itemId);
  if (item) { touchItem(state, item, ['reminders'], updatedAt); recordHistory(state, item.id, 'reminder_changed', { action: 'suppressed_today', reminderId }, updatedAt); }
  return { ok: true };
}

export function addToToday(state, itemId, source = 'manual', at = isoNow()) {
  const item = getItem(state, itemId);
  if (!item) return { ok: false, reason: 'missing' };
  const existing = state.today.items[itemId];
  if (existing) return { ok: true, changed: false, entry: existing };
  const order = Object.values(state.today.items).reduce((max, entry) => Math.max(max, entry.order ?? -1), -1) + 1;
  const entry = { itemId, order, addedAt: at, source, completedAt: null };
  state.today.items[itemId] = entry;
  recordHistory(state, itemId, 'today_added', { source }, at);
  return { ok: true, changed: true, entry };
}

export function removeFromToday(state, itemId, at = isoNow()) {
  if (!state.today.items[itemId]) return { ok: true, changed: false };
  delete state.today.items[itemId];
  recordHistory(state, itemId, 'today_removed', {}, at);
  return { ok: true, changed: true };
}

export function applyDailyRollover(state, now = new Date()) {
  const todayKey = dateKey(now);
  const previous = state.today.lastRolloverDate;
  if (previous === todayKey) return { changed: false, previous, todayKey };
  for (const [itemId, entry] of Object.entries(state.today.items)) {
    const item = getItem(state, itemId);
    if (!item || item.status === 'completed' || entry.completedAt) delete state.today.items[itemId];
    else entry.completedAt = null;
  }
  state.today.lastRolloverDate = todayKey;
  state.meta.lastRolloverDate = todayKey;
  return { changed: true, previous, todayKey };
}

export function markTodayCompletion(state, itemId, status, at = isoNow()) {
  const entry = state.today.items[itemId];
  if (!entry) return;
  entry.completedAt = status === 'completed' ? at : null;
}

export function derivedTodayItems(state, now = new Date(), index = null) {
  const context = index ?? createEngineIndex(state);
  const today = dateKey(now);
  const entries = Object.values(state.today.items);
  const explicitStart = state.items.filter((item) => item.status !== 'completed' && item.plannedStart && !Number.isNaN(new Date(item.plannedStart).getTime()) && new Date(item.plannedStart).getTime() <= now.getTime());
  const dueItems = state.items.filter((item) => {
    if (item.status === 'completed') return false;
    const due = effectiveDue(state, item.id, context).value;
    return due && dateKey(due) <= today;
  });
  const ids = new Set([...entries.map((entry) => entry.itemId), ...explicitStart.map((item) => item.id), ...dueItems.map((item) => item.id)]);
  const items = [...ids].map((id) => getItem(state, id, context)).filter((item) => item && item.status !== 'skipped');
  const overdue = items.filter((item) => { const due = effectiveDue(state, item.id, context).value; return due && dateKey(due) < today && item.status !== 'completed'; });
  const overdueIds = new Set(overdue.map((item) => item.id));
  const active = items.filter((item) => !overdueIds.has(item.id) && item.status !== 'completed');
  const completed = items.filter((item) => item.status === 'completed' && state.today.items[item.id]);
  const order = (item) => state.today.items[item.id]?.order ?? Number.MAX_SAFE_INTEGER;
  active.sort((a, b) => order(a) - order(b) || a.activeOrder - b.activeOrder);
  overdue.sort((a, b) => order(a) - order(b) || a.activeOrder - b.activeOrder);
  completed.sort((a, b) => order(a) - order(b) || (a.completedOrder ?? 0) - (b.completedOrder ?? 0));
  return { overdue, active, completed };
}

export function attentionScore(state, itemId, now = new Date(), index = null) {
  const entries = index?.historyByItem.get(itemId) ?? state.history.filter((entry) => entry.itemId === itemId);
  const cutoff = now.getTime() - 30 * DAY_MS;
  return entries.filter((entry) => new Date(entry.at).getTime() >= cutoff).reduce((score, entry) => {
    const age = Math.max(0, (now.getTime() - new Date(entry.at).getTime()) / DAY_MS);
    return score + (ATTENTION_WEIGHTS[entry.type] ?? 0.5) * Math.exp(-age / 12);
  }, 0);
}

export function lastMeaningfulActivity(state, itemId, index = null) {
  const events = index?.historyByItem.get(itemId) ?? state.history.filter((entry) => entry.itemId === itemId);
  const latest = events.reduce((value, entry) => entry.at > value ? entry.at : value, '');
  return latest || (getItem(state, itemId, index)?.createdAt ?? null);
}

export function momentumScore(state, itemId, now = new Date(), index = null) {
  const seven = now.getTime() - 7 * DAY_MS;
  const thirty = now.getTime() - 30 * DAY_MS;
  const entries = index?.historyByItem.get(itemId) ?? state.history.filter((entry) => entry.itemId === itemId);
  const recent = entries.filter((entry) => new Date(entry.at).getTime() >= seven);
  const older = entries.filter((entry) => new Date(entry.at).getTime() >= thirty && new Date(entry.at).getTime() < seven);
  const completions = recent.filter((entry) => entry.type === 'completed').length;
  const progressActions = recent.filter((entry) => ['edited', 'add_child', 'note_edited', 'due_changed'].includes(entry.type)).length;
  return Math.round((completions * 2 + progressActions + recent.length * 0.25 - older.length * 0.1) * 10) / 10;
}

export function isStale(state, itemId, now = new Date(), index = null) {
  const context = index ?? createEngineIndex(state);
  const item = getItem(state, itemId, context);
  if (!item || item.status !== 'active') return false;
  const last = lastMeaningfulActivity(state, itemId, context);
  return !effectiveDue(state, itemId, context).value && last && now.getTime() - new Date(last).getTime() >= 14 * DAY_MS;
}

export function estimateCompletion(state, itemId, now = new Date(), index = null) {
  const context = index ?? createEngineIndex(state);
  const item = getItem(state, itemId, context);
  if (!item) return { value: null, reason: 'missing' };
  const completed = (context.historyByItem.get(itemId) ?? []).filter((entry) => entry.type === 'completed').map((entry) => new Date(entry.at).getTime()).filter(Number.isFinite);
  const children = descendantsOf(state, itemId, context);
  const childCompletion = children.flatMap((child) => (context.historyByItem.get(child.id) ?? []).filter((entry) => entry.type === 'completed').slice(0, 1)).map((entry) => new Date(entry.at).getTime());
  const samples = [...completed, ...childCompletion].filter((time) => time <= now.getTime());
  if (samples.length < 2) return { value: null, reason: 'insufficient' };
  const averageInterval = samples.slice(1).reduce((sum, time, index) => sum + Math.max(DAY_MS, time - samples[index]), 0) / Math.max(1, samples.length - 1);
  const remaining = Math.max(1, children.filter((child) => child.status !== 'completed' && child.status !== 'skipped').length || 1);
  return { value: new Date(now.getTime() + averageInterval * remaining).toISOString(), reason: 'history' };
}

export function routineSuggestion(state, itemId, now = new Date(), index = null) {
  const entries = index?.historyByItem.get(itemId) ?? state.history.filter((entry) => entry.itemId === itemId);
  const completions = entries.filter((entry) => entry.type === 'completed').map((entry) => new Date(entry.at).getTime()).sort((a, b) => a - b);
  if (completions.length < 3) return null;
  const intervals = completions.slice(1).map((time, index) => (time - completions[index]) / DAY_MS);
  const average = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  const variance = intervals.reduce((sum, value) => sum + (value - average) ** 2, 0) / intervals.length;
  if (average >= 1 && average <= 60 && Math.sqrt(variance) <= 2.5) return { intervalDays: Math.round(average), lastCompletedAt: new Date(completions.at(-1)).toISOString(), generatedAt: now.toISOString() };
  return null;
}

export function reminderPatternSuggestion(state) {
  const counts = new Map();
  for (const reminder of state.reminders) {
    if (!reminder.time || reminder.enabled === false) continue;
    counts.set(reminder.time, (counts.get(reminder.time) ?? 0) + 1);
  }
  const winner = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return winner && winner[1] >= 2 ? { time: winner[0], count: winner[1] } : null;
}

function dueDifference(state, itemId, now, index = null) {
  const due = effectiveDue(state, itemId, index).value;
  return due ? new Date(due).getTime() - now.getTime() : null;
}

export function smartViewItems(state, view, now = new Date(), index = null) {
  const context = index ?? createEngineIndex(state);
  const active = state.items.filter((item) => item.status !== 'skipped');
  const completed = active.filter((item) => item.status === 'completed');
  const current = active.filter((item) => item.status === 'active');
  const recentCutoff = now.getTime() - 14 * DAY_MS;
  const historyByItem = context.historyByItem;
  const latestActivity = (item) => historyByItem.get(item.id)?.reduce((latest, entry) => (entry.at > latest ? entry.at : latest), item.createdAt) ?? item.createdAt;
  const attentionByItem = new Map();
  const momentumByItem = new Map();
  for (const [itemId, entries] of historyByItem) {
    const attention = entries.reduce((score, entry) => {
      const at = new Date(entry.at).getTime();
      if (!Number.isFinite(at) || at < now.getTime() - 30 * DAY_MS) return score;
      return score + (ATTENTION_WEIGHTS[entry.type] ?? 0.5) * Math.exp(-Math.max(0, (now.getTime() - at) / DAY_MS) / 12);
    }, 0);
    const recent = entries.filter((entry) => new Date(entry.at).getTime() >= now.getTime() - 7 * DAY_MS);
    const older = entries.filter((entry) => { const at = new Date(entry.at).getTime(); return at >= now.getTime() - 30 * DAY_MS && at < now.getTime() - 7 * DAY_MS; });
    const completions = recent.filter((entry) => entry.type === 'completed').length;
    const progressActions = recent.filter((entry) => ['edited', 'add_child', 'note_edited', 'due_changed'].includes(entry.type)).length;
    attentionByItem.set(itemId, attention);
    momentumByItem.set(itemId, Math.round((completions * 2 + progressActions + recent.length * 0.25 - older.length * 0.1) * 10) / 10);
  }
  const dueMatches = (item, predicate) => { const diff = dueDifference(state, item.id, now, context); return diff !== null && predicate(diff); };
  let result;
  switch (view) {
    case 'today': { const groups = derivedTodayItems(state, now, context); result = [...groups.overdue, ...groups.active, ...groups.completed]; break; }
    case 'upcoming': result = [...current.filter((item) => dueMatches(item, (diff) => diff >= 0 && diff <= 14 * DAY_MS)), ...completed.filter((item) => dueMatches(item, (diff) => diff >= 0 && diff <= 14 * DAY_MS))]; break;
    case 'overdue': result = [...current.filter((item) => dueMatches(item, (diff) => diff < 0)), ...completed.filter((item) => dueMatches(item, (diff) => diff < 0))]; break;
    case 'recentlyCompleted': result = completed.filter((item) => item.completedAt && new Date(item.completedAt).getTime() >= recentCutoff); break;
    case 'readyToClose': result = [...current.filter((item) => progressForItem(state, item.id, context.progressByItem, new Set(), context) >= 100), ...completed.filter((item) => progressForItem(state, item.id, context.progressByItem, new Set(), context) >= 100)]; break;
    case 'recentlyActive': result = [...current.filter((item) => new Date(latestActivity(item)).getTime() >= recentCutoff), ...completed.filter((item) => new Date(latestActivity(item)).getTime() >= recentCutoff)]; break;
    case 'highAttention': result = [...current.filter((item) => (attentionByItem.get(item.id) ?? 0) >= 3), ...completed.filter((item) => (attentionByItem.get(item.id) ?? 0) >= 3)]; break;
    case 'stale': result = current.filter((item) => isStale(state, item.id, now, context)); break;
    case 'momentum': result = [...current.filter((item) => (momentumByItem.get(item.id) ?? 0) > 0), ...completed.filter((item) => (momentumByItem.get(item.id) ?? 0) > 0)]; break;
    case 'estimated': result = [...current, ...completed]; break;
    case 'routine': result = [...current.filter((item) => routineSuggestion(state, item.id, now, context)), ...completed.filter((item) => routineSuggestion(state, item.id, now, context))]; break;
    default: result = current;
  }
  const customOrder = state.smartOrders?.[view] ?? [];
  const customOrderIndex = new Map(customOrder.map((id, position) => [id, position]));
  return result.sort((a, b) => (a.status === 'completed') - (b.status === 'completed') || (customOrderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (customOrderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER) || (a.activeOrder ?? 0) - (b.activeOrder ?? 0));
}

export function reorderSmartView(state, view, itemId, beforeItemId = null, at = isoNow()) {
  const visibleIds = new Set(smartViewItems(state, view).map((item) => item.id));
  if (!visibleIds.has(itemId) || (beforeItemId && !visibleIds.has(beforeItemId))) return { ok: false, reason: 'missing' };
  const stored = (state.smartOrders?.[view] ?? []).filter((id) => visibleIds.has(id));
  const order = [...new Set([...stored, ...visibleIds])];
  const from = order.indexOf(itemId);
  if (from < 0) return { ok: false, reason: 'missing' };
  order.splice(from, 1);
  const target = beforeItemId ? order.indexOf(beforeItemId) : order.length;
  order.splice(target < 0 ? order.length : target, 0, itemId);
  state.smartOrders ??= {};
  state.smartOrders[view] = order;
  state.meta.updatedAt = at;
  return { ok: true, order };
}

export function searchItems(state, query, tag = '', index = null) {
  const normalized = String(query ?? '').trim().toLocaleLowerCase();
  const queryTag = normalized.startsWith('#') ? normalized.slice(1) : '';
  const textQuery = queryTag ? '' : normalized;
  const normalizedTag = String(tag ?? '').trim().replace(/^#/, '').toLocaleLowerCase() || queryTag;
  if (!normalized && !normalizedTag) return [];
  const context = index ?? createEngineIndex(state);
  return state.items.filter((item) => {
    if (item.status === 'skipped') return false;
    const haystack = `${item.title} ${item.notes} ${item.tags.join(' ')} ${pathString(state, item.id, context)}`.toLocaleLowerCase();
    return (!textQuery || haystack.includes(textQuery)) && (!normalizedTag || item.tags.some((candidate) => candidate.toLocaleLowerCase() === normalizedTag));
  });
}

export function createDeletedSnapshot(state, ids) {
  const idSet = new Set(ids);
  return {
    items: state.items.filter((item) => idSet.has(item.id)),
    history: state.history.filter((entry) => idSet.has(entry.itemId)),
    reminders: state.reminders.filter((reminder) => idSet.has(reminder.itemId)),
    today: Object.fromEntries(Object.entries(state.today.items).filter(([itemId]) => idSet.has(itemId))),
  };
}

export function softDeleteItem(state, itemId, at = isoNow()) {
  const item = getItem(state, itemId);
  if (!item) return { ok: false, reason: 'missing' };
  const ids = [item, ...descendantsOf(state, itemId)].map((candidate) => candidate.id);
  const snapshot = createDeletedSnapshot(state, ids);
  state.deleted.push({ id: newId('del'), kind: 'item_tree', rootId: itemId, categoryId: item.categoryId, parentId: item.parentId, deletedAt: at, purgeAfter: new Date(new Date(at).getTime() + 30 * DAY_MS).toISOString(), snapshot });
  state.items = state.items.filter((candidate) => !ids.includes(candidate.id));
  state.history = state.history.filter((entry) => !ids.includes(entry.itemId));
  state.reminders = state.reminders.filter((reminder) => !ids.includes(reminder.itemId));
  for (const id of ids) delete state.today.items[id];
  return { ok: true, ids, root: item };
}

export function softDeleteCategory(state, categoryId, at = isoNow()) {
  const category = getCategory(state, categoryId);
  if (!category) return { ok: false, reason: 'missing' };
  const ids = state.items.filter((item) => item.categoryId === categoryId).map((item) => item.id);
  const snapshot = { category: clone(category), ...createDeletedSnapshot(state, ids) };
  state.deleted.push({ id: newId('del'), kind: 'category_tree', rootId: categoryId, categoryId, parentId: null, deletedAt: at, purgeAfter: new Date(new Date(at).getTime() + 30 * DAY_MS).toISOString(), snapshot });
  state.categories = state.categories.filter((candidate) => candidate.id !== categoryId);
  state.items = state.items.filter((item) => item.categoryId !== categoryId);
  state.history = state.history.filter((entry) => !ids.includes(entry.itemId));
  state.reminders = state.reminders.filter((reminder) => !ids.includes(reminder.itemId));
  for (const id of ids) delete state.today.items[id];
  if (state.settings.defaultCategoryId === categoryId) state.settings.defaultCategoryId = state.categories[0]?.id ?? null;
  return { ok: true, ids, category };
}

export function purgeDeleted(state, now = new Date()) {
  const before = state.deleted.length;
  state.deleted = state.deleted.filter((entry) => new Date(entry.purgeAfter).getTime() > now.getTime());
  return before - state.deleted.length;
}

export function restoreDeleted(state, deletedId, at = isoNow()) {
  const index = state.deleted.findIndex((entry) => entry.id === deletedId);
  if (index < 0) return { ok: false, reason: 'missing' };
  const [entry] = state.deleted.splice(index, 1);
  if (entry.kind === 'category_tree') {
    const category = entry.snapshot.category;
    if (!getCategory(state, category.id)) state.categories.push(category);
  }
  const restored = [];
  for (const item of entry.snapshot.items) {
    const categoryExists = getCategory(state, item.categoryId);
    const parentExists = !item.parentId || getItem(state, item.parentId) || entry.snapshot.items.some((candidate) => candidate.id === item.parentId);
    if (categoryExists && parentExists && !getItem(state, item.id)) { state.items.push(item); restored.push(item.id); }
    else if (!getItem(state, item.id)) {
      const rootCategoryId = entry.kind === 'category_tree' ? entry.snapshot.category.id : (getCategory(state, entry.categoryId)?.id ?? state.settings.defaultCategoryId);
      state.items.push({ ...item, categoryId: rootCategoryId, parentId: null });
      restored.push(item.id);
    }
  }
  for (const history of entry.snapshot.history ?? []) if (restored.includes(history.itemId)) state.history.push(history);
  for (const reminder of entry.snapshot.reminders ?? []) if (restored.includes(reminder.itemId)) state.reminders.push(reminder);
  for (const [itemId, todayEntry] of Object.entries(entry.snapshot.today ?? {})) if (restored.includes(itemId)) state.today.items[itemId] = todayEntry;
  for (const id of restored) recordHistory(state, id, 'restored', {}, at);
  return { ok: true, restored, entry };
}

function shiftDate(value, delta) {
  if (!value) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Date(date.getTime() + delta).toISOString();
}

export function duplicateSubtree(state, itemId, { categoryId, parentId = null, title, includeChildren = true, copyNotes = true, referenceDate = null, suffix = '（副本）' }, at = isoNow()) {
  const source = getItem(state, itemId);
  if (!source) return { ok: false, reason: 'missing' };
  const targetCategoryId = categoryId ?? source.categoryId;
  if (!getCategory(state, targetCategoryId)) return { ok: false, reason: 'invalid_category' };
  if (parentId && !getItem(state, parentId)) return { ok: false, reason: 'invalid_parent' };
  const sourceNodes = includeChildren ? [source, ...descendantsOf(state, itemId)] : [source];
  const rootReference = referenceDate ? new Date(referenceDate).getTime() : new Date(at).getTime();
  const originalReferenceValue = source.plannedStart ?? (source.dueMode === 'explicit' ? source.dueDate : null) ?? source.createdAt;
  const originalReference = new Date(originalReferenceValue).getTime();
  const delta = Number.isFinite(rootReference) && Number.isFinite(originalReference) ? rootReference - originalReference : 0;
  const idMap = new Map();
  const copies = [];
  for (const original of sourceNodes) {
    const newItem = clone(original);
    newItem.id = newId('item');
    idMap.set(original.id, newItem.id);
    newItem.categoryId = targetCategoryId;
    newItem.parentId = original.id === source.id ? parentId : idMap.get(original.parentId) ?? parentId;
    newItem.title = original.id === source.id ? (title?.trim() || `${original.title}${suffix}`) : original.title;
    newItem.status = 'active';
    newItem.activeOrder = nextOrder(state, targetCategoryId, newItem.parentId, 'active') + copies.length;
    newItem.completedOrder = newItem.activeOrder;
    newItem.firstCompletedAt = null; newItem.completedAt = null; newItem.reopenedAt = null;
    newItem.revision = 0; newItem.baseRevision = 0; newItem.fieldRevisions = {};
    newItem.createdAt = shiftDate(original.createdAt, delta) ?? at;
    newItem.updatedAt = at;
    if (!copyNotes) newItem.notes = '';
    if (newItem.dueMode === 'explicit') newItem.dueDate = shiftDate(original.dueDate, delta);
    if (newItem.plannedStart) newItem.plannedStart = shiftDate(original.plannedStart, delta);
    copies.push(newItem);
  }
  state.items.push(...copies);
  for (const original of sourceNodes) {
    for (const reminder of state.reminders.filter((candidate) => candidate.itemId === original.id && candidate.type === 'relative')) {
      const newReminder = clone(reminder);
      newReminder.id = newId('rem'); newReminder.itemId = idMap.get(original.id); newReminder.suspendedByCompletion = false;
      newReminder.lastTriggeredAt = null; newReminder.snoozedUntil = null; newReminder.suppressedDay = null; newReminder.createdAt = at; newReminder.updatedAt = at;
      state.reminders.push(newReminder);
    }
  }
  for (const copy of copies) recordHistory(state, copy.id, 'created', { duplicateOf: source.id }, at);
  return { ok: true, root: copies[0], copies, idMap };
}

export function storageBreakdown(state) {
  const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const breakdown = {
    items: bytes(state.items), notes: bytes(state.items.map((item) => item.notes)), history: bytes(state.history), reminders: bytes(state.reminders),
    deleted: bytes(state.deleted), sync: bytes({ syncChanges: state.syncChanges, conflicts: state.conflicts }), conflicts: bytes(state.conflictArchive),
  };
  return { breakdown, total: Object.values(breakdown).reduce((sum, value) => sum + value, 0) };
}

export function formatPathForSmartView(state, itemId) {
  const item = getItem(state, itemId);
  if (!item) return '';
  const category = getCategory(state, item.categoryId);
  return [category?.title, ...ancestorsOf(state, itemId).map((candidate) => candidate.title)].filter(Boolean).join(' › ');
}
