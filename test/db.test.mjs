import test from 'node:test';
import assert from 'node:assert/strict';
import { planStateChanges } from '../src/db.js';
import { makeEmptyState, makeItem } from '../src/schema.js';

const at = '2026-08-10T09:00:00.000Z';

function fixture(count) {
  const state = makeEmptyState(at);
  const categoryId = state.categories[0].id;
  state.items = Array.from({ length: count }, (_, index) => ({
    ...makeItem({ categoryId, title: `Item ${index}`, order: index, now: at }),
    id: `item_${index}`,
  }));
  return state;
}

test('single item edit produces one item put instead of a full-state rewrite', () => {
  const before = fixture(1000);
  const after = structuredClone(before);
  after.items[417].notes = 'Only this note changed';
  const plan = planStateChanges(before, after);
  assert.equal(plan.operationCount, 1);
  assert.deepEqual(Object.keys(plan.stores), ['items']);
  assert.equal(plan.stores.items.puts[0].key, 'item_417');
});

test('5000-item priority update keeps physical write amplification bounded', () => {
  const before = fixture(5000);
  const after = structuredClone(before);
  after.items[4321].priority = 'high';
  after.items[4321].revision += 1;
  const plan = planStateChanges(before, after);
  assert.equal(plan.putCount, 1);
  assert.equal(plan.deleteCount, 0);
  assert.equal(plan.operationCount, 1);
});

test('entity deletion uses a deterministic record-key delete', () => {
  const before = fixture(20);
  const after = structuredClone(before);
  after.items = after.items.filter((item) => item.id !== 'item_7');
  const plan = planStateChanges(before, after);
  assert.deepEqual(plan.stores.items.deletes, ['item_7']);
  assert.equal(plan.operationCount, 1);
});
