import test from 'node:test';
import assert from 'node:assert/strict';
import { loadState, planStateChanges, saveStateChanges, STORE_NAMES } from '../src/db.js';
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

function memoryDatabase() {
  const stores = Object.fromEntries(STORE_NAMES.map((name) => [name, new Map()]));
  return {
    stores,
    transaction(names) {
      const tx = {
        objectStore(name) {
          const store = stores[name];
          return {
            getAll: () => ({ result: [...store.values()].map((value) => structuredClone(value)) }),
            clear: () => store.clear(),
            put: (record) => store.set(record.key, structuredClone(record)),
            delete: (key) => store.delete(key),
          };
        },
      };
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    },
  };
}

test('a brand-new database is fully seeded before incremental writes and survives reload', async () => {
  const db = memoryDatabase();
  const initial = await loadState(db);
  assert.equal(db.stores.meta.size, 1);
  assert.equal(db.stores.categories.size, 1);
  assert.equal(db.stores.settings.size, 1);
  const datasetId = initial.meta.datasetId;
  const categoryId = initial.categories[0].id;
  const next = structuredClone(initial);
  next.items.push({ ...makeItem({ categoryId, title: 'Persisted item', now: at }), id: 'persisted_item' });
  await saveStateChanges(db, initial, next);
  const reloaded = await loadState(db);
  assert.equal(reloaded.meta.datasetId, datasetId);
  assert.equal(reloaded.categories[0].id, categoryId);
  assert.equal(reloaded.items[0].title, 'Persisted item');
});

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
