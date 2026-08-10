import { clone, isoNow, normalizeState, SCHEMA_VERSION, validateState } from './schema.js';
import { saveMigrationSnapshot, saveState } from './db.js';

const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class RecoveryModeError extends Error {
  constructor(message, cause) { super(message); this.name = 'RecoveryModeError'; this.cause = cause; }
}

function errorSummary(error) {
  if (!error) return null;
  return {
    name: String(error.name ?? 'Error'),
    message: String(error.message ?? error),
  };
}

export function makeMigrationSnapshot(state, fromVersion, toVersion = SCHEMA_VERSION, at = isoNow(), kind = 'migration') {
  return {
    id: `${kind}_${at.replace(/[^0-9]/g, '')}_${Math.random().toString(36).slice(2, 8)}`,
    kind,
    fromVersion,
    toVersion,
    createdAt: at,
    purgeAfter: new Date(new Date(at).getTime() + SNAPSHOT_RETENTION_MS).toISOString(),
    state: clone(state),
  };
}

function upgradeToVersion2(state) {
  state.categories = state.categories.map((category) => ({
    ...category,
    revision: Number(category.revision ?? 0),
    baseRevision: Number(category.baseRevision ?? 0),
    fieldRevisions: { ...(category.fieldRevisions ?? {}) },
  }));
  state.reminders = state.reminders.map((reminder) => ({
    ...reminder,
    revision: Number(reminder.revision ?? 0),
    baseRevision: Number(reminder.baseRevision ?? 0),
    fieldRevisions: { ...(reminder.fieldRevisions ?? {}) },
  }));
  state.today.items = Object.fromEntries(Object.entries(state.today.items ?? {}).map(([itemId, membership]) => [itemId, {
    ...membership,
    itemId,
    revision: Number(membership?.revision ?? 0),
    baseRevision: Number(membership?.baseRevision ?? 0),
    fieldRevisions: { ...(membership?.fieldRevisions ?? {}) },
  }]));
  state.settings.cloudSync = {
    ...state.settings.cloudSync,
    selectedDatasetId: state.settings.cloudSync?.selectedDatasetId ?? null,
    datasetFiles: { ...(state.settings.cloudSync?.datasetFiles ?? {}) },
    availableDatasets: Array.isArray(state.settings.cloudSync?.availableDatasets) ? state.settings.cloudSync.availableDatasets : [],
  };
}

export function migrateState(input, at = isoNow()) {
  const source = clone(input);
  const fromVersion = Number(source?.meta?.schemaVersion ?? 0);
  if (fromVersion > SCHEMA_VERSION) throw new RecoveryModeError('Newer database schema is not supported');
  const snapshot = fromVersion < SCHEMA_VERSION ? makeMigrationSnapshot(source, fromVersion, SCHEMA_VERSION, at) : null;
  const current = normalizeState(source, at);
  let version = fromVersion;
  while (version < SCHEMA_VERSION) {
    if (version === 0) version = 1;
    else if (version === 1) {
      upgradeToVersion2(current);
      version = 2;
    } else {
      throw new RecoveryModeError(`No migration path from schema ${version}`);
    }
  }
  current.meta.schemaVersion = SCHEMA_VERSION;
  current.meta.updatedAt = at;
  const errors = validateState(current);
  if (errors.length) throw new RecoveryModeError('Migration validation failed', errors);
  return { state: current, snapshot };
}

function latestSnapshot(state, additional = null) {
  return [additional, ...(state?.migrationSnapshots ?? []), ...(state?.recoverySnapshots ?? [])]
    .filter((snapshot) => snapshot?.state)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0] ?? null;
}

function recoveryState(sourceInput, migrationError, rollbackError, at) {
  const source = clone(sourceInput);
  const preservedSnapshot = makeMigrationSnapshot(
    source,
    Number(source?.meta?.schemaVersion ?? 0),
    SCHEMA_VERSION,
    at,
    'recovery',
  );
  const safe = normalizeState(source, at);
  safe.meta.recoveryMode = true;
  safe.meta.recoveryContext = {
    enteredAt: at,
    sourceSchemaVersion: Number(source?.meta?.schemaVersion ?? 0),
    targetSchemaVersion: SCHEMA_VERSION,
    migrationError: errorSummary(migrationError),
    rollbackError: errorSummary(rollbackError),
    preservedSnapshot,
  };
  safe.recoverySnapshots = [...(safe.recoverySnapshots ?? []).filter((snapshot) => snapshot.id !== preservedSnapshot.id), preservedSnapshot];
  return safe;
}

async function persistSnapshotBeforeMigration(db, before, snapshot, persist, persistSnapshot) {
  if (persistSnapshot) {
    await persistSnapshot(db, snapshot);
    return;
  }
  if (db?.transaction) {
    await saveMigrationSnapshot(db, snapshot);
    return;
  }
  const staged = clone(before);
  staged.migrationSnapshots = [...(staged.migrationSnapshots ?? []).filter((entry) => entry.id !== snapshot.id), snapshot];
  await persist(db, staged);
}

export async function initializeWithMigration(
  db,
  load,
  at = isoNow(),
  persist = saveState,
  persistSnapshot = null,
) {
  let before = null;
  let preMigrationSnapshot = null;
  let migrationError = null;
  try {
    before = await load(db);
    const fromVersion = Number(before?.meta?.schemaVersion ?? 0);
    if (fromVersion < SCHEMA_VERSION) {
      preMigrationSnapshot = makeMigrationSnapshot(before, fromVersion, SCHEMA_VERSION, at);
      await persistSnapshotBeforeMigration(db, before, preMigrationSnapshot, persist, persistSnapshot);
    }
    const result = migrateState(before, at);
    if (preMigrationSnapshot) {
      result.state.migrationSnapshots = [
        ...(result.state.migrationSnapshots ?? []).filter((snapshot) => snapshot.id !== preMigrationSnapshot.id),
        preMigrationSnapshot,
      ];
      await persist(db, result.state);
    }
    return { state: result.state, migrated: Boolean(preMigrationSnapshot), snapshot: preMigrationSnapshot, recovery: false };
  } catch (error) {
    migrationError = error;
  }

  const rollbackCandidate = latestSnapshot(before, preMigrationSnapshot);
  if (rollbackCandidate?.state) {
    try {
      const restored = restoreMigrationSnapshot(before, rollbackCandidate);
      restored.migrationSnapshots = [...(before?.migrationSnapshots ?? []), ...(preMigrationSnapshot ? [preMigrationSnapshot] : [])]
        .filter((snapshot, index, values) => values.findIndex((candidate) => candidate.id === snapshot.id) === index);
      restored.recoverySnapshots = before?.recoverySnapshots ?? [];
      await persist(db, restored);
      return { state: restored, migrated: false, snapshot: rollbackCandidate, recovery: false, rolledBack: true, error: migrationError };
    } catch (rollbackError) {
      const source = before ?? rollbackCandidate.state;
      const state = recoveryState(source, migrationError, rollbackError, at);
      return {
        state,
        migrated: false,
        snapshot: rollbackCandidate,
        recovery: true,
        error: new RecoveryModeError('Migration rollback failed', {
          migration: errorSummary(migrationError),
          rollback: errorSummary(rollbackError),
        }),
      };
    }
  }

  const state = recoveryState(before ?? normalizeState(undefined, at), migrationError, null, at);
  return { state, migrated: false, snapshot: null, recovery: true, error: migrationError };
}

export function restoreMigrationSnapshot(_currentState, snapshot) {
  if (!snapshot?.state) throw new RecoveryModeError('Invalid migration snapshot');
  const restored = normalizeState(snapshot.state);
  const errors = validateState(restored);
  if (errors.length) throw new RecoveryModeError('Snapshot validation failed', errors);
  return restored;
}

export function purgeMigrationSnapshots(state, now = new Date()) {
  const before = (state.migrationSnapshots?.length ?? 0) + (state.recoverySnapshots?.length ?? 0);
  const keep = (snapshot) => !snapshot.purgeAfter || new Date(snapshot.purgeAfter).getTime() > now.getTime();
  state.migrationSnapshots = (state.migrationSnapshots ?? []).filter(keep);
  state.recoverySnapshots = (state.recoverySnapshots ?? []).filter(keep);
  const after = state.migrationSnapshots.length + state.recoverySnapshots.length;
  return { changed: before !== after, purged: before - after };
}

export function recoveryExportPayload(state, at = isoNow()) {
  const preserved = state.meta?.recoveryContext?.preservedSnapshot?.state ?? state;
  return {
    progressTrackerRecoveryExport: true,
    formatVersion: 1,
    exportedAt: at,
    recoveryContext: clone(state.meta?.recoveryContext ?? null),
    state: clone(preserved),
  };
}

export async function retryRecovery(db, recoveryInput, at = isoNow(), persist = saveState) {
  const source = recoveryInput?.meta?.recoveryContext?.preservedSnapshot?.state ?? recoveryInput;
  try {
    const result = migrateState(source, at);
    const state = result.state;
    state.meta.recoveryMode = false;
    state.meta.recoveryContext = null;
    state.recoverySnapshots = [...(recoveryInput.recoverySnapshots ?? [])];
    if (result.snapshot) state.migrationSnapshots = [...(state.migrationSnapshots ?? []), result.snapshot];
    await persist(db, state);
    return { ok: true, state, snapshot: result.snapshot };
  } catch (error) {
    return { ok: false, state: recoveryState(source, error, null, at), error };
  }
}
