import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEmptyState } from '../src/schema.js';
import { initializeWithMigration, makeMigrationSnapshot, migrateState, restoreMigrationSnapshot } from '../src/migration.js';

const at = '2026-08-10T09:00:00.000Z';

test('migration creates a safety snapshot and upgrades the schema', () => {
  const input = makeEmptyState(at);
  input.meta.schemaVersion = 0;
  const result = migrateState(input, at);
  assert.equal(result.state.meta.schemaVersion, 1);
  assert.equal(result.snapshot.fromVersion, 0);
  assert.equal(result.snapshot.toVersion, 1);
  assert.doesNotThrow(() => restoreMigrationSnapshot(result.state, result.snapshot));
});

test('migration failure rolls back through the latest safety snapshot', async () => {
  const before = makeEmptyState(at);
  const snapshot = makeMigrationSnapshot(before, 0, 1, at);
  const invalid = structuredClone(before);
  invalid.items = [{ id: 'duplicate', categoryId: before.categories[0].id, parentId: null, title: 'A' }, { id: 'duplicate', categoryId: before.categories[0].id, parentId: null, title: 'B' }];
  invalid.migrationSnapshots = [snapshot];
  const persisted = [];
  const result = await initializeWithMigration({}, async () => invalid, at, async (_db, state) => { persisted.push(state); });
  assert.equal(result.recovery, false);
  assert.equal(result.rolledBack, true);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].items.length, 0);
});

test('migration rollback failure enters read-only recovery mode', async () => {
  const before = makeEmptyState(at);
  before.migrationSnapshots = [makeMigrationSnapshot(before, 0, 1, at)];
  const invalid = structuredClone(before);
  invalid.items = [{ id: 'duplicate', categoryId: before.categories[0].id, parentId: null, title: 'A' }, { id: 'duplicate', categoryId: before.categories[0].id, parentId: null, title: 'B' }];
  const result = await initializeWithMigration({}, async () => invalid, at, async () => { throw new Error('storage failure'); });
  assert.equal(result.recovery, true);
  assert.equal(result.state.meta.recoveryMode, true);
});
