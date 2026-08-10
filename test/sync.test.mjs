import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEmptyState } from '../src/schema.js';
import { createItem, reorderSmartView, setDue, setNotes, setPriority, smartViewItems } from '../src/engine.js';
import { coalescePendingChanges, enqueueLocalChange, mergeDatasets, resolveConflict } from '../src/sync.js';

const at = '2026-08-10T09:00:00.000Z';
function branch() { const s = makeEmptyState(at); const item = createItem(s, { categoryId: s.categories[0].id, title: 'Shared' }, at).item; return { s, item }; }

test('different fields auto-merge while same field becomes a conflict', () => {
  const base = branch().s; const local = structuredClone(base); const remote = structuredClone(base); const id = base.items[0].id;
  setDue(local, id, { mode: 'explicit', date: '2026-08-25T12:00:00.000Z' }, at); setNotes(remote, id, 'remote notes', at);
  let result = mergeDatasets(base, local, remote); assert.equal(result.conflicts.length, 0); assert.equal(result.state.items[0].dueDate, '2026-08-25T12:00:00.000Z'); assert.equal(result.state.items[0].notes, 'remote notes');
  const remote2 = structuredClone(base); setDue(remote2, id, { mode: 'explicit', date: '2026-08-18T12:00:00.000Z' }, at); result = mergeDatasets(base, local, remote2); assert.ok(result.conflicts.some((conflict) => conflict.field === 'dueDate'));
});

test('delete/edit and order conflicts are not silently last-write-wins', () => {
  const base = branch().s; const id = base.items[0].id; const local = structuredClone(base); const remote = structuredClone(base); local.items = [];
  setPriority(remote, id, 'high', at); let result = mergeDatasets(base, local, remote); assert.ok(result.conflicts.some((conflict) => conflict.type === 'delete_edit'));
  const second = createItem(base, { categoryId: base.categories[0].id, title: 'Second' }, at).item; const third = createItem(base, { categoryId: base.categories[0].id, title: 'Third' }, at).item; const l2 = structuredClone(base); const r2 = structuredClone(base); l2.items.find((item) => item.id === id).activeOrder = 2; l2.items.find((item) => item.id === second.id).activeOrder = 0; l2.items.find((item) => item.id === third.id).activeOrder = 1; r2.items.find((item) => item.id === id).activeOrder = 1; r2.items.find((item) => item.id === second.id).activeOrder = 2; r2.items.find((item) => item.id === third.id).activeOrder = 0; result = mergeDatasets(base, l2, r2); assert.ok(result.conflicts.some((conflict) => conflict.type === 'order'));
});

test('conflict resolution archives rejected state and unrelated items continue', () => {
  const base = branch().s; const id = base.items[0].id; const unrelated = createItem(base, { categoryId: base.categories[0].id, title: 'Other' }, at).item; const local = structuredClone(base); const remote = structuredClone(base);
  setNotes(local, id, 'local', at); setNotes(remote, id, 'remote', at); setPriority(remote, unrelated.id, 'high', at);
  const result = mergeDatasets(base, local, remote); const conflict = result.conflicts.find((candidate) => candidate.itemId === id && candidate.field === 'notes'); result.state.conflicts = result.conflicts;
  const beforeRevision = result.state.items.find((item) => item.id === id).revision;
  const resolved = resolveConflict(result.state, conflict.id, 'local', at); assert.equal(resolved.ok, true); assert.equal(result.state.items.find((item) => item.id === id).notes, 'local'); assert.ok(result.state.items.find((item) => item.id === id).revision > beforeRevision); assert.ok(result.state.history.some((entry) => entry.itemId === id && entry.type === 'conflict_resolved')); assert.equal(result.state.conflictArchive.length, 1); assert.equal(result.state.items.find((item) => item.id === unrelated.id).priority, 'high');
  const changes = coalescePendingChanges([{ id: '1', coalesceKey: 'item', label: 'edit', revision: 1 }, { id: '2', coalesceKey: 'item', label: 'notes', revision: 2 }]); assert.equal(changes.length, 1); assert.deepEqual(changes[0].labels, ['edit', 'notes']);
});

test('Smart View reorder has an independent order and does not mutate tree order', () => {
  const state = makeEmptyState(at);
  const first = createItem(state, { categoryId: state.categories[0].id, title: 'First' }, at).item;
  const second = createItem(state, { categoryId: state.categories[0].id, title: 'Second' }, at).item;
  const before = state.items.map((item) => [item.id, item.activeOrder]);
  const result = reorderSmartView(state, 'estimated', second.id, first.id, at);
  assert.equal(result.ok, true);
  assert.deepEqual(state.items.map((item) => [item.id, item.activeOrder]), before);
  assert.deepEqual(smartViewItems(state, 'estimated').map((item) => item.id).slice(0, 2), [second.id, first.id]);
});

test('pending changes coalesce by changed item while preserving semantic labels', () => {
  const state = makeEmptyState(at);
  const item = createItem(state, { categoryId: state.categories[0].id, title: 'Coalesce' }, at).item;
  state.meta.revision = 1;
  enqueueLocalChange(state, 'title_changed', [item.id]);
  state.meta.revision = 2;
  enqueueLocalChange(state, 'note_edited', [item.id]);
  assert.equal(state.syncChanges.length, 1);
  assert.deepEqual(state.syncChanges[0].labels, ['title_changed', 'note_edited']);
});
