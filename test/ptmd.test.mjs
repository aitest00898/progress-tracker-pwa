import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEmptyState } from '../src/schema.js';
import { createItem, setNotes, setTags, setItemStatus } from '../src/engine.js';
import { exportPTMD, parsePTMD, previewImport, applyImportPreview, restorePreview } from '../src/ptmd.js';

const at = '2026-08-10T09:00:00.000Z';

test('PTMD full backup is human-readable, machine-readable, and round-trips notes, tags, hierarchy, history', () => {
  const state = makeEmptyState(at); const categoryId = state.categories[0].id;
  const root = createItem(state, { categoryId, title: 'Trip' }, at).item; const child = createItem(state, { categoryId, parentId: root.id, title: 'Passport' }, at).item;
  setNotes(state, root.id, '# Plan\n\n- [ ] Book', at); setTags(state, root.id, ['travel', '#paid'], at); setItemStatus(state, child.id, 'completed', { force: true, at });
  const text = exportPTMD(state, { scope: 'full', exportedAt: at, timezone: 'Asia/Taipei' });
  assert.match(text, /progress_tracker_export: true/); assert.match(text, /<!-- pt:item /); assert.match(text, /- \[x\] Passport/); assert.match(text, /# Plan/);
  const parsed = parsePTMD(text); assert.equal(parsed.ok, true); assert.equal(parsed.backupState.items.length, 2); assert.equal(parsed.backupState.items.find((item) => item.id === root.id).tags[0], 'travel');
});

test('PTMD import is add-only, skips same IDs, isolates unsafe hierarchy, and disables imported reminders', () => {
  const state = makeEmptyState(at); const root = createItem(state, { categoryId: state.categories[0].id, title: 'Existing' }, at).item;
  const incoming = makeEmptyState(at); const newRoot = createItem(incoming, { categoryId: incoming.categories[0].id, title: 'Imported' }, at).item;
  newRoot.tags = ['new']; incoming.reminders.push({ id: 'r1', itemId: newRoot.id, type: 'absolute', at, enabled: true });
  const text = exportPTMD({ ...incoming, items: [newRoot] }, { scope: 'category', targetId: incoming.categories[0].id, exportedAt: at });
  const parsed = parsePTMD(text); const preview = previewImport(state, parsed, { language: 'en', now: at });
  assert.equal(preview.ok, true); assert.equal(preview.importedItems.length, 1); assert.equal(preview.importedReminders[0].enabled, false);
  createItem(state, { categoryId: state.categories[0].id, title: 'Concurrent local item' }, at);
  const applied = applyImportPreview(state, preview, at); assert.equal(applied.ok, true); assert.ok(applied.state.items.some((item) => item.title === 'Imported')); assert.ok(applied.state.items.some((item) => item.id === root.id));
  assert.ok(applied.state.items.some((item) => item.title === 'Concurrent local item'));
  const same = previewImport(applied.state, parsed, { language: 'en', now: at }); assert.equal(same.skippedCount, 1);
});

test('PTMD parser rejects malformed and unsupported versions without mutation', () => {
  assert.equal(parsePTMD('not ptmd').ok, false);
  assert.equal(parsePTMD('---\nprogress_tracker_export: true\nformat_version: 99\n---\n').reason, 'unsupported');
});

test('PTMD import isolates a parent ID that belongs to another category', () => {
  const current = makeEmptyState(at);
  const otherCategory = { ...current.categories[0], id: 'other-category', title: 'Other' };
  current.categories.push(otherCategory);
  const existingParent = createItem(current, { categoryId: otherCategory.id, title: 'Existing parent' }, at).item;
  const incoming = makeEmptyState(at);
  const incomingCategory = incoming.categories[0];
  createItem(incoming, { categoryId: incomingCategory.id, title: 'Imported child' }, at);
  const parsed = parsePTMD(exportPTMD(incoming, { scope: 'category', targetId: incomingCategory.id, exportedAt: at }).replace('"parentId":null', `"parentId":"${existingParent.id}"`));
  const preview = previewImport(current, parsed, { language: 'en', now: at });
  assert.equal(preview.ok, true);
  assert.equal(preview.isolated, true);
  assert.equal(preview.importedItems[0].parentId, null);
});

test('manually edited PTMD keeps visible hierarchy, status, and notes', () => {
  const text = ['---', 'progress_tracker_export: true', 'format_version: 1', 'exported_at: 2026-08-10T09:00:00.000Z', 'timezone: Asia/Taipei', '---', '', '# Manual', '- [ ] Root', '  - [x] Child', '    > Child note'].join('\n');
  const parsed = parsePTMD(text); const preview = previewImport(makeEmptyState(at), parsed, { language: 'en', now: at });
  assert.equal(preview.ok, true); assert.equal(preview.importedItems.length, 2);
  const root = preview.importedItems.find((item) => item.title === 'Root'); const child = preview.importedItems.find((item) => item.title === 'Child');
  assert.equal(child.parentId, root.id); assert.equal(child.status, 'completed'); assert.equal(child.notes, 'Child note');
});

test('full restore requires a full backup and produces a diff preview', () => {
  const current = makeEmptyState(at); const incoming = makeEmptyState(at); createItem(incoming, { categoryId: incoming.categories[0].id, title: 'Restored' }, at);
  const parsed = parsePTMD(exportPTMD(incoming, { scope: 'full', exportedAt: at })); const preview = restorePreview(current, parsed);
  assert.equal(preview.ok, true); assert.equal(preview.summary.incomingItems, 1); assert.equal(restorePreview(current, parsePTMD(exportPTMD(incoming, { scope: 'category', targetId: incoming.categories[0].id, exportedAt: at }))).ok, false);
});
