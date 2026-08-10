function bytes(value) {
  return new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength;
}

export function storageBreakdown(state) {
  const basicItems = (state.items ?? []).map(({ notes: _notes, tags: _tags, ...item }) => item);
  const notes = (state.items ?? []).filter((item) => item.notes).map((item) => ({ itemId: item.id, notes: item.notes }));
  const tags = (state.items ?? []).filter((item) => item.tags?.length).map((item) => ({ itemId: item.id, tags: item.tags }));
  const breakdown = {
    metadata: bytes(state.meta),
    categories: bytes(state.categories),
    items: bytes(basicItems),
    notes: bytes(notes),
    tags: bytes(tags),
    history: bytes(state.history),
    reminders: bytes(state.reminders),
    today: bytes(state.today),
    deleted: bytes(state.deleted),
    sync: bytes({
      changes: state.syncChanges,
      conflicts: state.conflicts,
      cloud: state.settings?.cloudSync,
      smartOrders: state.smartOrders,
    }),
    conflicts: bytes(state.conflictArchive),
    backup: bytes(state.backupMeta),
    recovery: bytes({ migrationSnapshots: state.migrationSnapshots, recoverySnapshots: state.recoverySnapshots }),
    diagnostics: bytes({ diagnostics: state.diagnostics, performance: state.performance, capabilities: state.capabilities }),
    settings: bytes({ ...state.settings, cloudSync: undefined }),
  };
  return {
    breakdown,
    total: Object.values(breakdown).reduce((sum, value) => sum + value, 0),
    method: 'logical-json-estimate',
  };
}

export function browserStorageEstimate(estimate) {
  const usage = Number(estimate?.usage);
  const quota = Number(estimate?.quota);
  if (!Number.isFinite(usage) || usage < 0 || !Number.isFinite(quota) || quota <= 0) return null;
  return {
    usage,
    quota,
    available: Math.max(0, quota - usage),
    estimated: true,
  };
}
