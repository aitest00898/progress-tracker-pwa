import { clone, dateKey, isoNow, normalizeState, SCHEMA_VERSION, validateState } from './schema.js';
import { saveState } from './db.js';

export class RecoveryModeError extends Error {
  constructor(message, cause) { super(message); this.name = 'RecoveryModeError'; this.cause = cause; }
}

export function makeMigrationSnapshot(state, fromVersion, toVersion = SCHEMA_VERSION, at = isoNow()) {
  return {
    id: `migration_${at.replace(/[^0-9]/g, '')}`,
    fromVersion, toVersion, createdAt: at,
    purgeAfter: new Date(new Date(at).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    state: clone(state),
  };
}

export function migrateState(input, at = isoNow()) {
  const current = normalizeState(input, at);
  const fromVersion = Number(input?.meta?.schemaVersion ?? 0);
  if (fromVersion > SCHEMA_VERSION) throw new RecoveryModeError('Newer database schema is not supported');
  const snapshot = fromVersion < SCHEMA_VERSION ? makeMigrationSnapshot(current, fromVersion, SCHEMA_VERSION, at) : null;
  current.meta.schemaVersion = SCHEMA_VERSION;
  current.meta.updatedAt = at;
  const errors = validateState(current);
  if (errors.length) throw new RecoveryModeError('Migration validation failed', errors);
  return { state: current, snapshot };
}

export async function initializeWithMigration(db, loadState, at = isoNow(), persist = saveState) {
  let before = null;
  try {
    before = await loadState(db);
    const result = migrateState(before, at);
    if (result.snapshot) {
      result.state.migrationSnapshots = [...(result.state.migrationSnapshots ?? []), result.snapshot];
      await persist(db, result.state);
    }
    return { state: result.state, migrated: Boolean(result.snapshot), snapshot: result.snapshot, recovery: false };
  } catch (error) {
    const rollbackCandidate = [...(before?.migrationSnapshots ?? []), ...(before?.recoverySnapshots ?? [])]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    if (rollbackCandidate?.state) {
      try {
        const restored = restoreMigrationSnapshot(before, rollbackCandidate);
        restored.migrationSnapshots = before.migrationSnapshots ?? [];
        restored.recoverySnapshots = before.recoverySnapshots ?? [];
        await persist(db, restored);
        return { state: restored, migrated: false, snapshot: null, recovery: false, rolledBack: true, error };
      } catch (rollbackError) {
        error = new RecoveryModeError('Migration rollback failed', { migration: error, rollback: rollbackError });
      }
    }
    const safe = normalizeState({ ...clone(makeRecoveryShell(at)), meta: { ...makeRecoveryShell(at).meta, recoveryMode: true } }, at);
    return { state: safe, migrated: false, snapshot: null, recovery: true, error };
  }
}

function makeRecoveryShell(at) {
  const now = new Date(at).toISOString();
  return { meta: { schemaVersion: SCHEMA_VERSION, appVersion: '1.0.0', datasetId: 'recovery', revision: 0, baseRevision: 0, clientId: 'recovery', createdAt: now, updatedAt: now, lastRolloverDate: dateKey(at), recoveryMode: true }, categories: [], items: [], history: [], reminders: [], today: { lastRolloverDate: dateKey(at), items: {} }, settings: { language: 'zh-TW', theme: 'system', experimental: { enabled: false } }, smartOrders: {}, syncChanges: [], conflicts: [], conflictArchive: [], deleted: [], backupMeta: [], migrationSnapshots: [], recoverySnapshots: [], diagnostics: { events: [], errors: [], aggregates: {} }, performance: [], capabilities: {} };
}

export function restoreMigrationSnapshot(currentState, snapshot) {
  if (!snapshot?.state) throw new RecoveryModeError('Invalid migration snapshot');
  const restored = normalizeState(snapshot.state);
  const errors = validateState(restored);
  if (errors.length) throw new RecoveryModeError('Snapshot validation failed', errors);
  return restored;
}

export function purgeMigrationSnapshots(state, now = new Date()) {
  state.migrationSnapshots = (state.migrationSnapshots ?? []).filter((snapshot) => new Date(snapshot.purgeAfter).getTime() > now.getTime());
}
