import { clone, isoNow, makeEmptyState, normalizeState, validateState } from './schema.js';
import { loadState, openDatabase, saveState, StorageError } from './db.js';
import { initializeWithMigration } from './migration.js';
import { enqueueLocalChange } from './sync.js';
import { applyDailyRollover, purgeDeleted } from './engine.js';

function changedItemIds(before, after) {
  const previous = new Map((before?.items ?? []).map((item) => [item.id, JSON.stringify(item)]));
  const current = new Map((after?.items ?? []).map((item) => [item.id, JSON.stringify(item)]));
  const ids = new Set([...previous.keys(), ...current.keys()]);
  return [...ids].filter((id) => previous.get(id) !== current.get(id));
}

export class ProgressRepository {
  constructor() {
    this.db = null;
    this.state = null;
    this.listeners = new Set();
    this.volatile = false;
    this.lastError = null;
    this.previousSessionAbnormal = false;
  }

  async initialize() {
    try {
      this.db = await openDatabase();
      const result = await initializeWithMigration(this.db, loadState);
      this.state = result.state;
      if (!result.recovery) {
        const rollover = applyDailyRollover(this.state);
        purgeDeleted(this.state);
        this.state.conflictArchive = this.state.conflictArchive.filter((entry) => new Date(entry.purgeAfter).getTime() > Date.now());
        if (rollover.changed || result.migrated) await saveState(this.db, this.state);
      } else {
        this.lastError = result.error;
      }
    } catch (error) {
      this.volatile = true;
      this.lastError = error;
      this.state = makeEmptyState();
    }
    this.previousSessionAbnormal = Boolean(this.state.meta.lastSession && this.state.meta.lastSession.normal === false && this.state.meta.lastSession.startedAt);
    this.state.meta.lastSession = { startedAt: isoNow(), endedAt: null, normal: false };
    if (!this.volatile && !this.state.meta.recoveryMode) {
      try { await saveState(this.db, this.state); } catch (error) { this.lastError = error; this.volatile = true; }
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
    if (queue) enqueueLocalChange(candidate, label, changedItemIds(this.state, candidate));
    if (!this.volatile) {
      try { await saveState(this.db, candidate); } catch (error) { this.lastError = error; return { ok: false, reason: 'storage', error }; }
    }
    this.state = candidate;
    this.notify({ label });
    return { ok: true, state: this.state };
  }

  async update(label, mutator, options = {}) {
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
    if (!this.volatile) { try { await saveState(this.db, draft); } catch { return; } }
    this.state = draft;
  }

  async replaceState(nextState, label = 'replace') { return this.commit(nextState, { label, queue: false }); }

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
