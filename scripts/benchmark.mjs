import { pathToFileURL } from 'node:url';
import {
  descendantsOf,
  derivedTodayItems,
  progressForItem,
  searchItems,
  smartViewItems,
} from '../src/engine.js';
import { DAY_MS, makeCategory, makeEmptyState, makeItem } from '../src/schema.js';

export const REFERENCE_TIME = new Date('2026-08-10T09:00:00.000Z');
const DEFAULT_ITEM_COUNT = 2500;
const DEFAULT_SAMPLES = 5;

function numericArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function buildFixture(itemCount) {
  const now = REFERENCE_TIME.toISOString();
  const state = makeEmptyState(now);
  const categoryCount = 5;
  state.categories = Array.from({ length: categoryCount }, (_, index) => ({
    ...makeCategory(`Category ${index}`, index, now),
    id: `category_${index}`,
  }));
  state.settings.defaultCategoryId = state.categories[0].id;
  const byCategory = Array.from({ length: categoryCount }, () => []);

  for (let index = 0; index < itemCount; index += 1) {
    const categoryIndex = index % categoryCount;
    const localIndex = byCategory[categoryIndex].length;
    const parentIndex = localIndex === 0 ? -1 : Math.floor((localIndex - 1) / 5);
    const parentId = parentIndex < 0 ? null : byCategory[categoryIndex][parentIndex].id;
    const createdAt = new Date(REFERENCE_TIME.getTime() - (index % 90) * DAY_MS).toISOString();
    const item = {
      ...makeItem({ categoryId: `category_${categoryIndex}`, parentId, title: `Item ${index} performance target`, order: localIndex, now: createdAt }),
      id: `item_${index}`,
      notes: index % 11 === 0 ? `Benchmark notes for item ${index} with searchable content` : '',
      tags: [`group-${index % 17}`, index % 13 === 0 ? 'benchmark' : 'normal'],
      importance: index % 4,
      priority: ['none', 'low', 'medium', 'high'][index % 4],
      status: index > categoryCount && index % 29 === 0 ? 'skipped' : index > categoryCount && index % 7 === 0 ? 'completed' : 'active',
      completedAt: index > categoryCount && index % 7 === 0 ? new Date(REFERENCE_TIME.getTime() - (index % 12) * DAY_MS).toISOString() : null,
      plannedStart: index % 97 === 0 ? new Date(REFERENCE_TIME.getTime() - DAY_MS).toISOString() : null,
      dueMode: localIndex === 0 || index % 137 === 0 ? 'explicit' : index % 113 === 0 ? 'none' : 'inherit',
      dueDate: localIndex === 0 || index % 137 === 0 ? new Date(REFERENCE_TIME.getTime() + ((index % 9) - 4) * DAY_MS).toISOString() : null,
    };
    state.items.push(item);
    byCategory[categoryIndex].push(item);

    const eventTypes = ['created', 'edited', index % 7 === 0 ? 'completed' : 'note_edited', 'due_changed'];
    eventTypes.forEach((type, eventIndex) => state.history.push({
      id: `history_${index}_${eventIndex}`,
      itemId: item.id,
      type,
      metadata: {},
      at: new Date(REFERENCE_TIME.getTime() - ((index + eventIndex * 3) % 40) * DAY_MS).toISOString(),
    }));
    if (index % 50 === 0) {
      for (let repeat = 1; repeat <= 3; repeat += 1) state.history.push({ id: `routine_${index}_${repeat}`, itemId: item.id, type: 'completed', metadata: {}, at: new Date(REFERENCE_TIME.getTime() - repeat * 7 * DAY_MS).toISOString() });
    }
    if (index % 101 === 0) state.today.items[item.id] = { itemId: item.id, order: index, addedAt: now, source: 'manual', completedAt: null };
  }

  return { state, roots: byCategory.map((items) => items[0]) };
}

function resultDigest(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.values(value).reduce((sum, entry) => sum + (Array.isArray(entry) ? entry.length : 0), 0);
  return Number(value) || 0;
}

function percentile(values, ratio) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))];
}

export function measure(action, samples) {
  action();
  const durations = [];
  let digest = 0;
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    digest = resultDigest(action());
    durations.push(performance.now() - startedAt);
  }
  return {
    medianMs: Number(percentile(durations, 0.5).toFixed(3)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(3)),
    minMs: Number(Math.min(...durations).toFixed(3)),
    maxMs: Number(Math.max(...durations).toFixed(3)),
    digest,
  };
}

function maxDepth(state) {
  const byId = new Map(state.items.map((item) => [item.id, item]));
  const memo = new Map();
  const depthOf = (item, trail = new Set()) => {
    if (memo.has(item.id)) return memo.get(item.id);
    if (!item.parentId || trail.has(item.id)) return 0;
    const parent = byId.get(item.parentId);
    if (!parent) return 0;
    const depth = 1 + depthOf(parent, new Set(trail).add(item.id));
    memo.set(item.id, depth);
    return depth;
  };
  return state.items.reduce((depth, item) => Math.max(depth, depthOf(item)), 0);
}

export function runBenchmark({ itemCount = DEFAULT_ITEM_COUNT, samples = DEFAULT_SAMPLES } = {}) {
  const { state, roots } = buildFixture(itemCount);
  const operations = {
    descendants: () => descendantsOf(state, roots[0].id),
    progress: () => progressForItem(state, roots[0].id),
    search: () => searchItems(state, 'performance target benchmark'),
    today: () => derivedTodayItems(state, REFERENCE_TIME),
    smartReadyToClose: () => smartViewItems(state, 'readyToClose', REFERENCE_TIME),
    smartStale: () => smartViewItems(state, 'stale', REFERENCE_TIME),
    smartRoutine: () => smartViewItems(state, 'routine', REFERENCE_TIME),
    smartRecentlyActive: () => smartViewItems(state, 'recentlyActive', REFERENCE_TIME),
  };
  const measurements = Object.fromEntries(Object.entries(operations).map(([name, action]) => [name, measure(action, samples)]));
  return {
    benchmarkVersion: 1,
    runtime: process.version,
    fixture: { items: state.items.length, history: state.history.length, categories: state.categories.length, maxDepth: maxDepth(state) },
    samples,
    measurements,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = runBenchmark({ itemCount: numericArgument('--items', DEFAULT_ITEM_COUNT), samples: numericArgument('--samples', DEFAULT_SAMPLES) });
  console.log(JSON.stringify(report, null, 2));
}
