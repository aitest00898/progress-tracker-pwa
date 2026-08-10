import test from 'node:test';
import assert from 'node:assert/strict';
import { createItem } from '../src/engine.js';
import { makeEmptyState } from '../src/schema.js';
import { browserStorageEstimate, storageBreakdown } from '../src/storage-metrics.js';

const at = '2026-08-10T09:00:00.000Z';

test('notes are measured separately and never double-counted as basic item data', () => {
  const state = makeEmptyState(at);
  const item = createItem(state, { categoryId: state.categories[0].id, title: 'Private title' }, at).item;
  const before = storageBreakdown(state);
  const categoryBytes = before.breakdown.categories;
  state.items.find((candidate) => candidate.id === item.id).notes = 'A long private note that belongs only in the notes bucket.';
  const after = storageBreakdown(state);
  assert.equal(after.breakdown.items, before.breakdown.items);
  assert.equal(after.breakdown.categories, categoryBytes);
  assert.ok(after.breakdown.metadata > 0);
  assert.ok(after.breakdown.categories > 0);
  assert.ok(after.breakdown.notes > before.breakdown.notes);
  assert.equal(after.total, Object.values(after.breakdown).reduce((sum, value) => sum + value, 0));
  assert.equal(after.method, 'logical-json-estimate');
});

test('browser quota is exposed only when the browser supplies reliable numeric estimates', () => {
  assert.deepEqual(browserStorageEstimate({ usage: 250, quota: 1000 }), {
    usage: 250,
    quota: 1000,
    available: 750,
    estimated: true,
  });
  assert.equal(browserStorageEstimate({ usage: 250 }), null);
  assert.equal(browserStorageEstimate({ usage: -1, quota: 1000 }), null);
  assert.equal(browserStorageEstimate({ usage: 100, quota: 0 }), null);
});
