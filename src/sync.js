import { clone, isoNow, newId, normalizeState, validateState } from './schema.js';

const ITEM_FIELDS = ['title', 'status', 'categoryId', 'parentId', 'activeOrder', 'completedOrder', 'priority', 'importance', 'plannedStart', 'dueMode', 'dueDate', 'notes', 'tags', 'firstCompletedAt', 'completedAt', 'reopenedAt'];

function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function buildSyncIdentity(state) {
  return {
    accountId: state.meta.accountId ?? null,
    datasetId: state.meta.datasetId,
    revision: state.meta.revision,
    baseRevision: state.meta.baseRevision,
    clientId: state.meta.clientId,
  };
}

export function enqueueLocalChange(state, label, itemIds = []) {
  const key = itemIds.length ? itemIds.slice().sort().join(',') : label;
  const previous = state.syncChanges.at(-1);
  if (previous && previous.coalesceKey === key && Date.now() - new Date(previous.createdAt).getTime() < 15000) {
    previous.labels = [...new Set([...(previous.labels ?? [previous.label]), label])];
    previous.revision = state.meta.revision;
    previous.updatedAt = isoNow();
    return previous;
  }
  const change = { id: newId('change'), coalesceKey: key, label, labels: [label], itemIds: [...itemIds], revision: state.meta.revision, baseRevision: state.meta.baseRevision, clientId: state.meta.clientId, createdAt: isoNow(), updatedAt: isoNow() };
  state.syncChanges.push(change);
  return change;
}

export function coalescePendingChanges(changes) {
  const result = [];
  const index = new Map();
  for (const change of changes) {
    const key = change.coalesceKey ?? change.itemId ?? change.id;
    if (!index.has(key)) { index.set(key, result.length); result.push({ ...clone(change), labels: [...(change.labels ?? [change.label])] }); }
    else {
      const existing = result[index.get(key)];
      existing.labels = [...new Set([...existing.labels, ...(change.labels ?? [change.label])])];
      existing.updatedAt = change.updatedAt ?? existing.updatedAt;
      existing.revision = Math.max(existing.revision ?? 0, change.revision ?? 0);
    }
  }
  return result;
}

function mergeField(baseValue, localValue, remoteValue, field, itemId) {
  const localChanged = !equal(localValue, baseValue);
  const remoteChanged = !equal(remoteValue, baseValue);
  if (!localChanged && !remoteChanged) return { value: clone(baseValue) };
  if (localChanged && !remoteChanged) return { value: clone(localValue) };
  if (!localChanged && remoteChanged) return { value: clone(remoteValue) };
  if (equal(localValue, remoteValue)) return { value: clone(localValue) };
  return { conflict: { id: newId('conflict'), itemId, type: field === 'parentId' || field === 'categoryId' ? 'parent' : field.includes('Order') ? 'order' : 'field', field, baseState: clone(baseValue), localState: clone(localValue), remoteState: clone(remoteValue), createdAt: isoNow() } };
}

export function mergeItem(base, local, remote) {
  if (!base && local && !remote) return { item: clone(local), conflicts: [] };
  if (!base && remote && !local) return { item: clone(remote), conflicts: [] };
  if (!base && local && remote) {
    if (equal(local, remote)) return { item: clone(local), conflicts: [] };
    return { item: clone(local), conflicts: [{ id: newId('conflict'), itemId: local.id, type: 'new_item', baseState: null, localState: clone(local), remoteState: clone(remote), createdAt: isoNow() }] };
  }
  if (base && !local && remote) {
    if (equal(base, remote)) return { item: null, conflicts: [] };
    return { item: clone(remote), conflicts: [{ id: newId('conflict'), itemId: remote.id, type: 'delete_edit', baseState: clone(base), localState: null, remoteState: clone(remote), createdAt: isoNow() }] };
  }
  if (base && local && !remote) {
    if (equal(base, local)) return { item: null, conflicts: [] };
    return { item: clone(local), conflicts: [{ id: newId('conflict'), itemId: local.id, type: 'delete_edit', baseState: clone(base), localState: clone(local), remoteState: null, createdAt: isoNow() }] };
  }
  if (!local && !remote) return { item: null, conflicts: [] };
  const merged = clone(base);
  const conflicts = [];
  for (const field of ITEM_FIELDS) {
    const result = mergeField(base[field], local[field], remote[field], field, local.id);
    if (result.conflict) conflicts.push(result.conflict); else merged[field] = result.value;
  }
  merged.revision = Math.max(local.revision ?? 0, remote.revision ?? 0);
  merged.baseRevision = merged.revision;
  merged.fieldRevisions = { ...(local.fieldRevisions ?? {}), ...(remote.fieldRevisions ?? {}) };
  merged.updatedAt = new Date(Math.max(new Date(local.updatedAt).getTime(), new Date(remote.updatedAt).getTime())).toISOString();
  return { item: merged, conflicts };
}

function mergeById(baseValues, localValues, remoteValues, key = 'id') {
  const base = new Map(baseValues.map((value) => [value[key], value]));
  const local = new Map(localValues.map((value) => [value[key], value]));
  const remote = new Map(remoteValues.map((value) => [value[key], value]));
  const merged = [];
  for (const id of new Set([...base.keys(), ...local.keys(), ...remote.keys()])) {
    const b = base.get(id), l = local.get(id), r = remote.get(id);
    if (equal(l, r)) { if (l) merged.push(clone(l)); continue; }
    if (equal(l, b)) { if (r) merged.push(clone(r)); continue; }
    if (equal(r, b)) { if (l) merged.push(clone(l)); continue; }
    merged.push(clone(l ?? r));
  }
  return merged;
}

export function orderSignature(state, parentId, categoryId) {
  return state.items.filter((item) => item.parentId === parentId && item.categoryId === categoryId && item.status === 'active').sort((a, b) => a.activeOrder - b.activeOrder).map((item) => item.id).join('|');
}

export function mergeDatasets(baseInput, localInput, remoteInput) {
  const base = normalizeState(baseInput), local = normalizeState(localInput), remote = normalizeState(remoteInput);
  const merged = clone(local);
  const conflicts = [];
  const itemMap = new Map();
  for (const id of new Set([...base.items, ...local.items, ...remote.items].map((item) => item.id))) {
    const result = mergeItem(base.items.find((item) => item.id === id), local.items.find((item) => item.id === id), remote.items.find((item) => item.id === id));
    if (result.item) itemMap.set(id, result.item);
    conflicts.push(...result.conflicts);
  }
  merged.items = [...itemMap.values()];
  merged.categories = mergeById(base.categories, local.categories, remote.categories);
  merged.history = mergeById(base.history, local.history, remote.history);
  merged.reminders = mergeById(base.reminders, local.reminders, remote.reminders);
  merged.deleted = mergeById(base.deleted, local.deleted, remote.deleted);
  merged.today = { ...clone(local.today), items: mergeToday(base.today, local.today, remote.today) };
  const parentPairs = new Set(merged.items.map((item) => `${item.categoryId}:${item.parentId}`));
  for (const pair of parentPairs) {
    const [categoryId, parentId] = pair.split(':');
    const before = orderSignature(base, parentId === 'null' ? null : parentId, categoryId);
    const localOrder = orderSignature(local, parentId === 'null' ? null : parentId, categoryId);
    const remoteOrder = orderSignature(remote, parentId === 'null' ? null : parentId, categoryId);
    if (localOrder !== before && remoteOrder !== before && localOrder !== remoteOrder) conflicts.push({ id: newId('conflict'), itemId: null, type: 'order', parentId: parentId === 'null' ? null : parentId, categoryId, baseState: before, localState: localOrder, remoteState: remoteOrder, createdAt: isoNow() });
  }
  merged.conflicts = [...merged.conflicts, ...conflicts];
  merged.meta.revision = Math.max(local.meta.revision, remote.meta.revision);
  merged.meta.baseRevision = remote.meta.revision;
  merged.meta.updatedAt = isoNow();
  return { state: normalizeState(merged), conflicts, autoMerged: conflicts.length === 0 };
}

function mergeToday(base, local, remote) {
  const result = {};
  for (const id of new Set([...Object.keys(base?.items ?? {}), ...Object.keys(local?.items ?? {}), ...Object.keys(remote?.items ?? {})])) {
    const b = base?.items?.[id], l = local?.items?.[id], r = remote?.items?.[id];
    if (equal(l, r)) { if (l) result[id] = clone(l); }
    else if (equal(l, b)) { if (r) result[id] = clone(r); }
    else if (equal(r, b)) { if (l) result[id] = clone(l); }
    else if (l) result[id] = clone(l);
  }
  return result;
}

function markConflictResolution(state, item, fields, at) {
  if (!item) return;
  item.revision = Number(item.revision ?? 0) + 1;
  item.updatedAt = at;
  item.fieldRevisions = { ...(item.fieldRevisions ?? {}) };
  for (const field of fields) item.fieldRevisions[field] = item.revision;
  state.history.push({ id: newId('hist'), itemId: item.id, type: 'conflict_resolved', metadata: { fields }, at });
}

export function resolveConflict(state, conflictId, choice, at = isoNow()) {
  const index = state.conflicts.findIndex((conflict) => conflict.id === conflictId);
  if (index < 0) return { ok: false, reason: 'missing' };
  const localChoice = ['local', 'keep_local', 'keep_edit'].includes(choice);
  const remoteChoice = ['remote', 'keep_cloud', 'keep_delete'].includes(choice);
  if (!localChoice && !remoteChoice) return { ok: false, reason: 'invalid' };
  const conflict = state.conflicts[index];
  const rejected = localChoice ? conflict.remoteState : conflict.localState;
  if (conflict.type === 'order') {
    const chosen = localChoice ? conflict.localState : conflict.remoteState;
    const ids = chosen ? chosen.split('|') : [];
    ids.forEach((id, position) => { const item = state.items.find((candidate) => candidate.id === id); if (item) { item.activeOrder = position; markConflictResolution(state, item, ['activeOrder'], at); } });
  } else if (conflict.itemId) {
    const itemIndex = state.items.findIndex((item) => item.id === conflict.itemId);
    if (conflict.type === 'delete_edit' || conflict.type === 'new_item') {
      const selected = localChoice ? conflict.localState : conflict.remoteState;
      if (selected && itemIndex < 0) { const restored = clone(selected); state.items.push(restored); markConflictResolution(state, restored, ITEM_FIELDS, at); }
      else if (!selected && itemIndex >= 0) state.items.splice(itemIndex, 1);
      else if (selected && itemIndex >= 0) { state.items[itemIndex] = clone(selected); markConflictResolution(state, state.items[itemIndex], ITEM_FIELDS, at); }
    } else if (itemIndex >= 0 && conflict.field) {
      state.items[itemIndex][conflict.field] = clone(localChoice ? conflict.localState : conflict.remoteState);
      markConflictResolution(state, state.items[itemIndex], [conflict.field], at);
    }
  }
  state.conflicts.splice(index, 1);
  state.conflictArchive.push({ id: newId('archive'), conflictId, itemId: conflict.itemId, type: conflict.type, chosenState: choice, rejectedState: clone(rejected), baseRevision: state.meta.baseRevision, resolvedAt: at, purgeAfter: new Date(new Date(at).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString() });
  return { ok: true, conflict };
}

export function syncValidation(state) {
  const errors = validateState(state);
  return errors.map((error) => ({ ...error, source: 'sync' }));
}

export function buildSyncPayload(state) {
  const payload = clone(state);
  delete payload.meta.syncBaseState;
  payload.diagnostics = { events: [], errors: [], aggregates: {} };
  payload.performance = [];
  payload.capabilities = {};
  return { identity: buildSyncIdentity(state), state: payload };
}

export class GoogleDriveSync {
  constructor({ clientId = '', datasetFileName = 'progress-tracker-sync.json', backupFolderName = 'Progress Tracker Backups' } = {}) {
    this.clientId = clientId;
    this.datasetFileName = datasetFileName;
    this.backupFolderName = backupFolderName;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.client = null;
    this.status = 'disabled';
    this.lastError = null;
  }

  configure(clientId) { this.clientId = String(clientId ?? '').trim(); this.status = this.clientId ? 'configured' : 'disabled'; return this.status; }

  canAuthorize() { return Boolean(this.clientId && globalThis.google?.accounts?.oauth2); }

  async authorize() {
    if (!this.clientId) throw new Error('Google OAuth Client ID is required');
    if (!globalThis.google?.accounts?.oauth2) throw new Error('Google Identity Services is not available');
    const token = await new Promise((resolve, reject) => {
      this.client = google.accounts.oauth2.initTokenClient({ client_id: this.clientId, scope: 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file', callback: resolve, error_callback: reject });
      this.client.requestAccessToken({ prompt: this.accessToken ? '' : 'consent' });
    });
    if (!token?.access_token) throw new Error('Google authorization returned no access token');
    this.accessToken = token.access_token;
    this.tokenExpiresAt = Date.now() + Number(token.expires_in ?? 3600) * 1000;
    this.status = 'authorized';
    return { ok: true, expiresAt: this.tokenExpiresAt };
  }

  logout() { this.accessToken = null; this.tokenExpiresAt = 0; this.status = this.clientId ? 'configured' : 'disabled'; }

  async accountIdentity() {
    try {
      const response = await this.request('https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress)');
      const user = (await response.json()).user;
      return user?.permissionId ?? user?.emailAddress ?? null;
    } catch {
      return null;
    }
  }

  async request(url, options = {}) {
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt) throw new Error('Google Drive authorization is required');
    const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${this.accessToken}`, ...(options.headers ?? {}) } });
    if (!response.ok) throw new Error(`Google Drive request failed (${response.status})`);
    return response;
  }

  async pull() {
    const query = encodeURIComponent(`name = '${this.datasetFileName}' and 'appDataFolder' in parents and trashed = false`);
    const response = await this.request(`https://www.googleapis.com/drive/v3/files?q=${query}&spaces=appDataFolder&fields=files(id,name,modifiedTime,appProperties)`);
    const list = await response.json();
    const file = list.files?.[0];
    if (!file) return { status: 'empty', state: null, file: null };
    const content = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`);
    const payload = await content.json();
    return { status: 'remote', state: normalizeState(payload.state ?? payload), file };
  }

  async push(state, fileId = null) {
    const payload = JSON.stringify(buildSyncPayload(state));
    const metadata = { name: this.datasetFileName, mimeType: 'application/json', parents: ['appDataFolder'], appProperties: { datasetId: state.meta.datasetId, revision: String(state.meta.revision) } };
    const boundary = `progress_tracker_${Date.now()}`;
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(fileId ? { ...metadata, name: this.datasetFileName } : metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n--${boundary}--`;
    const endpoint = fileId ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=multipart` : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    const response = await this.request(endpoint, { method: fileId ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
    return { status: 'saved', file: await response.json() };
  }

  async deleteDataset(fileId) {
    if (!fileId) throw new Error('Cloud dataset file is required');
    await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    return { status: 'deleted' };
  }

  async ensureVisibleBackupFolder(datasetId, folderId = null) {
    if (folderId) return { id: folderId, name: this.backupFolderName };
    const query = encodeURIComponent(`name = '${this.backupFolderName.replaceAll("'", "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
    const response = await this.request(`https://www.googleapis.com/drive/v3/files?q=${query}&spaces=drive&fields=files(id,name,appProperties)`);
    const list = await response.json();
    const existing = list.files?.find((file) => file.appProperties?.datasetId === datasetId && file.appProperties?.kind === 'progress_tracker_backup_folder');
    if (existing) return existing;
    const created = await this.request('https://www.googleapis.com/drive/v3/files?fields=id,name,appProperties', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: this.backupFolderName, mimeType: 'application/vnd.google-apps.folder', appProperties: { datasetId, kind: 'progress_tracker_backup_folder' } }) });
    return created.json();
  }

  async listVisibleBackups(datasetId, folderId = null) {
    if (!folderId) return { folder: null, files: [] };
    const query = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const response = await this.request(`https://www.googleapis.com/drive/v3/files?q=${query}&spaces=drive&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime,size,mimeType,appProperties)`);
    const list = await response.json();
    return { folder: { id: folderId, name: this.backupFolderName }, files: (list.files ?? []).filter((file) => file.appProperties?.datasetId === datasetId && file.appProperties?.scope === 'full') };
  }

  async pushVisibleBackup(ptmd, fileName, datasetId, folderId = null) {
    const folder = await this.ensureVisibleBackupFolder(datasetId, folderId);
    const boundary = `progress_tracker_backup_${Date.now()}`;
    const metadata = { name: fileName, mimeType: 'text/markdown', parents: [folder.id], appProperties: { datasetId, scope: 'full', format: 'PTMD' } };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/markdown\r\n\r\n${ptmd}\r\n--${boundary}--`;
    const response = await this.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime,size,mimeType,appProperties', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
    return { folder, file: await response.json() };
  }

  async pullVisibleBackup(fileId) {
    if (!fileId) throw new Error('Visible backup file is required');
    const response = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`);
    return response.text();
  }
}
