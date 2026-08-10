import { clone, isoNow, makeEmptyState, normalizeState, validateState } from './schema.js';
import { loadState, openDatabase, saveState, saveStateChanges, StorageError } from './db.js';
import { initializeWithMigration, makeMigrationSnapshot, purgeMigrationSnapshots, recoveryExportPayload, retryRecovery } from './migration.js';
import { enqueueLocalChange } from './sync.js';
import { applyDailyRollover, purgeDeleted } from './engine.js';

function changedItemIds(before, after) {
  const previous = new Map((before?.items ?? []).map((item) => [item.id, JSON.stringify(item)]));
  const current = new Map((after?.items ?? []).map((item) => [item.id, JSON.stringify(item)]));
  const ids = new Set([...previous.keys(), ...current.keys()]);
  return [...ids].filter((id) => previous.get(id) !== current.get(id));
}

function changedIds(beforeValues, afterValues) {
  const before = new Map((beforeValues ?? []).map((value) => [value.id, JSON.stringify(value)]));
  const after = new Map((afterValues ?? []).map((value) => [value.id, JSON.stringify(value)]));
  return [...new Set([...before.keys(), ...after.keys()])].filter((id) => before.get(id) !== after.get(id));
}

function changedEntityKeys(before, after) {
  const keys = [];
  for (const [stateKey, entityType] of [
    ['categories', 'category'],
    ['items', 'item'],
    ['reminders', 'reminder'],
    ['deleted', 'deleted'],
    ['history', 'history'],
    ['backupMeta', 'backup'],
    ['conflictArchive', 'conflict_archive'],
  ]) {
    keys.push(...changedIds(before?.[stateKey], after?.[stateKey]).map((id) => `${entityType}:${id}`));
  }
  const todayIds = new Set([...Object.keys(before?.today?.items ?? {}), ...Object.keys(after?.today?.items ?? {})]);
  for (const id of todayIds) {
    if (JSON.stringify(before?.today?.items?.[id]) !== JSON.stringify(after?.today?.items?.[id])) keys.push(`today:${id}`);
  }
  if (JSON.stringify(before?.settings) !== JSON.stringify(after?.settings)) keys.push('settings:root');
  if (JSON.stringify(before?.smartOrders) !== JSON.stringify(after?.smartOrders)) keys.push('smart_order:root');
  return [...new Set(keys)];
}

export class ProgressRepository {
  constructor() {
    this.db = null;
    this.state = null;
    this.listeners = new Set();
    this.volatile = false;
    this.lastError = null;
    this.lastWritePlan = null;
    this.previousSessionAbnormal = false;
  }

  async initialize() {
    try {
      this.db = await openDatabase();
      const result = await initializeWithMigration(this.db, loadState);
      this.state = result.state;
      if (!result.recovery) {
        const beforeMaintenance = clone(this.state);
        const rollover = applyDailyRollover(this.state);
        const deletedPurged = purgeDeleted(this.state);
        const archiveBefore = this.state.conflictArchive.length;
        this.state.conflictArchive = this.state.conflictArchive.filter((entry) => !entry.purgeAfter || new Date(entry.purgeAfter).getTime() > Date.now());
        const snapshots = purgeMigrationSnapshots(this.state);
        if (rollover.changed || deletedPurged || archiveBefore !== this.state.conflictArchive.length || snapshots.changed) {
          this.lastWritePlan = await saveStateChanges(this.db, beforeMaintenance, this.state);
        }
      } else {
        this.lastError = result.error;
      }
    } catch (error) {
      this.volatile = true;
      this.lastError = error;
      this.state = makeEmptyState();
    }
    this.previousSessionAbnormal = Boolean(this.state.meta.lastSession && this.state.meta.lastSession.normal === false && this.state.meta.lastSession.startedAt);
    const beforeSessionMarker = clone(this.state);
    this.state.meta.lastSession = { startedAt: isoNow(), endedAt: null, normal: false };
    if (!this.volatile && !this.state.meta.recoveryMode) {
      try { this.lastWritePlan = await saveStateChanges(this.db, beforeSessionMarker, this.state); } catch (error) { this.lastError = error; this.volatile = true; }
    }
    return { state: this.state, volatile: this.volatile, error: this.lastError };
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  notify(meta = {}) { for (const listener of this.listeners) listener(this.state, meta); }

  async commit(nextState, { label = 'local_change', queue = true } = {}) {
    if (this.state?.meta?.recoveryMode) return { ok: false, reason: 'recovery' };
    const candidate = normalizeState(nextState);
    const errors = validateState(candidate);
    if (errors.length) return { ok: false, reason: 'validation', errors };
    candidate.meta.revision = Math.max(Number(candidate.meta.revision ?? 0), Number(this.state?.meta?.revision ?? 0)) + 1;
    candidate.meta.updatedAt = isoNow();
    if (queue) enqueueLocalChange(candidate, label, changedItemIds(this.state, candidate), changedEntityKeys(this.state, candidate));
    if (!this.volatile) {
      try { this.lastWritePlan = await saveStateChanges(this.db, this.state, candidate); } catch (error) { this.lastError = error; return { ok: false, reason: 'storage', error }; }
    }
    this.state = candidate;
    this.notify({ label });
    return { ok: true, state: this.state };
  }

  async update(label, mutator, options = {}, legacyOptions = null) {
    options = legacyOptions ?? options ?? {};
    const before = clone(this.state);
    const draft = clone(this.state);
    let result;
    try { result = await mutator(draft, before); } catch (error) { this.lastError = error; return { ok: false, reason: 'exception', error }; }
    if (result?.ok === false) return result;
    const commitResult = await this.commit(draft, { label, ...options });
    return commitResult.ok ? { ...commitResult, result } : commitResult;
  }

  async markNormalShutdown() {
    if (!this.state || this.state.meta.recoveryMode) return;
    const draft = clone(this.state);
    draft.meta.lastSession = { ...(draft.meta.lastSession ?? {}), endedAt: isoNow(), normal: true };
    if (!this.volatile) { try { this.lastWritePlan = await saveStateChanges(this.db, this.state, draft); } catch { return; } }
    this.state = draft;
  }

  async createSafetySnapshot(kind = 'manual_restore', at = isoNow()) {
    if (!this.state || this.state.meta?.recoveryMode) return { ok: false, reason: 'recovery' };
    const snapshot = makeMigrationSnapshot(this.state, this.state.meta.schemaVersion, this.state.meta.schemaVersion, at, kind);
    const draft = clone(this.state);
    draft.recoverySnapshots = [...(draft.recoverySnapshots ?? []), snapshot];
    if (!this.volatile) {
      try { this.lastWritePlan = await saveStateChanges(this.db, this.state, draft); }
      catch (error) { this.lastError = error; return { ok: false, reason: 'storage', error }; }
    }
    this.state = draft;
    this.notify({ label: `${kind}_safety_snapshot` });
    return { ok: true, snapshot, state: draft };
  }

  async replaceState(nextState, label = 'replace') {
    if (this.state?.meta?.recoveryMode && label !== 'recovery_retry') return { ok: false, reason: 'recovery' };
    const candidate = normalizeState(nextState);
    const errors = validateState(candidate);
    if (errors.length) return { ok: false, reason: 'validation', errors };
    candidate.meta.revision = Math.max(Number(candidate.meta.revision ?? 0), Number(this.state?.meta?.revision ?? 0)) + 1;
    candidate.meta.updatedAt = isoNow();
    const previous = clone(this.state);
    if (!this.volatile) {
      try {
        await saveState(this.db, candidate);
        const persisted = await loadState(this.db);
        const persistedErrors = validateState(persisted);
        if (persistedErrors.length || JSON.stringify(persisted) !== JSON.stringify(candidate)) {
          throw new StorageError('IndexedDB replacement verification failed', persistedErrors);
        }
      } catch (error) {
        this.lastError = error;
        try {
          await saveState(this.db, previous);
          const rolledBack = await loadState(this.db);
          if (validateState(rolledBack).length || JSON.stringify(rolledBack) !== JSON.stringify(previous)) throw new StorageError('Restore rollback verification failed');
          this.state = previous;
          return { ok: false, reason: 'storage', error, rolledBack: true };
        } catch (rollbackError) {
          const preservedSnapshot = makeMigrationSnapshot(previous, previous.meta.schemaVersion, previous.meta.schemaVersion, isoNow(), 'restore_failure');
          previous.meta.recoveryMode = true;
          previous.meta.recoveryContext = {
            enteredAt: isoNow(),
            migrationError: { name: error.name ?? 'Error', message: error.message ?? String(error) },
            rollbackError: { name: rollbackError.name ?? 'Error', message: rollbackError.message ?? String(rollbackError) },
            preservedSnapshot,
          };
          previous.recoverySnapshots = [...(previous.recoverySnapshots ?? []), preservedSnapshot];
          this.state = previous;
          this.volatile = true;
          this.lastError = rollbackError;
          this.notify({ label: 'replace_recovery_mode' });
          return { ok: false, reason: 'recovery', error, rollbackError };
        }
      }
    }
    this.state = candidate;
    this.lastWritePlan = { fullReplace: true };
    this.notify({ label });
    return { ok: true, state: candidate };
  }

  async runMaintenance(now = new Date()) {
    if (!this.state || this.state.meta.recoveryMode) return { ok: false, reason: 'recovery' };
    const draft = clone(this.state);
    const deletedPurged = purgeDeleted(draft, now);
    const archiveBefore = draft.conflictArchive.length;
    draft.conflictArchive = draft.conflictArchive.filter((entry) => !entry.purgeAfter || new Date(entry.purgeAfter).getTime() > now.getTime());
    const snapshots = purgeMigrationSnapshots(draft, now);
    if (!deletedPurged && archiveBefore === draft.conflictArchive.length && !snapshots.changed) return { ok: true, changed: false };
    const result = await this.commit(draft, { label: 'maintenance', queue: false });
    return { ...result, changed: result.ok };
  }

  recoveryExport() { return recoveryExportPayload(this.state); }

  async retryRecovery() {
    if (!this.state?.meta?.recoveryMode || !this.db || this.volatile) return { ok: false, reason: 'unavailable' };
    const result = await retryRecovery(this.db, this.state);
    if (!result.ok) {
      this.state = result.state;
      this.lastError = result.error;
      this.notify({ label: 'recovery_retry_failed' });
      return result;
    }
    this.state = result.state;
    this.lastError = null;
    this.notify({ label: 'recovery_retry' });
    return result;
  }

  getState() { return this.state; }

  async close() { await this.markNormalShutdown(); this.db?.close(); }
}

export function downloadText(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function stateAsJSON(state) { return JSON.stringify(state, null, 2); }
