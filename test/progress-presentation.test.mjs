import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEmptyState } from '../src/schema.js';
import { createItem, progressResultForItem, setItemStatus } from '../src/engine.js';
import { progressLabel, progressPresentation } from '../src/progress-presentation.js';

const at = '2026-08-10T09:00:00.000Z';

test('render presentation keeps incomplete near-complete progress below 100%', () => {
  assert.deepEqual(progressPresentation({ raw: 99.95, complete: false }), { numeric: 99.9, label: '99.9%' });
  assert.equal(progressLabel({ raw: 68, complete: false }), '68%');
  assert.equal(progressLabel({ raw: 68.4, complete: false }), '68.4%');
  assert.equal(progressLabel({ raw: 0, complete: true }), '100%');
});

test('presentation consumes the same progress result shape used by item/detail renderers', () => {
  const result = { raw: 99.95, complete: false };
  const row = progressPresentation(result);
  const detail = progressPresentation(result);
  const smart = progressPresentation(result);
  assert.equal(row.label, detail.label);
  assert.equal(detail.label, smart.label);
  assert.notEqual(row.label, '100%');
});

test('real 1999/2000 and 2000/2000 trees keep UI completion semantics', () => {
  const state = makeEmptyState(at);
  const parent = createItem(state, { categoryId: state.categories[0].id, parentId: null, title: '大量工作' }, at).item;
  for (let index = 0; index < 2000; index += 1) {
    const child = createItem(state, { categoryId: state.categories[0].id, parentId: parent.id, title: `子項目 ${index}` }, at).item;
    if (index < 1999) setItemStatus(state, child.id, 'completed', { force: true, at });
  }
  const incomplete = progressResultForItem(state, parent.id);
  assert.equal(incomplete.complete, false);
  assert.deepEqual(progressPresentation(incomplete), { numeric: 99.9, label: '99.9%' });
  setItemStatus(state, state.items[state.items.length - 1].id, 'completed', { force: true, at });
  const complete = progressResultForItem(state, parent.id, new Map(), new Set());
  assert.equal(complete.complete, true);
  assert.deepEqual(progressPresentation(complete), { numeric: 100, label: '100%' });
});
