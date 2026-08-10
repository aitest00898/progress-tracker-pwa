import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEmptyState, SCHEMA_VERSION } from '../src/schema.js';
import {
  initializeWithMigration,
  makeMigrationSnapshot,
  migrateState,
  purgeMigrationSnapshots,
  recoveryExportPayload,
  restoreMigrationSnapshot,
} from '../src/migration.js';

const at = '2026-08-10T09:00:00.000Z';

function duplicateState() {
  const state = makeEmptyState(at);
  state.items = [
    { id: 'duplicate', categoryId: state.categories[0].id, parentId: null, title: 'A' },
    { id: 'duplicate', categoryId: state.categories[0].id, parentId: null, title: 'B' },
  ];
  return state;
}

test('migration creates a safety snapshot and upgrades every schema step', () => {
  const input = makeEmptyState(at);
  input.meta.schemaVersion = 0;
  const result = migrateState(input, at);
  assert.equal(result.state.meta.schemaVersion, SCHEMA_VERSION);
  assert.equal(result.snapshot.fromVersion, 0);
  assert.equal(result.snapshot.toVersion, SCHEMA_VERSION);
  assert.equal(result.state.categories[0].revision, 0);
  assert.doesNotThrow(() => restoreMigrationSnapshot(result.state, result.snapshot));
});

test('pre-migration snapshot is durably persisted before the upgraded state', async () => {
  const input = makeEmptyState(at);
  input.meta.schemaVersion = 1;
  const events = [];
  const result = await initializeWithMigration(
    {},
    async () => input,
    at,
    async (_db, state) => { events.push({ type: 'state', state }); },
    async (_db, snapshot) => { events.push({ type: 'snapshot', snapshot }); },
  );
  assert.equal(result.migrated, true);
  assert.equal(result.state.meta.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(events.map((event) => event.type), ['snapshot', 'state']);
  assert.equal(events[0].snapshot.state.meta.schemaVersion, 1);
  assert.ok(events[1].state.migrationSnapshots.some((snapshot) => snapshot.id === events[0].snapshot.id));
});

test('migration failure rolls back through the latest valid safety snapshot', async () => {
  const valid = makeEmptyState(at);
  const snapshot = makeMigrationSnapshot(valid, SCHEMA_VERSION, SCHEMA_VERSION, at);
  const invalid = duplicateState();
  invalid.migrationSnapshots = [snapshot];
  const persisted = [];
  const result = await initializeWithMigration({}, async () => invalid, at, async (_db, state) => { persisted.push(state); });
  assert.equal(result.recovery, false);
  assert.equal(result.rolledBack, true);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].items.length, 0);
});

test('migration and rollback double failure preserves actual pre-migration bytes in read-only recovery export', async () => {
  const valid = makeEmptyState(at);
  const invalid = duplicateState();
  invalid.migrationSnapshots = [makeMigrationSnapshot(valid, SCHEMA_VERSION, SCHEMA_VERSION, at)];
  const result = await initializeWithMigration({}, async () => invalid, at, async () => { throw new Error('storage failure'); });
  assert.equal(result.recovery, true);
  assert.equal(result.state.meta.recoveryMode, true);
  assert.equal(result.state.items.length, 2);
  assert.deepEqual(result.state.items.map((item) => item.title), ['A', 'B']);
  assert.equal(result.state.meta.recoveryContext.rollbackError.message, 'storage failure');
  const exported = recoveryExportPayload(result.state, at);
  assert.equal(exported.progressTrackerRecoveryExport, true);
  assert.deepEqual(exported.state.items.map((item) => item.title), ['A', 'B']);
});

test('migration and recovery snapshots expire after 30 days during maintenance', () => {
  const state = makeEmptyState(at);
  const expired = makeMigrationSnapshot(state, 1, 2, '2026-06-01T00:00:00.000Z');
  const active = makeMigrationSnapshot(state, 1, 2, '2026-08-01T00:00:00.000Z', 'recovery');
  state.migrationSnapshots = [expired];
  state.recoverySnapshots = [active];
  const result = purgeMigrationSnapshots(state, new Date('2026-08-10T09:00:00.000Z'));
  assert.equal(result.changed, true);
  assert.equal(result.purged, 1);
  assert.deepEqual(state.migrationSnapshots, []);
  assert.equal(state.recoverySnapshots[0].id, active.id);
});
