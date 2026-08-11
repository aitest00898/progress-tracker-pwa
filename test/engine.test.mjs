import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEmptyState, normalizeState } from '../src/schema.js';
import {
  addReminder, addToToday, applyDailyRollover, canMove, childrenOf, completionNeedsConfirmation, createCategory, createItem,
  derivedTodayItems, duplicateSubtree, effectiveDue, effectivePlannedStart, formatProgress, moveImpact, moveSubtree, progressForItem, progressResultForItem, reminderOccurrence,
  reminderState, removeFromToday, restoreDeleted, setDue, setImportance, setItemStatus, softDeleteItem,
  snoozeReminder, dueImpactOnRemoval, smartViewItems, reminderPatternSuggestion,
} from '../src/engine.js';

const at = '2026-08-10T09:00:00.000Z';
function state() { return makeEmptyState(at); }
function add(s, title, parentId = null, categoryId = s.categories[0].id) { return createItem(s, { categoryId, parentId, title }, at).item; }

test('deep hierarchy is allowed and cycle prevention is enforced at the data layer', () => {
  const s = state();
  let parent = null;
  for (let i = 0; i < 12; i += 1) parent = add(s, `level-${i}`, parent?.id ?? null);
  const root = s.items[0];
  assert.equal(s.items.length, 12);
  assert.deepEqual(canMove(s, root.id, { categoryId: root.categoryId, parentId: parent.id }), { ok: false, reason: 'cycle' });
});

test('new categories are inserted beside the current category', () => {
  const s = state();
  const first = s.categories[0];
  createCategory(s, 'Second', at);
  const created = createCategory(s, 'Beside current', at, first.id).category;
  assert.deepEqual(s.categories.sort((a, b) => a.order - b.order).map((category) => category.title), ['我的計畫', 'Beside current', 'Second']);
  assert.equal(created.order, 1);
});

test('quick create rejects an empty or whitespace-only title without adding an item', () => {
  const s = state();
  const result = createItem(s, { categoryId: s.categories[0].id, title: ' \n\t ' }, at);
  assert.deepEqual(result, { ok: false, reason: 'required' });
  assert.equal(s.items.length, 0);
});

test('moving a subtree preserves descendants and changes their category atomically', () => {
  const s = state();
  const target = createCategory(s, '旅行',  at).category;
  const root = add(s, '旅行準備');
  const child = add(s, '護照', root.id);
  const grandchild = add(s, '影本', child.id);
  const result = moveSubtree(s, root.id, { categoryId: target.id, parentId: null }, at);
  assert.equal(result.ok, true);
  assert.equal(s.items.find((item) => item.id === root.id).categoryId, target.id);
  assert.equal(s.items.find((item) => item.id === child.id).categoryId, target.id);
  assert.equal(s.items.find((item) => item.id === grandchild.id).categoryId, target.id);
  assert.equal(s.items.find((item) => item.id === child.id).parentId, root.id);
});

test('move impact previews inherited due and relative reminder changes without mutating the source', () => {
  const s = state();
  const target = createCategory(s, '另一分類', at).category;
  const parent = add(s, '有期限父項目');
  const child = add(s, '繼承期限子項目', parent.id);
  setDue(s, parent.id, { mode: 'explicit', date: '2026-08-20T12:00:00.000Z' }, at);
  addReminder(s, child.id, { type: 'relative', offsetDays: -1 }, at);
  const impact = moveImpact(s, child.id, { categoryId: target.id, parentId: null }, new Date(at));
  assert.equal(impact.ok, true);
  assert.equal(impact.dueChanges.length, 1);
  assert.equal(impact.reminderChanges.length, 1);
  assert.ok(impact.warnings.includes('lost_inherited_due'));
  assert.equal(s.items.find((item) => item.id === child.id).parentId, parent.id);
});

test('progress uses recursive weighted averages, excludes skipped children, and never auto-completes', () => {
  const s = state();
  const parent = add(s, '計畫');
  const a = add(s, 'A', parent.id); const b = add(s, 'B', parent.id); const skipped = add(s, '略過', parent.id);
  setImportance(s, b.id, 3, at);
  setItemStatus(s, a.id, 'completed', { force: true, at });
  setItemStatus(s, skipped.id, 'skipped', { force: true, at });
  assert.equal(progressForItem(s, parent.id), 25);
  assert.equal(s.items.find((item) => item.id === parent.id).status, 'active');
  assert.equal(completionNeedsConfirmation(s, parent.id), true);
  setItemStatus(s, b.id, 'completed', { force: true, at });
  assert.equal(progressForItem(s, parent.id), 100);
  assert.equal(s.items.find((item) => item.id === parent.id).status, 'active');
});

test('progress keeps raw precision for 2000 children and never displays rounded incomplete work as 100%', () => {
  const s = state(); const parent = add(s, '大量子項目');
  for (let index = 0; index < 2000; index += 1) {
    const child = add(s, `子項目 ${index}`, parent.id);
    if (index < 1999) setItemStatus(s, child.id, 'completed', { force: true, at });
  }
  const result = progressResultForItem(s, parent.id);
  assert.ok(result.raw < 100);
  assert.equal(result.complete, false);
  assert.equal(formatProgress(result.raw, result.complete), 99.9);
  assert.equal(smartViewItems(s, 'readyToClose', new Date(at)).some((item) => item.id === parent.id), false);
  assert.equal(s.items.find((item) => item.id === parent.id).status, 'active');
});

test('all effective children can reach raw 100 without auto-completing the parent', () => {
  const s = state(); const parent = add(s, '全部完成'); const child = add(s, '子項目', parent.id);
  setItemStatus(s, child.id, 'completed', { force: true, at });
  const result = progressResultForItem(s, parent.id);
  assert.equal(result.raw, 100);
  assert.equal(result.complete, true);
  assert.equal(formatProgress(result.raw, result.complete), 100);
  assert.equal(s.items.find((item) => item.id === parent.id).status, 'active');
  assert.equal(smartViewItems(s, 'readyToClose', new Date(at)).some((item) => item.id === parent.id), true);
});

test('deep weighted progress remains incomplete when one bottom-level node is active', () => {
  const s = state(); let parent = add(s, '深層根');
  for (let depth = 1; depth <= 5; depth += 1) {
    const next = add(s, `深度 ${depth}`, parent.id);
    const completed = add(s, `完成分支 ${depth}`, parent.id);
    setImportance(s, completed.id, depth % 4, at);
    setItemStatus(s, completed.id, 'completed', { force: true, at });
    parent = next;
  }
  const activeLeaf = add(s, '底層尚未完成', parent.id);
  setImportance(s, activeLeaf.id, 3, at);
  let cursor = s.items.find((item) => item.title === '深層根');
  for (let depth = 0; depth < 6; depth += 1) {
    const result = progressResultForItem(s, cursor.id);
    assert.ok(result.raw < 100);
    assert.equal(result.complete, false);
    cursor = s.items.find((item) => item.parentId === cursor.id && item.title.startsWith('深度'));
    if (!cursor) break;
  }
});

test('Ready to Close uses active domain completion, excludes completed and incomplete leaves, and excludes skipped-only parents', () => {
  const s = state();
  const activeComplete = add(s, '可確認'); const child = add(s, '已完成子項', activeComplete.id); setItemStatus(s, child.id, 'completed', { force: true, at });
  const completedParent = add(s, '已確認'); setItemStatus(s, completedParent.id, 'completed', { force: true, at });
  const incompleteLeaf = add(s, '尚未完成葉');
  const skippedParent = add(s, '只有略過子項'); const skipped = add(s, '略過', skippedParent.id); setItemStatus(s, skipped.id, 'skipped', { force: true, at });
  const ready = smartViewItems(s, 'readyToClose', new Date(at)).map((item) => item.id);
  assert.ok(ready.includes(activeComplete.id));
  assert.ok(!ready.includes(completedParent.id));
  assert.ok(!ready.includes(incompleteLeaf.id));
  assert.ok(!ready.includes(skippedParent.id));
});

test('due inheritance, explicit no-deadline, ancestor changes, and planned-start context stay derived', () => {
  const s = state();
  const parent = add(s, 'Parent'); const child = add(s, 'Child', parent.id); const grandchild = add(s, 'Grandchild', child.id);
  setDue(s, parent.id, { mode: 'explicit', date: '2026-08-12T12:00:00.000Z' }, at);
  assert.equal(effectiveDue(s, child.id).source, 'inherited');
  assert.equal(effectiveDue(s, grandchild.id).value, '2026-08-12T12:00:00.000Z');
  setDue(s, child.id, { mode: 'none', date: null }, at);
  assert.equal(effectiveDue(s, child.id).value, null);
  assert.equal(effectiveDue(s, grandchild.id).value, '2026-08-12T12:00:00.000Z');
  setDue(s, child.id, { mode: 'inherit', date: null }, at);
  setDue(s, parent.id, { mode: 'explicit', date: '2026-08-20T12:00:00.000Z' }, at);
  assert.equal(effectiveDue(s, child.id).value, '2026-08-20T12:00:00.000Z');
  s.items.find((item) => item.id === parent.id).plannedStart = '2026-08-10T12:00:00.000Z';
  assert.equal(effectivePlannedStart(s, child.id).source, 'inherited_context');
  assert.equal(derivedTodayItems(s, new Date('2026-08-10T15:00:00.000Z')).active.some((item) => item.id === child.id), false);
  const futureStart = add(s, 'Future start');
  futureStart.plannedStart = '2026-08-10T23:00:00.000Z';
  assert.equal(derivedTodayItems(s, new Date('2026-08-10T15:00:00.000Z')).active.some((item) => item.id === futureStart.id), false);
  const impact = dueImpactOnRemoval(s, parent.id);
  assert.ok(impact.changed.length + impact.lost.length >= 1);
});

test('relative and absolute reminders recalculate and complete/reopen suspension is reversible', () => {
  const s = state(); const item = add(s, 'Reminder item');
  setDue(s, item.id, { mode: 'explicit', date: '2026-08-20T12:00:00.000Z' }, at);
  const relative = addReminder(s, item.id, { type: 'relative', offsetDays: -3, time: '09:00' }, at).reminder;
  const absolute = addReminder(s, item.id, { type: 'absolute', at: '2026-08-15T09:00:00.000Z', time: '09:00' }, at).reminder;
  assert.equal(reminderOccurrence(s, relative).getHours(), 9);
  assert.equal(reminderOccurrence(s, absolute).toISOString(), '2026-08-15T09:00:00.000Z');
  setDue(s, item.id, { mode: 'explicit', date: '2026-08-25T12:00:00.000Z' }, at);
  assert.equal(reminderOccurrence(s, relative).getHours(), 9);
  assert.equal(reminderOccurrence(s, absolute).toISOString(), '2026-08-15T09:00:00.000Z');
  setItemStatus(s, item.id, 'completed', { force: true, at });
  assert.equal(reminderState(s, relative, new Date('2026-08-18T09:00:00.000Z')), 'disabled');
  assert.equal(normalizeState(s).reminders.find((candidate) => candidate.id === relative.id).suspendedByCompletion, true);
  setItemStatus(s, item.id, 'active', { force: true, at: '2026-08-11T09:00:00.000Z' });
  assert.equal(s.reminders.find((candidate) => candidate.id === relative.id).suspendedByCompletion, false);
  const missed = reminderState(s, relative, new Date('2026-08-18T09:00:00.000Z'));
  assert.notEqual(missed, 'missed');
  const missedItem = add(s, 'Missed reminder');
  const missedReminder = addReminder(s, missedItem.id, { type: 'absolute', at: '2026-08-01T09:00:00.000Z' }, at).reminder;
  assert.equal(reminderState(s, missedReminder, new Date('2026-08-23T09:00:00.000Z')), 'missed');
  snoozeReminder(s, relative.id, '2026-08-23T10:00:00.000Z', '2026-08-23T09:00:00.000Z');
  assert.equal(reminderState(s, relative, new Date('2026-08-23T09:30:00.000Z')), 'snoozed');
});

test('Today persists manual membership and rollover removes completed entries only on next open', () => {
  const s = state(); const active = add(s, '保留'); const completed = add(s, '完成');
  addToToday(s, active.id, 'manual', at); addToToday(s, completed.id, 'manual', at);
  setItemStatus(s, completed.id, 'completed', { force: true, at });
  s.today.items[completed.id].completedAt = at;
  assert.equal(Object.keys(s.today.items).length, 2);
  applyDailyRollover(s, new Date('2026-08-13T09:00:00.000Z'));
  assert.ok(s.today.items[active.id]);
  assert.equal(s.today.items[completed.id], undefined);
  assert.equal(derivedTodayItems(s, new Date('2026-08-13T09:00:00.000Z')).active.some((item) => item.id === active.id), true);
  removeFromToday(s, active.id);
  assert.equal(s.today.items[active.id], undefined);
});

test('soft deletion keeps a restorable subtree snapshot and restore preserves tree', () => {
  const s = state(); const root = add(s, '刪除根'); const child = add(s, '子項目', root.id); const reminder = addReminder(s, child.id, { type: 'absolute', at }, at).reminder;
  const deleted = softDeleteItem(s, root.id, at);
  assert.equal(s.items.length, 0); assert.equal(s.deleted.length, 1); assert.ok(deleted.ids.includes(child.id));
  const restored = restoreDeleted(s, s.deleted[0].id, '2026-08-11T09:00:00.000Z');
  assert.equal(restored.ok, true); assert.equal(childrenOf(s, root.id)[0].id, child.id); assert.ok(s.reminders.some((candidate) => candidate.id === reminder.id));
});

test('restoring an item whose parent disappeared falls back to its original category root', () => {
  const s = state(); const category = createCategory(s, 'Second', at).category; const parent = add(s, 'Original parent', null, category.id); const item = add(s, 'Keep category', parent.id, category.id);
  softDeleteItem(s, item.id, at); s.items = s.items.filter((candidate) => candidate.id !== parent.id); const restored = restoreDeleted(s, s.deleted[0].id, at);
  assert.equal(restored.ok, true); assert.equal(s.items.find((candidate) => candidate.id === item.id).categoryId, category.id); assert.equal(s.items.find((candidate) => candidate.id === item.id).parentId, null);
});

test('duplicate resets execution state but keeps structure, tags, explicit date relationships, and relative reminder rules', () => {
  const s = state(); const root = add(s, '原計畫'); const child = add(s, '步驟', root.id); s.items.find((item) => item.id === root.id).dueMode = 'explicit'; s.items.find((item) => item.id === root.id).dueDate = '2026-08-10T12:00:00.000Z'; s.items.find((item) => item.id === root.id).tags = ['旅行']; setItemStatus(s, child.id, 'completed', { force: true, at }); addReminder(s, root.id, { type: 'relative', offsetDays: -1 }, at); addReminder(s, root.id, { type: 'absolute', at }, at);
  const result = duplicateSubtree(s, root.id, { categoryId: s.categories[0].id, parentId: null, includeChildren: true, copyNotes: false, referenceDate: '2026-08-20T12:00:00.000Z', suffix: ' (copy)' }, '2026-08-20T12:00:00.000Z');
  assert.equal(result.ok, true); assert.equal(result.copies.length, 2); assert.equal(result.copies[0].status, 'active'); assert.equal(result.copies[1].status, 'active'); assert.equal(result.copies[0].dueDate, '2026-08-20T12:00:00.000Z'); assert.equal(s.reminders.filter((reminder) => reminder.itemId === result.root.id).length, 1);
});

test('smart views are deterministic and operate on original IDs', () => {
  const s = state(); const item = add(s, '逾期'); setDue(s, item.id, { mode: 'explicit', date: '2026-08-01T12:00:00.000Z' }, at);
  assert.equal(smartViewItems(s, 'overdue', new Date('2026-08-10T09:00:00.000Z'))[0].id, item.id);
  assert.equal(smartViewItems(s, 'readyToClose', new Date(at)).length, 0);
  setItemStatus(s, item.id, 'completed', { force: true, at });
  assert.equal(smartViewItems(s, 'overdue', new Date('2026-08-10T09:00:00.000Z')).at(-1).id, item.id);
});

test('reminder learning is a deterministic suggestion and does not mutate rules', () => {
  const s = state();
  const first = add(s, 'First'); const second = add(s, 'Second');
  addReminder(s, first.id, { type: 'absolute', at: '2026-08-10T09:00:00.000Z', time: '09:00' }, at);
  addReminder(s, second.id, { type: 'absolute', at: '2026-08-11T09:00:00.000Z', time: '09:00' }, at);
  assert.deepEqual(reminderPatternSuggestion(s), { time: '09:00', count: 2 });
  assert.equal(s.reminders[0].time, '09:00');
});
