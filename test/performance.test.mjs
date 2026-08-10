import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEmptyState } from '../src/schema.js';
import { createItem, progressForItem, searchItems, smartViewItems } from '../src/engine.js';
import { recordPerformance } from '../src/diagnostics.js';
import { virtualRange } from '../src/virtual-list.js';
import { runBenchmark } from '../scripts/benchmark.mjs';

test('2000+ items and 10+ hierarchy levels are measurable through performance diagnostics', () => {
  const state = makeEmptyState('2026-08-10T09:00:00.000Z'); state.settings.developerEnabled = true;
  let cursor = null;
  for (let index = 0; index < 12; index += 1) cursor = createItem(state, { categoryId: state.categories[0].id, parentId: cursor?.id ?? null, title: `Deep ${index}` }, '2026-08-10T09:00:00.000Z').item;
  for (let index = 0; index < 2000; index += 1) createItem(state, { categoryId: state.categories[0].id, title: `Item ${index}` }, '2026-08-10T09:00:00.000Z');
  const measure = (metric, action) => { const start = performance.now(); const value = action(); recordPerformance(state, metric, performance.now() - start, { itemCount: state.items.length }); return value; };
  measure('progress_recompute', () => progressForItem(state, cursor.id)); measure('search', () => searchItems(state, 'Item 19')); measure('smart_view', () => smartViewItems(state, 'recentlyActive', new Date('2026-08-10T09:00:00.000Z')));
  assert.ok(state.items.length >= 2012); assert.ok(state.performance.some((entry) => entry.metric === 'progress_recompute')); assert.ok(state.performance.some((entry) => entry.metric === 'search')); assert.ok(state.performance.some((entry) => entry.metric === 'smart_view'));
});

test('virtual list bounds DOM work to the visible window plus overscan', () => {
  assert.deepEqual(virtualRange({ itemCount: 2500, scrollTop: 0, viewportHeight: 696, rowHeight: 116, overscan: 10 }), { first: 0, last: 26 });
  const middle = virtualRange({ itemCount: 2500, scrollTop: 116000, viewportHeight: 696, rowHeight: 116, overscan: 10 });
  assert.equal(middle.first, 990);
  assert.equal(middle.last - middle.first, 26);
  assert.deepEqual(virtualRange({ itemCount: 12, scrollTop: 10000, viewportHeight: 696, rowHeight: 116, overscan: 10 }), { first: 12, last: 12 });
});

test('2500-item hot paths stay inside regression budgets', () => {
  const report = runBenchmark({ itemCount: 2500, samples: 2 });
  const budgets = {
    descendants: 40,
    progress: 40,
    search: 60,
    today: 60,
    smartReadyToClose: 75,
    smartStale: 75,
    smartRoutine: 75,
    smartRecentlyActive: 75,
  };
  for (const [name, budgetMs] of Object.entries(budgets)) assert.ok(report.measurements[name].p95Ms < budgetMs, `${name} p95 ${report.measurements[name].p95Ms}ms exceeded ${budgetMs}ms`);
});
