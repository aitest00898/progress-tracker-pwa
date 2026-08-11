import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEmptyState } from '../src/schema.js';
import {
  addReminder, addToToday, createCategory, createItem, renameCategory, reorderSmartView,
  setDue, setNotes, setPriority, setTags, smartViewItems, updateReminder,
} from '../src/engine.js';
import {
  canPushState, coalescePendingChanges, datasetSwitchGate, enqueueLocalChange,
  GoogleDriveSync, mergeDatasets, prepareDatasetSwitch, resolveConflict, conflictArchiveRestorePreview, restoreConflictArchive,
} from '../src/sync.js';
import { ProgressRepository } from '../src/storage.js';

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

test('field conflict restore changes only the rejected field and preserves later edits', () => {
  const base = branch().s; const item = base.items[0]; const local = structuredClone(base); const remote = structuredClone(base);
  setDue(local, item.id, { mode: 'explicit', date: '2026-08-20T12:00:00.000Z' }, at);
  setDue(remote, item.id, { mode: 'explicit', date: '2026-08-25T12:00:00.000Z' }, at);
  const merged = mergeDatasets(base, local, remote); merged.state.conflicts = merged.conflicts;
  const conflict = merged.conflicts.find((candidate) => candidate.itemId === item.id && candidate.field === 'dueDate');
  assert.equal(resolveConflict(merged.state, conflict.id, 'local', at).ok, true);
  const resolvedItem = merged.state.items.find((candidate) => candidate.id === item.id);
  setPriority(merged.state, item.id, 'high', '2026-08-11T09:00:00.000Z');
  setNotes(merged.state, item.id, '後續備註', '2026-08-12T09:00:00.000Z');
  const archive = merged.state.conflictArchive.find((candidate) => candidate.field === 'dueDate');
  const preview = conflictArchiveRestorePreview(merged.state, archive.id, '2026-08-15T09:00:00.000Z');
  assert.equal(preview.ok, true); assert.equal(preview.changes.length, 1); assert.equal(preview.changes[0].field, 'dueDate');
  const beforeRevision = resolvedItem.revision;
  const restored = restoreConflictArchive(merged.state, archive.id, '2026-08-15T09:00:00.000Z');
  const afterItem = merged.state.items.find((candidate) => candidate.id === item.id);
  assert.equal(restored.ok, true); assert.equal(afterItem.dueDate, '2026-08-25T12:00:00.000Z'); assert.equal(afterItem.priority, 'high'); assert.equal(afterItem.notes, '後續備註');
  assert.ok(afterItem.revision > beforeRevision); assert.equal(merged.state.conflictArchive[0].restoreCount, 1); assert.ok(merged.state.conflictArchive[0].latestRestoreRevision);
  assert.ok(merged.state.history.some((entry) => entry.itemId === item.id && entry.type === 'conflict_archive_restored'));
});

test('archive restore through the repository creates a new revision and pending sync change', async () => {
  const base = branch().s; const item = base.items[0]; const local = structuredClone(base); const remote = structuredClone(base);
  setDue(local, item.id, { mode: 'explicit', date: '2026-08-20T12:00:00.000Z' }, at);
  setDue(remote, item.id, { mode: 'explicit', date: '2026-08-25T12:00:00.000Z' }, at);
  const merged = mergeDatasets(base, local, remote); merged.state.conflicts = merged.conflicts;
  const conflict = merged.conflicts.find((candidate) => candidate.field === 'dueDate');
  resolveConflict(merged.state, conflict.id, 'local', at);
  const archive = merged.state.conflictArchive[0];
  const repository = new ProgressRepository();
  repository.state = merged.state;
  repository.volatile = true;
  const beforeRevision = repository.state.meta.revision;
  const result = await repository.update('conflict_archive_restored', (draft) => restoreConflictArchive(draft, archive.id, '2026-08-15T09:00:00.000Z'));
  assert.equal(result.ok, true);
  assert.ok(result.state.meta.revision > beforeRevision);
  assert.ok(result.state.syncChanges.some((change) => change.label === 'conflict_archive_restored'));
  assert.equal(result.state.items.find((candidate) => candidate.id === item.id).dueDate, '2026-08-25T12:00:00.000Z');
});

test('parent conflict restore is cycle-safe and applies only the archived relationship', () => {
  const base = branch().s; const moved = base.items[0]; const left = createItem(base, { categoryId: base.categories[0].id, title: 'Left' }, at).item; const right = createItem(base, { categoryId: base.categories[0].id, title: 'Right' }, at).item;
  const local = structuredClone(base); const remote = structuredClone(base);
  local.items.find((item) => item.id === moved.id).parentId = left.id; remote.items.find((item) => item.id === moved.id).parentId = right.id;
  const merged = mergeDatasets(base, local, remote); merged.state.conflicts = merged.conflicts;
  const conflict = merged.conflicts.find((candidate) => candidate.type === 'parent' && candidate.itemId === moved.id);
  assert.equal(resolveConflict(merged.state, conflict.id, 'local', at).ok, true);
  const archive = merged.state.conflictArchive.find((candidate) => candidate.type === 'parent');
  assert.equal(conflictArchiveRestorePreview(merged.state, archive.id, '2026-08-15T09:00:00.000Z').ok, true);
  assert.equal(restoreConflictArchive(merged.state, archive.id, '2026-08-15T09:00:00.000Z').ok, true);
  assert.equal(merged.state.items.find((item) => item.id === moved.id).parentId, right.id);
  const invalidArchive = merged.state.conflictArchive.find((candidate) => candidate.id === archive.id);
  invalidArchive.rejectedState = { categoryId: moved.categoryId, parentId: moved.id };
  assert.equal(conflictArchiveRestorePreview(merged.state, invalidArchive.id, '2026-08-16T09:00:00.000Z').reason, 'cycle');
});

test('order conflict restore is deterministic and fails closed when the sibling set changed', () => {
  const base = branch().s; const second = createItem(base, { categoryId: base.categories[0].id, title: 'Second' }, at).item; const third = createItem(base, { categoryId: base.categories[0].id, title: 'Third' }, at).item; const id = base.items[0].id;
  const local = structuredClone(base); const remote = structuredClone(base);
  local.items.find((item) => item.id === id).activeOrder = 2; local.items.find((item) => item.id === second.id).activeOrder = 0; local.items.find((item) => item.id === third.id).activeOrder = 1;
  remote.items.find((item) => item.id === id).activeOrder = 1; remote.items.find((item) => item.id === second.id).activeOrder = 2; remote.items.find((item) => item.id === third.id).activeOrder = 0;
  const merged = mergeDatasets(base, local, remote); merged.state.conflicts = merged.conflicts;
  const conflict = merged.conflicts.find((candidate) => candidate.entityType === 'sibling_order');
  assert.equal(resolveConflict(merged.state, conflict.id, 'local', at).ok, true);
  const archive = merged.state.conflictArchive[0];
  assert.equal(restoreConflictArchive(merged.state, archive.id, '2026-08-15T09:00:00.000Z').ok, true);
  const order = merged.state.items.filter((item) => item.parentId === null).sort((a, b) => a.activeOrder - b.activeOrder).map((item) => item.id);
  assert.deepEqual(order, archive.rejectedState);
  merged.state.items.push(createItem(merged.state, { categoryId: merged.state.categories[0].id, title: 'New sibling' }, at).item);
  assert.equal(conflictArchiveRestorePreview(merged.state, archive.id, '2026-08-16T09:00:00.000Z').reason, 'order_target_changed');
});

test('conflict archive restore fails closed for missing targets and expired archives', () => {
  const base = branch().s; const item = base.items[0]; const local = structuredClone(base); const remote = structuredClone(base);
  setNotes(local, item.id, 'local', at); setNotes(remote, item.id, 'remote', at);
  const merged = mergeDatasets(base, local, remote); merged.state.conflicts = merged.conflicts;
  const conflict = merged.conflicts.find((candidate) => candidate.field === 'notes'); resolveConflict(merged.state, conflict.id, 'local', at);
  const archive = merged.state.conflictArchive[0];
  merged.state.items = merged.state.items.filter((candidate) => candidate.id !== item.id);
  assert.equal(conflictArchiveRestorePreview(merged.state, archive.id, '2026-08-15T09:00:00.000Z').reason, 'missing_target');
  merged.state.items.push(item); archive.purgeAfter = '2026-08-01T00:00:00.000Z';
  assert.equal(conflictArchiveRestorePreview(merged.state, archive.id, '2026-08-15T09:00:00.000Z').reason, 'expired');
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

test('three-way merge covers categories, tags, reminders, Today membership and settings', () => {
  const base = branch().s;
  const item = base.items[0];
  const category = createCategory(base, 'Shared category', at).category;
  const reminder = addReminder(base, item.id, { type: 'absolute', at: '2026-08-12T09:00:00.000Z' }, at).reminder;
  addToToday(base, item.id, 'manual', at);
  const local = structuredClone(base);
  const remote = structuredClone(base);
  renameCategory(local, category.id, 'Local category', at);
  setTags(local, item.id, ['Japan', 'Paid'], at);
  local.today.items[item.id].order = 12;
  updateReminder(remote, reminder.id, { time: '10:30' }, at);
  remote.today.items[item.id].source = 'planned';
  remote.settings.theme = 'dark';
  const result = mergeDatasets(base, local, remote, { at });
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.state.categories.find((entry) => entry.id === category.id).title, 'Local category');
  assert.deepEqual(result.state.items.find((entry) => entry.id === item.id).tags, ['Japan', 'Paid']);
  assert.equal(result.state.reminders.find((entry) => entry.id === reminder.id).time, '10:30');
  assert.equal(result.state.today.items[item.id].order, 12);
  assert.equal(result.state.today.items[item.id].source, 'planned');
  assert.equal(result.state.settings.theme, 'dark');
});

test('same-field Category, Reminder, and Today changes become explicit conflicts', () => {
  const base = branch().s;
  const item = base.items[0];
  const category = createCategory(base, 'Shared category', at).category;
  const reminder = addReminder(base, item.id, { type: 'absolute', at: '2026-08-12T09:00:00.000Z' }, at).reminder;
  addToToday(base, item.id, 'manual', at);
  const local = structuredClone(base);
  const remote = structuredClone(base);
  renameCategory(local, category.id, 'Local name', at);
  renameCategory(remote, category.id, 'Cloud name', at);
  updateReminder(local, reminder.id, { time: '08:30' }, at);
  updateReminder(remote, reminder.id, { time: '11:45' }, at);
  local.today.items[item.id].order = 4;
  remote.today.items[item.id].order = 9;
  const result = mergeDatasets(base, local, remote, { at });
  assert.ok(result.conflicts.some((conflict) => conflict.entityType === 'category' && conflict.field === 'title'));
  assert.ok(result.conflicts.some((conflict) => conflict.entityType === 'reminder' && conflict.field === 'time'));
  assert.ok(result.conflicts.some((conflict) => conflict.entityType === 'today' && conflict.field === 'order'));
  assert.equal(canPushState(result.state).reason, 'unresolved_conflicts');
});

test('conflicted entity is push-blocked while cloud projection preserves remote disputed data and carries unrelated safe changes', () => {
  const base = branch().s;
  const disputed = base.items[0];
  const unrelated = createItem(base, { categoryId: base.categories[0].id, title: 'Unrelated' }, at).item;
  const local = structuredClone(base);
  const remote = structuredClone(base);
  setNotes(local, disputed.id, 'local version', at);
  setNotes(remote, disputed.id, 'cloud version', at);
  setPriority(local, unrelated.id, 'high', at);
  const result = mergeDatasets(base, local, remote, { at });
  assert.equal(canPushState(result.state).reason, 'unresolved_conflicts');
  assert.equal(canPushState(result.cloudState).ok, true);
  assert.equal(result.cloudState.items.find((item) => item.id === disputed.id).notes, 'cloud version');
  assert.equal(result.cloudState.items.find((item) => item.id === unrelated.id).priority, 'high');
  assert.equal(result.safeChanges, true);
});

test('different parent moves are structural conflicts and cannot create a hidden cycle', () => {
  const base = branch().s;
  const moved = base.items[0];
  const left = createItem(base, { categoryId: base.categories[0].id, title: 'Left' }, at).item;
  const right = createItem(base, { categoryId: base.categories[0].id, title: 'Right' }, at).item;
  const local = structuredClone(base);
  const remote = structuredClone(base);
  local.items.find((item) => item.id === moved.id).parentId = left.id;
  remote.items.find((item) => item.id === moved.id).parentId = right.id;
  const result = mergeDatasets(base, local, remote, { at });
  assert.ok(result.conflicts.some((conflict) => conflict.type === 'parent' && conflict.itemId === moved.id));
  assert.equal(result.cloudState.items.find((item) => item.id === moved.id).parentId, right.id);
});

test('account or dataset switch requires an independent full backup or a second explicit risk acknowledgement', () => {
  const current = branch().s;
  const incoming = makeEmptyState(at);
  const before = structuredClone(current);
  let gate = datasetSwitchGate(current);
  assert.equal(gate.allowed, false);
  assert.equal(gate.requiresRiskAcknowledgement, true);
  const refused = prepareDatasetSwitch(current, incoming, { riskAccepted: false, at });
  assert.equal(refused.ok, false);
  assert.deepEqual(current, before);
  assert.equal(refused.state.meta.datasetId, current.meta.datasetId);
  gate = datasetSwitchGate(current, { riskAccepted: true });
  assert.equal(gate.allowed, true);
  assert.equal(gate.backedUp, false);
  const prepared = prepareDatasetSwitch(current, incoming, { riskAccepted: true, at });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.safety.sourceDatasetId, current.meta.datasetId);
  assert.equal(prepared.safety.targetDatasetId, incoming.meta.datasetId);
  assert.equal(prepared.state.recoverySnapshots.at(-1).kind, 'dataset_switch');
  current.backupMeta.push({ id: 'full_backup', scope: 'full', independentlyRestorable: true, createdAt: at });
  assert.equal(datasetSwitchGate(current).allowed, true);
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function mockDrive(responder) {
  const calls = [];
  const drive = new GoogleDriveSync({ fetchImpl: async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return responder(String(url), options, calls);
  } });
  drive.accessToken = 'test-access-token';
  drive.tokenExpiresAt = Date.now() + 60_000;
  return { drive, calls };
}

test('Drive pull selects exactly one matching datasetId and ignores trashed files', async () => {
  const remote = makeEmptyState(at);
  remote.meta.datasetId = 'dataset-a';
  const files = [
    { id: 'file-a', name: 'progress-tracker-sync.json', trashed: false, appProperties: { datasetId: 'dataset-a' } },
    { id: 'file-b', name: 'progress-tracker-sync.json', trashed: false, appProperties: { datasetId: 'dataset-b' } },
    { id: 'file-trash', name: 'progress-tracker-sync.json', trashed: true, appProperties: { datasetId: 'dataset-a' } },
  ];
  const { drive } = mockDrive((url) => {
    if (url.includes('?alt=media')) return jsonResponse({ identity: { datasetId: 'dataset-a' }, state: remote });
    return jsonResponse({ files });
  });
  const result = await drive.pull('dataset-a');
  assert.equal(result.status, 'remote');
  assert.equal(result.file.id, 'file-a');
  assert.equal(result.state.meta.datasetId, 'dataset-a');
});

test('Drive pull requires an explicit choice for duplicate or unrelated datasets', async () => {
  const duplicateFiles = [
    { id: 'file-a1', trashed: false, appProperties: { datasetId: 'dataset-a' } },
    { id: 'file-a2', trashed: false, appProperties: { datasetId: 'dataset-a' } },
  ];
  let mocked = mockDrive(() => jsonResponse({ files: duplicateFiles }));
  let result = await mocked.drive.pull('dataset-a');
  assert.equal(result.status, 'dataset_choice');
  assert.equal(result.reason, 'duplicate_dataset_files');
  mocked = mockDrive(() => jsonResponse({ files: [{ id: 'file-b', trashed: false, appProperties: { datasetId: 'dataset-b' } }] }));
  result = await mocked.drive.pull('dataset-a');
  assert.equal(result.status, 'dataset_choice');
  assert.equal(result.reason, 'dataset_not_found');
});

test('Drive rejects appProperties versus payload identity mismatch', async () => {
  const remote = makeEmptyState(at);
  remote.meta.datasetId = 'dataset-b';
  const { drive } = mockDrive((url) => {
    if (url.includes('?alt=media')) return jsonResponse({ identity: { datasetId: 'dataset-b' }, state: remote });
    return jsonResponse({ files: [{ id: 'file-a', trashed: false, appProperties: { datasetId: 'dataset-a' } }] });
  });
  const result = await drive.pull('dataset-a');
  assert.equal(result.status, 'wrong_dataset');
  assert.equal(result.actualDatasetId, 'dataset-a');
});

test('stale persisted Drive fileId falls back to a fresh exact dataset lookup', async () => {
  const remote = makeEmptyState(at);
  remote.meta.datasetId = 'dataset-a';
  const { drive, calls } = mockDrive((url) => {
    if (url.includes('/stale-file?fields=')) return jsonResponse({ error: 'not found' }, 404);
    if (url.includes('?alt=media')) return jsonResponse({ identity: { datasetId: 'dataset-a' }, state: remote });
    return jsonResponse({ files: [{ id: 'fresh-file', trashed: false, appProperties: { datasetId: 'dataset-a' } }] });
  });
  const result = await drive.pull('dataset-a', 'stale-file');
  assert.equal(result.status, 'remote');
  assert.equal(result.file.id, 'fresh-file');
  assert.ok(calls.some((call) => call.url.includes('/stale-file?fields=')));
});

test('Drive treats a list containing only deleted files as empty and blocks push to a wrong dataset file', async () => {
  let mocked = mockDrive(() => jsonResponse({ files: [{ id: 'deleted-file', trashed: true, appProperties: { datasetId: 'dataset-a' } }] }));
  const result = await mocked.drive.pull('dataset-a');
  assert.equal(result.status, 'empty');
  const state = makeEmptyState(at);
  state.meta.datasetId = 'dataset-a';
  mocked = mockDrive((url) => {
    if (url.includes('/wrong-file?fields=')) return jsonResponse({ id: 'wrong-file', trashed: false, appProperties: { datasetId: 'dataset-b' } });
    throw new Error('upload must not be attempted');
  });
  await assert.rejects(() => mocked.drive.push(state, 'wrong-file'), (error) => error.code === 'dataset_mismatch');
  assert.equal(mocked.calls.length, 1);
});
