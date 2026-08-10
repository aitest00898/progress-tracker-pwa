import { clone, isoNow, newId, normalizeState, SCHEMA_VERSION, validateState } from './schema.js';

const ITEM_FIELDS = [
  'title', 'status', 'priority', 'importance', 'plannedStart', 'dueMode', 'dueDate', 'notes', 'tags',
  'firstCompletedAt', 'completedAt', 'reopenedAt', 'reopenOrder',
];
const CATEGORY_FIELDS = ['title', 'order'];
const REMINDER_FIELDS = [
  'itemId', 'type', 'offsetDays', 'time', 'at', 'enabled', 'keepAfterComplete',
  'suspendedByCompletion', 'snoozedUntil', 'suppressedDay', 'lastTriggeredAt',
];
const TODAY_FIELDS = ['order', 'addedAt', 'source', 'completedAt'];
const DELETED_FIELDS = ['kind', 'rootId', 'categoryId', 'parentId', 'deletedAt', 'purgeAfter', 'snapshot'];
const HISTORY_FIELDS = ['itemId', 'type', 'metadata', 'at'];
const BACKUP_FIELDS = ['scope', 'format', 'location', 'fileId', 'createdAt', 'independentlyRestorable', 'bytes'];
const ARCHIVE_FIELDS = ['conflictId', 'itemId', 'entityType', 'entityId', 'field', 'type', 'chosenState', 'rejectedState', 'baseRevision', 'resolvedAt', 'purgeAfter', 'structuralSnapshot'];
const SYNCABLE_SETTING_PATHS = [
  'language', 'theme', 'defaultPage', 'defaultCategoryId', 'defaultSmartView', 'smartSort',
  'showCompleted', 'overdueExpanded', 'defaultReminderTime',
  'experimental.enabled', 'experimental.smart', 'experimental.routine', 'experimental.reminderLearning',
];

function copy(value) {
  return value === undefined ? undefined : clone(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function equal(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function latestTimestamp(...values) {
  const times = values.map((value) => new Date(value ?? 0).getTime()).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : isoNow();
}

function conflictSignature(conflict) {
  return [conflict.entityType ?? 'item', conflict.entityId ?? conflict.itemId ?? '', conflict.type, conflict.field ?? ''].join(':');
}

function createConflict({
  entityType,
  entityId,
  itemId = null,
  type,
  field = null,
  baseState,
  localState,
  remoteState,
  group = null,
  at,
}) {
  return {
    id: newId('conflict'),
    entityType,
    entityId,
    itemId,
    type,
    field,
    baseState: copy(baseState),
    localState: copy(localState),
    remoteState: copy(remoteState),
    group: copy(group),
    status: 'pending',
    blockedPush: true,
    createdAt: at,
  };
}

function mergeValue(baseValue, localValue, remoteValue) {
  if (equal(localValue, remoteValue)) return { value: copy(localValue) };
  if (equal(localValue, baseValue)) return { value: copy(remoteValue) };
  if (equal(remoteValue, baseValue)) return { value: copy(localValue) };
  return { conflict: true, value: copy(baseValue) };
}

function relatedItemId(entityType, entityId, base, local, remote) {
  if (entityType === 'item' || entityType === 'today') return entityId;
  if (entityType === 'reminder') return local?.itemId ?? remote?.itemId ?? base?.itemId ?? null;
  if (entityType === 'deleted') return local?.rootId ?? remote?.rootId ?? base?.rootId ?? null;
  return null;
}

function mergeEntity(base, local, remote, { entityType, entityId, fields, at }) {
  const itemId = relatedItemId(entityType, entityId, base, local, remote);
  if (!base && local && !remote) return { entity: copy(local), conflicts: [] };
  if (!base && remote && !local) return { entity: copy(remote), conflicts: [] };
  if (!base && local && remote) {
    if (equal(local, remote)) return { entity: copy(local), conflicts: [] };
    return {
      entity: copy(local),
      conflicts: [createConflict({
        entityType, entityId, itemId, type: 'new_entity',
        baseState: null, localState: local, remoteState: remote, at,
      })],
    };
  }
  if (base && !local && remote) {
    if (equal(base, remote)) return { entity: null, conflicts: [] };
    return {
      entity: copy(remote),
      conflicts: [createConflict({
        entityType, entityId, itemId, type: 'delete_edit',
        baseState: base, localState: null, remoteState: remote, at,
      })],
    };
  }
  if (base && local && !remote) {
    if (equal(base, local)) return { entity: null, conflicts: [] };
    return {
      entity: copy(local),
      conflicts: [createConflict({
        entityType, entityId, itemId, type: 'delete_edit',
        baseState: base, localState: local, remoteState: null, at,
      })],
    };
  }
  if (!local && !remote) return { entity: null, conflicts: [] };

  const merged = copy(base);
  const conflicts = [];
  for (const field of fields) {
    const result = mergeValue(base?.[field], local?.[field], remote?.[field]);
    if (result.conflict) {
      conflicts.push(createConflict({
        entityType,
        entityId,
        itemId,
        type: field === 'order' ? 'order' : entityType === 'today' ? 'membership' : 'field',
        field,
        baseState: base?.[field],
        localState: local?.[field],
        remoteState: remote?.[field],
        at,
      }));
    }
    merged[field] = result.value;
  }
  merged.id = local?.id ?? remote?.id ?? base?.id ?? entityId;
  merged.createdAt = base?.createdAt ?? local?.createdAt ?? remote?.createdAt;
  merged.updatedAt = latestTimestamp(base?.updatedAt, local?.updatedAt, remote?.updatedAt);
  merged.revision = Math.max(Number(base?.revision ?? 0), Number(local?.revision ?? 0), Number(remote?.revision ?? 0));
  merged.baseRevision = Math.max(Number(base?.baseRevision ?? 0), Number(local?.baseRevision ?? 0), Number(remote?.baseRevision ?? 0));
  merged.fieldRevisions = { ...(base?.fieldRevisions ?? {}), ...(local?.fieldRevisions ?? {}), ...(remote?.fieldRevisions ?? {}) };
  return { entity: merged, conflicts };
}

function mergeItem(base, local, remote, at) {
  const entityId = local?.id ?? remote?.id ?? base?.id;
  const result = mergeEntity(base, local, remote, { entityType: 'item', entityId, fields: ITEM_FIELDS, at });
  if (!base || !local || !remote || !result.entity) return result;
  const baseLocation = { categoryId: base.categoryId, parentId: base.parentId };
  const localLocation = { categoryId: local.categoryId, parentId: local.parentId };
  const remoteLocation = { categoryId: remote.categoryId, parentId: remote.parentId };
  const location = mergeValue(baseLocation, localLocation, remoteLocation);
  if (location.conflict) {
    result.conflicts.push(createConflict({
      entityType: 'item', entityId, itemId: entityId, type: 'parent', field: 'location',
      baseState: baseLocation, localState: localLocation, remoteState: remoteLocation, at,
    }));
  }
  result.entity.categoryId = location.value?.categoryId ?? base.categoryId;
  result.entity.parentId = location.value?.parentId ?? null;
  return result;
}

function collectionMap(values) {
  return new Map((values ?? []).map((value) => [value.id, value]));
}

function mergeCollection(baseValues, localValues, remoteValues, descriptor, at) {
  const base = collectionMap(baseValues);
  const local = collectionMap(localValues);
  const remote = collectionMap(remoteValues);
  const values = [];
  const conflicts = [];
  for (const id of new Set([...base.keys(), ...local.keys(), ...remote.keys()])) {
    const result = descriptor.entityType === 'item'
      ? mergeItem(base.get(id), local.get(id), remote.get(id), at)
      : mergeEntity(base.get(id), local.get(id), remote.get(id), { ...descriptor, entityId: id, at });
    if (result.entity) values.push(result.entity);
    conflicts.push(...result.conflicts);
  }
  return { values, conflicts };
}

function valueAtPath(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object);
}

function setAtPath(object, path, value) {
  const keys = path.split('.');
  let cursor = object;
  for (const key of keys.slice(0, -1)) {
    cursor[key] = { ...(cursor[key] ?? {}) };
    cursor = cursor[key];
  }
  cursor[keys.at(-1)] = copy(value);
}

function mergeSettings(base, local, remote, merged, conflicts, at) {
  for (const path of SYNCABLE_SETTING_PATHS) {
    const result = mergeValue(valueAtPath(base.settings, path), valueAtPath(local.settings, path), valueAtPath(remote.settings, path));
    if (result.conflict) {
      conflicts.push(createConflict({
        entityType: 'settings', entityId: path, type: 'field', field: path,
        baseState: valueAtPath(base.settings, path),
        localState: valueAtPath(local.settings, path),
        remoteState: valueAtPath(remote.settings, path),
        at,
      }));
    }
    setAtPath(merged.settings, path, result.value);
  }
}

function mergeSmartOrders(base, local, remote, merged, conflicts, at) {
  const views = new Set([...Object.keys(base.smartOrders ?? {}), ...Object.keys(local.smartOrders ?? {}), ...Object.keys(remote.smartOrders ?? {})]);
  merged.smartOrders = { ...(local.smartOrders ?? {}) };
  for (const view of views) {
    const result = mergeValue(base.smartOrders?.[view], local.smartOrders?.[view], remote.smartOrders?.[view]);
    if (result.conflict) {
      conflicts.push(createConflict({
        entityType: 'smart_order', entityId: view, type: 'order', field: 'order',
        baseState: base.smartOrders?.[view] ?? [],
        localState: local.smartOrders?.[view] ?? [],
        remoteState: remote.smartOrders?.[view] ?? [],
        at,
      }));
    }
    if (result.value === undefined) delete merged.smartOrders[view];
    else merged.smartOrders[view] = result.value;
  }
}

function todayMap(state) {
  return new Map(Object.entries(state.today?.items ?? {}).map(([id, entry]) => [id, { ...entry, id, itemId: id }]));
}

function mergeToday(base, local, remote, merged, conflicts, at) {
  const baseMap = todayMap(base);
  const localMap = todayMap(local);
  const remoteMap = todayMap(remote);
  const items = {};
  for (const id of new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()])) {
    const result = mergeEntity(baseMap.get(id), localMap.get(id), remoteMap.get(id), { entityType: 'today', entityId: id, fields: TODAY_FIELDS, at });
    if (result.entity) {
      const entry = result.entity;
      delete entry.id;
      items[id] = entry;
    }
    conflicts.push(...result.conflicts);
  }
  merged.today = {
    lastRolloverDate: [base.today?.lastRolloverDate, local.today?.lastRolloverDate, remote.today?.lastRolloverDate].filter(Boolean).sort().at(-1) ?? null,
    items,
  };
}

function orderGroupKey(item) {
  return JSON.stringify([item.categoryId, item.parentId ?? null, item.status]);
}

function orderGroupDescriptor(key) {
  const [categoryId, parentId, status] = JSON.parse(key);
  return { categoryId, parentId, status, orderField: status === 'completed' ? 'completedOrder' : 'activeOrder' };
}

function orderedIds(state, key) {
  const descriptor = orderGroupDescriptor(key);
  return state.items
    .filter((item) => item.categoryId === descriptor.categoryId && item.parentId === descriptor.parentId && item.status === descriptor.status)
    .sort((a, b) => Number(a[descriptor.orderField] ?? 0) - Number(b[descriptor.orderField] ?? 0) || a.id.localeCompare(b.id))
    .map((item) => item.id);
}

function applyOrder(state, key, chosenIds) {
  const descriptor = orderGroupDescriptor(key);
  const group = state.items.filter((item) => item.categoryId === descriptor.categoryId && item.parentId === descriptor.parentId && item.status === descriptor.status);
  const current = [...group].sort((a, b) => Number(a[descriptor.orderField] ?? 0) - Number(b[descriptor.orderField] ?? 0) || a.id.localeCompare(b.id));
  const chosen = [...new Set((chosenIds ?? []).filter((id) => group.some((item) => item.id === id)))];
  const complete = [...chosen, ...current.map((item) => item.id).filter((id) => !chosen.includes(id))];
  complete.forEach((id, index) => {
    const item = state.items.find((candidate) => candidate.id === id);
    if (item) item[descriptor.orderField] = index;
  });
}

function mergeSiblingOrders(base, local, remote, merged, conflicts, at) {
  const groups = new Set([...base.items, ...local.items, ...remote.items, ...merged.items].map(orderGroupKey));
  for (const key of groups) {
    const baseOrder = orderedIds(base, key);
    const localOrder = orderedIds(local, key);
    const remoteOrder = orderedIds(remote, key);
    const result = mergeValue(baseOrder, localOrder, remoteOrder);
    if (result.conflict) {
      const group = orderGroupDescriptor(key);
      conflicts.push(createConflict({
        entityType: 'sibling_order', entityId: key, type: 'order', field: group.orderField,
        baseState: baseOrder, localState: localOrder, remoteState: remoteOrder, group, at,
      }));
    }
    applyOrder(merged, key, result.value ?? baseOrder);
  }
}

function deDuplicateConflicts(existing, generated) {
  const bySignature = new Map();
  for (const conflict of [...(existing ?? []), ...generated]) {
    if (conflict.status === 'resolved') continue;
    const signature = conflictSignature(conflict);
    if (!bySignature.has(signature)) bySignature.set(signature, { status: 'pending', blockedPush: true, ...copy(conflict) });
  }
  return [...bySignature.values()];
}

function replaceCollectionEntity(target, source, stateKey, id) {
  const replacement = source[stateKey]?.find((entity) => entity.id === id);
  target[stateKey] = (target[stateKey] ?? []).filter((entity) => entity.id !== id);
  if (replacement) target[stateKey].push(copy(replacement));
}

function projectCloudState(mergedInput, remoteInput, conflicts) {
  let projected = copy(mergedInput);
  const remote = normalizeState(remoteInput);
  for (const conflict of conflicts) {
    const entityType = conflict.entityType ?? 'item';
    if (entityType === 'dataset') {
      projected = copy(remote);
      break;
    }
    const stateKey = {
      item: 'items',
      category: 'categories',
      reminder: 'reminders',
      deleted: 'deleted',
      history: 'history',
      backup: 'backupMeta',
      conflict_archive: 'conflictArchive',
    }[entityType];
    if (stateKey) replaceCollectionEntity(projected, remote, stateKey, conflict.entityId ?? conflict.itemId);
    else if (entityType === 'today') {
      const id = conflict.entityId ?? conflict.itemId;
      if (remote.today.items[id]) projected.today.items[id] = copy(remote.today.items[id]);
      else delete projected.today.items[id];
    } else if (entityType === 'settings') {
      setAtPath(projected.settings, conflict.entityId, valueAtPath(remote.settings, conflict.entityId));
    } else if (entityType === 'smart_order') {
      const view = conflict.entityId;
      if (remote.smartOrders?.[view] === undefined) delete projected.smartOrders[view];
      else projected.smartOrders[view] = copy(remote.smartOrders[view]);
    } else if (entityType === 'sibling_order') {
      applyOrder(projected, conflict.entityId, conflict.remoteState);
    }
  }
  projected.conflicts = [];
  projected.syncChanges = [];
  delete projected.meta.syncBaseState;
  projected.meta.recoveryMode = false;
  projected.meta.recoveryContext = null;
  projected.meta.updatedAt = isoNow();
  return normalizeState(projected);
}

function canonicalSyncSnapshot(state) {
  return {
    categories: state.categories,
    items: state.items,
    history: state.history,
    reminders: state.reminders,
    today: state.today,
    settings: Object.fromEntries(SYNCABLE_SETTING_PATHS.map((path) => [path, valueAtPath(state.settings, path)])),
    smartOrders: state.smartOrders,
    deleted: state.deleted,
    backupMeta: state.backupMeta,
    conflictArchive: state.conflictArchive,
  };
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

export function enqueueLocalChange(state, label, itemIds = [], entityKeys = []) {
  const normalizedItemIds = [...new Set(itemIds)].sort();
  const normalizedEntities = [...new Set(entityKeys)].sort();
  const key = normalizedEntities.length ? normalizedEntities.join(',') : normalizedItemIds.length ? normalizedItemIds.join(',') : label;
  const previous = state.syncChanges.at(-1);
  if (previous && previous.coalesceKey === key && Date.now() - new Date(previous.createdAt).getTime() < 15000) {
    previous.labels = [...new Set([...(previous.labels ?? [previous.label]), label])];
    previous.revision = state.meta.revision;
    previous.itemIds = [...new Set([...(previous.itemIds ?? []), ...normalizedItemIds])];
    previous.entityKeys = [...new Set([...(previous.entityKeys ?? []), ...normalizedEntities])];
    previous.updatedAt = isoNow();
    return previous;
  }
  const change = {
    id: newId('change'),
    coalesceKey: key,
    label,
    labels: [label],
    itemIds: normalizedItemIds,
    entityKeys: normalizedEntities,
    revision: state.meta.revision,
    baseRevision: state.meta.baseRevision,
    clientId: state.meta.clientId,
    createdAt: isoNow(),
    updatedAt: isoNow(),
  };
  state.syncChanges.push(change);
  return change;
}

export function coalescePendingChanges(changes) {
  const result = [];
  const index = new Map();
  for (const change of changes) {
    const key = change.coalesceKey ?? change.itemId ?? change.id;
    if (!index.has(key)) {
      index.set(key, result.length);
      result.push({
        ...copy(change),
        labels: [...(change.labels ?? [change.label])],
        itemIds: [...(change.itemIds ?? [])],
        entityKeys: [...(change.entityKeys ?? [])],
      });
    } else {
      const existing = result[index.get(key)];
      existing.labels = [...new Set([...existing.labels, ...(change.labels ?? [change.label])])];
      existing.itemIds = [...new Set([...existing.itemIds, ...(change.itemIds ?? [])])];
      existing.entityKeys = [...new Set([...existing.entityKeys, ...(change.entityKeys ?? [])])];
      existing.updatedAt = change.updatedAt ?? existing.updatedAt;
      existing.revision = Math.max(existing.revision ?? 0, change.revision ?? 0);
    }
  }
  return result;
}

export function mergeDatasets(baseInput, localInput, remoteInput, { at = isoNow() } = {}) {
  const base = normalizeState(baseInput);
  const local = normalizeState(localInput);
  const remote = normalizeState(remoteInput);
  const merged = copy(local);
  const conflicts = [];

  const itemResult = mergeCollection(base.items, local.items, remote.items, { entityType: 'item', fields: ITEM_FIELDS }, at);
  merged.items = itemResult.values;
  conflicts.push(...itemResult.conflicts);

  const descriptors = [
    ['categories', 'category', CATEGORY_FIELDS],
    ['reminders', 'reminder', REMINDER_FIELDS],
    ['deleted', 'deleted', DELETED_FIELDS],
    ['history', 'history', HISTORY_FIELDS],
    ['backupMeta', 'backup', BACKUP_FIELDS],
    ['conflictArchive', 'conflict_archive', ARCHIVE_FIELDS],
  ];
  for (const [stateKey, entityType, fields] of descriptors) {
    const result = mergeCollection(base[stateKey], local[stateKey], remote[stateKey], { entityType, fields }, at);
    merged[stateKey] = result.values;
    conflicts.push(...result.conflicts);
  }

  mergeToday(base, local, remote, merged, conflicts, at);
  mergeSettings(base, local, remote, merged, conflicts, at);
  mergeSmartOrders(base, local, remote, merged, conflicts, at);
  mergeSiblingOrders(base, local, remote, merged, conflicts, at);

  merged.meta.datasetId = local.meta.datasetId;
  merged.meta.accountId = local.meta.accountId ?? remote.meta.accountId ?? null;
  merged.meta.clientId = local.meta.clientId;
  merged.meta.schemaVersion = SCHEMA_VERSION;
  merged.meta.revision = Math.max(Number(local.meta.revision ?? 0), Number(remote.meta.revision ?? 0));
  merged.meta.baseRevision = Number(remote.meta.revision ?? 0);
  merged.meta.updatedAt = at;
  merged.migrationSnapshots = copy(local.migrationSnapshots);
  merged.recoverySnapshots = copy(local.recoverySnapshots);
  merged.diagnostics = copy(local.diagnostics);
  merged.performance = copy(local.performance);
  merged.capabilities = copy(local.capabilities);

  const pending = deDuplicateConflicts(local.conflicts, conflicts);
  merged.conflicts = pending;
  let normalized = normalizeState(merged);
  const validation = validateState(normalized);
  if (validation.length) {
    const validationConflict = createConflict({
      entityType: 'dataset',
      entityId: local.meta.datasetId,
      type: 'validation',
      field: 'structure',
      baseState: validation,
      localState: { revision: local.meta.revision },
      remoteState: { revision: remote.meta.revision },
      at,
    });
    normalized = normalizeState(local);
    normalized.conflicts = deDuplicateConflicts(local.conflicts, [...conflicts, validationConflict]);
  }
  const cloudState = projectCloudState(normalized, remote, normalized.conflicts);
  return {
    state: normalized,
    cloudState,
    conflicts: normalized.conflicts,
    blockedEntities: [...new Set(normalized.conflicts.map((conflict) => `${conflict.entityType ?? 'item'}:${conflict.entityId ?? conflict.itemId ?? ''}`))],
    safeChanges: !equal(canonicalSyncSnapshot(cloudState), canonicalSyncSnapshot(remote)),
    autoMerged: normalized.conflicts.length === 0,
  };
}

function collectionForEntityType(state, entityType) {
  const stateKey = {
    item: 'items',
    category: 'categories',
    reminder: 'reminders',
    deleted: 'deleted',
    history: 'history',
    backup: 'backupMeta',
    conflict_archive: 'conflictArchive',
  }[entityType];
  return stateKey ? { stateKey, values: state[stateKey] } : null;
}

function replaceEntity(state, entityType, entityId, value) {
  const collection = collectionForEntityType(state, entityType);
  if (!collection) return null;
  state[collection.stateKey] = collection.values.filter((entity) => entity.id !== entityId);
  if (value) state[collection.stateKey].push(copy(value));
  return value ? state[collection.stateKey].find((entity) => entity.id === entityId) : null;
}

function touchResolvedEntity(entity, field, revision, at) {
  if (!entity || typeof entity !== 'object') return;
  entity.revision = revision;
  entity.baseRevision = Math.max(Number(entity.baseRevision ?? 0), revision - 1);
  entity.updatedAt = at;
  entity.fieldRevisions = { ...(entity.fieldRevisions ?? {}) };
  if (field) entity.fieldRevisions[field] = revision;
}

function applyConflictChoice(state, conflict, selected, revision, at) {
  const entityType = conflict.entityType ?? 'item';
  const entityId = conflict.entityId ?? conflict.itemId;
  if (entityType === 'sibling_order') {
    applyOrder(state, entityId, selected ?? []);
    for (const id of selected ?? []) touchResolvedEntity(state.items.find((item) => item.id === id), conflict.field, revision, at);
    return;
  }
  if (entityType === 'smart_order') {
    if (selected === undefined || selected === null) delete state.smartOrders[entityId];
    else state.smartOrders[entityId] = copy(selected);
    return;
  }
  if (entityType === 'settings') {
    setAtPath(state.settings, entityId, selected);
    return;
  }
  if (entityType === 'today') {
    if (['delete_edit', 'new_entity'].includes(conflict.type)) {
      if (selected) {
        const entry = copy(selected);
        delete entry.id;
        state.today.items[entityId] = entry;
        touchResolvedEntity(state.today.items[entityId], conflict.field, revision, at);
      } else delete state.today.items[entityId];
    } else if (state.today.items[entityId]) {
      state.today.items[entityId][conflict.field] = copy(selected);
      touchResolvedEntity(state.today.items[entityId], conflict.field, revision, at);
    }
    return;
  }
  if (conflict.type === 'parent' && entityType === 'item') {
    const item = state.items.find((candidate) => candidate.id === entityId);
    if (item && selected) {
      item.categoryId = selected.categoryId;
      item.parentId = selected.parentId ?? null;
      touchResolvedEntity(item, 'parentId', revision, at);
      item.fieldRevisions.categoryId = revision;
    }
    return;
  }
  if (['delete_edit', 'new_entity', 'new_item'].includes(conflict.type)) {
    const entity = replaceEntity(state, entityType, entityId, selected);
    touchResolvedEntity(entity, null, revision, at);
    return;
  }
  const collection = collectionForEntityType(state, entityType);
  const entity = collection?.values.find((candidate) => candidate.id === entityId);
  if (entity && conflict.field) {
    entity[conflict.field] = copy(selected);
    touchResolvedEntity(entity, conflict.field, revision, at);
  }
}

export function resolveConflict(state, conflictId, choice, at = isoNow()) {
  const localChoice = ['local', 'keep_local', 'keep_edit'].includes(choice);
  const remoteChoice = ['remote', 'keep_cloud', 'keep_delete'].includes(choice);
  if (!localChoice && !remoteChoice) return { ok: false, reason: 'invalid' };
  const working = copy(state);
  const index = working.conflicts.findIndex((conflict) => conflict.id === conflictId);
  if (index < 0) return { ok: false, reason: 'missing' };
  const conflict = working.conflicts[index];
  const selected = localChoice ? conflict.localState : conflict.remoteState;
  const rejected = localChoice ? conflict.remoteState : conflict.localState;
  const revision = Number(working.meta.revision ?? 0) + 1;
  applyConflictChoice(working, conflict, selected, revision, at);
  working.conflicts.splice(index, 1);
  working.meta.revision = revision;
  working.meta.updatedAt = at;
  working.history.push({
    id: newId('hist'),
    itemId: conflict.itemId ?? (conflict.entityType === 'item' || conflict.entityType === 'today' ? conflict.entityId : null),
    type: 'conflict_resolved',
    metadata: {
      entityType: conflict.entityType ?? 'item',
      entityId: conflict.entityId ?? conflict.itemId ?? null,
      field: conflict.field ?? null,
      choice: localChoice ? 'local' : 'remote',
    },
    at,
  });
  working.conflictArchive.push({
    id: newId('archive'),
    conflictId,
    itemId: conflict.itemId ?? null,
    entityType: conflict.entityType ?? 'item',
    entityId: conflict.entityId ?? conflict.itemId ?? null,
    field: conflict.field ?? null,
    type: conflict.type,
    chosenState: localChoice ? 'local' : 'remote',
    rejectedState: copy(rejected),
    baseRevision: working.meta.baseRevision,
    resolvedAt: at,
    purgeAfter: new Date(new Date(at).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    structuralSnapshot: ['parent', 'order'].includes(conflict.type) ? {
      group: copy(conflict.group),
      baseState: copy(conflict.baseState),
      chosenState: copy(selected),
    } : null,
  });
  const errors = validateState(working);
  if (errors.length) return { ok: false, reason: errors.some((error) => error.type === 'hierarchy_cycle') ? 'cycle' : 'validation', errors };
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, working);
  return { ok: true, conflict };
}

export function syncValidation(state) {
  return validateState(state).map((error) => ({ ...error, source: 'sync' }));
}

export function pendingConflicts(state) {
  return (state.conflicts ?? []).filter((conflict) => conflict.status !== 'resolved');
}

export function canPushState(state) {
  if (state.meta?.recoveryMode) return { ok: false, reason: 'recovery' };
  const conflicts = pendingConflicts(state);
  return conflicts.length ? { ok: false, reason: 'unresolved_conflicts', count: conflicts.length } : { ok: true, count: 0 };
}

function sanitizedCloudSettings(settings) {
  return {
    ...copy(settings),
    cloudSync: {
      enabled: false,
      clientId: '',
      authorized: false,
      status: 'disabled',
      accountId: null,
      fileId: null,
      selectedDatasetId: null,
      datasetFiles: {},
      availableDatasets: [],
      backupFolderId: null,
      visibleBackups: [],
      lastSyncAt: null,
    },
  };
}

export function buildSyncPayload(state) {
  const gate = canPushState(state);
  if (!gate.ok) {
    const error = new Error(gate.reason);
    error.code = gate.reason;
    error.conflictCount = gate.count ?? 0;
    throw error;
  }
  const payload = copy(state);
  delete payload.meta.syncBaseState;
  payload.meta.recoveryMode = false;
  payload.meta.recoveryContext = null;
  payload.settings = sanitizedCloudSettings(payload.settings);
  payload.syncChanges = [];
  payload.conflicts = [];
  payload.migrationSnapshots = [];
  payload.recoverySnapshots = [];
  payload.diagnostics = { events: [], errors: [], aggregates: {} };
  payload.performance = [];
  payload.capabilities = {};
  return { identity: buildSyncIdentity(state), state: payload };
}

export function hasIndependentBackup(state) {
  const metadataBackup = (state.backupMeta ?? []).some((backup) => backup.scope === 'full' && backup.independentlyRestorable === true && backup.deletedAt == null);
  const managedCloudBackup = (state.settings?.cloudSync?.visibleBackups ?? []).some((file) => file.appProperties?.scope === 'full' && file.appProperties?.datasetId === state.meta.datasetId);
  return metadataBackup || managedCloudBackup;
}

export function datasetSwitchGate(state, { riskAccepted = false } = {}) {
  const backedUp = hasIndependentBackup(state);
  if (backedUp) return { allowed: true, backedUp: true, requiresWarning: false, requiresRiskAcknowledgement: false };
  if (riskAccepted) return { allowed: true, backedUp: false, requiresWarning: true, requiresRiskAcknowledgement: false };
  return { allowed: false, backedUp: false, requiresWarning: true, requiresRiskAcknowledgement: true, reason: 'backup_required' };
}

export function prepareDatasetSwitch(currentInput, incomingInput, { riskAccepted = false, at = isoNow() } = {}) {
  const current = normalizeState(currentInput);
  const gate = datasetSwitchGate(current, { riskAccepted });
  if (!gate.allowed) return { ok: false, reason: gate.reason, gate, state: copy(currentInput) };
  const incoming = normalizeState(incomingInput);
  const safety = {
    id: newId('switch_snapshot'),
    kind: 'dataset_switch',
    fromVersion: current.meta.schemaVersion,
    toVersion: incoming.meta.schemaVersion,
    sourceDatasetId: current.meta.datasetId,
    targetDatasetId: incoming.meta.datasetId,
    createdAt: at,
    purgeAfter: new Date(new Date(at).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    state: copy(current),
  };
  incoming.recoverySnapshots = [...(incoming.recoverySnapshots ?? []), safety];
  return { ok: true, state: incoming, safety, gate };
}

export class DriveRequestError extends Error {
  constructor(message, status, cause = null) {
    super(message);
    this.name = 'DriveRequestError';
    this.status = status;
    this.cause = cause;
  }
}

function escapeDriveQuery(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

export class GoogleDriveSync {
  constructor({
    clientId = '',
    datasetFileName = 'progress-tracker-sync.json',
    backupFolderName = 'Progress Tracker Backups',
    fetchImpl = globalThis.fetch?.bind(globalThis),
  } = {}) {
    this.clientId = clientId;
    this.datasetFileName = datasetFileName;
    this.backupFolderName = backupFolderName;
    this.fetchImpl = fetchImpl;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.client = null;
    this.status = 'disabled';
    this.lastError = null;
  }

  configure(clientId) {
    this.clientId = String(clientId ?? '').trim();
    this.status = this.clientId ? 'configured' : 'disabled';
    return this.status;
  }

  canAuthorize() {
    return Boolean(this.clientId && globalThis.google?.accounts?.oauth2);
  }

  async authorize() {
    if (!this.clientId) throw new Error('Google OAuth Client ID is required');
    if (!globalThis.google?.accounts?.oauth2) throw new Error('Google Identity Services is not available');
    const token = await new Promise((resolve, reject) => {
      this.client = google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file',
        callback: resolve,
        error_callback: reject,
      });
      this.client.requestAccessToken({ prompt: this.accessToken ? '' : 'consent' });
    });
    if (!token?.access_token) throw new Error('Google authorization returned no access token');
    this.accessToken = token.access_token;
    this.tokenExpiresAt = Date.now() + Number(token.expires_in ?? 3600) * 1000;
    this.status = 'authorized';
    return { ok: true, expiresAt: this.tokenExpiresAt };
  }

  logout() {
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.status = this.clientId ? 'configured' : 'disabled';
  }

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
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt) throw new DriveRequestError('Google Drive authorization is required', 401);
    if (!this.fetchImpl) throw new DriveRequestError('Fetch is not available', 0);
    let response;
    try {
      response = await this.fetchImpl(url, {
        ...options,
        headers: { Authorization: `Bearer ${this.accessToken}`, ...(options.headers ?? {}) },
      });
    } catch (error) {
      throw new DriveRequestError('Google Drive request failed', 0, error);
    }
    if (!response.ok) throw new DriveRequestError(`Google Drive request failed (${response.status})`, response.status);
    return response;
  }

  async fileMetadata(fileId) {
    const response = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,modifiedTime,trashed,appProperties`);
    return response.json();
  }

  async listDatasetFiles() {
    const query = encodeURIComponent(`name = '${escapeDriveQuery(this.datasetFileName)}' and 'appDataFolder' in parents and trashed = false`);
    const response = await this.request(`https://www.googleapis.com/drive/v3/files?q=${query}&spaces=appDataFolder&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime,trashed,appProperties)`);
    const list = await response.json();
    return (list.files ?? []).filter((file) => file.trashed !== true);
  }

  async pullFile(file, expectedDatasetId = null) {
    if (!file?.id) throw new DriveRequestError('Cloud dataset file is required', 400);
    const propertyDatasetId = file.appProperties?.datasetId ?? null;
    if (expectedDatasetId && propertyDatasetId && propertyDatasetId !== expectedDatasetId) {
      return { status: 'wrong_dataset', state: null, file, expectedDatasetId, actualDatasetId: propertyDatasetId };
    }
    const content = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`);
    const payload = await content.json();
    const payloadDatasetId = payload.identity?.datasetId ?? payload.state?.meta?.datasetId ?? payload.meta?.datasetId ?? null;
    const actualDatasetId = propertyDatasetId ?? payloadDatasetId;
    if ((expectedDatasetId && actualDatasetId !== expectedDatasetId) || (propertyDatasetId && payloadDatasetId && propertyDatasetId !== payloadDatasetId)) {
      return { status: 'wrong_dataset', state: null, file, expectedDatasetId, actualDatasetId };
    }
    return { status: 'remote', state: normalizeState(payload.state ?? payload), file: { ...file, appProperties: { ...(file.appProperties ?? {}), datasetId: actualDatasetId } } };
  }

  async pull(expectedDatasetId = null, persistedFileId = null) {
    if (persistedFileId) {
      try {
        const persisted = await this.fileMetadata(persistedFileId);
        if (persisted.trashed !== true) {
          const persistedDatasetId = persisted.appProperties?.datasetId ?? null;
          if (!expectedDatasetId || persistedDatasetId === expectedDatasetId) return this.pullFile(persisted, expectedDatasetId);
        }
      } catch (error) {
        if (!(error instanceof DriveRequestError) || error.status !== 404) throw error;
      }
    }
    const files = await this.listDatasetFiles();
    if (!files.length) return { status: 'empty', state: null, file: null, files: [] };
    if (expectedDatasetId) {
      const matches = files.filter((file) => file.appProperties?.datasetId === expectedDatasetId);
      if (matches.length === 1) return this.pullFile(matches[0], expectedDatasetId);
      if (matches.length > 1) return { status: 'dataset_choice', state: null, file: null, files: matches, expectedDatasetId, reason: 'duplicate_dataset_files' };
      return { status: 'dataset_choice', state: null, file: null, files, expectedDatasetId, reason: 'dataset_not_found' };
    }
    if (files.length === 1) return this.pullFile(files[0], null);
    return { status: 'dataset_choice', state: null, file: null, files, expectedDatasetId: null, reason: 'multiple_datasets' };
  }

  async push(state, fileId = null) {
    const gate = canPushState(state);
    if (!gate.ok) {
      const error = new Error(gate.reason);
      error.code = gate.reason;
      error.conflictCount = gate.count ?? 0;
      throw error;
    }
    if (fileId) {
      const metadata = await this.fileMetadata(fileId);
      const actualDatasetId = metadata.appProperties?.datasetId ?? null;
      if (actualDatasetId && actualDatasetId !== state.meta.datasetId) {
        const error = new Error('dataset_mismatch');
        error.code = 'dataset_mismatch';
        throw error;
      }
    }
    const payload = JSON.stringify(buildSyncPayload(state));
    const metadata = {
      name: this.datasetFileName,
      mimeType: 'application/json',
      appProperties: { datasetId: state.meta.datasetId, revision: String(state.meta.revision), kind: 'progress_tracker_dataset' },
      ...(fileId ? {} : { parents: ['appDataFolder'] }),
    };
    const boundary = `progress_tracker_${Date.now()}`;
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n--${boundary}--`;
    const endpoint = fileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id,name,modifiedTime,appProperties`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime,appProperties';
    const response = await this.request(endpoint, {
      method: fileId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    return { status: 'saved', file: await response.json() };
  }

  async deleteDataset(fileId) {
    if (!fileId) throw new Error('Cloud dataset file is required');
    await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    return { status: 'deleted' };
  }

  async ensureVisibleBackupFolder(datasetId, folderId = null) {
    if (folderId) return { id: folderId, name: this.backupFolderName };
    const query = encodeURIComponent(`name = '${escapeDriveQuery(this.backupFolderName)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
    const response = await this.request(`https://www.googleapis.com/drive/v3/files?q=${query}&spaces=drive&fields=files(id,name,appProperties)`);
    const list = await response.json();
    const existing = list.files?.find((file) => file.appProperties?.datasetId === datasetId && file.appProperties?.kind === 'progress_tracker_backup_folder');
    if (existing) return existing;
    const created = await this.request('https://www.googleapis.com/drive/v3/files?fields=id,name,appProperties', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: this.backupFolderName,
        mimeType: 'application/vnd.google-apps.folder',
        appProperties: { datasetId, kind: 'progress_tracker_backup_folder' },
      }),
    });
    return created.json();
  }

  async listVisibleBackups(datasetId, folderId = null) {
    if (!folderId) return { folder: null, files: [] };
    const query = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const response = await this.request(`https://www.googleapis.com/drive/v3/files?q=${query}&spaces=drive&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime,size,mimeType,appProperties)`);
    const list = await response.json();
    return {
      folder: { id: folderId, name: this.backupFolderName },
      files: (list.files ?? []).filter((file) => file.appProperties?.datasetId === datasetId && file.appProperties?.scope === 'full'),
    };
  }

  async pushVisibleBackup(ptmd, fileName, datasetId, folderId = null) {
    const folder = await this.ensureVisibleBackupFolder(datasetId, folderId);
    const boundary = `progress_tracker_backup_${Date.now()}`;
    const metadata = {
      name: fileName,
      mimeType: 'text/markdown',
      parents: [folder.id],
      appProperties: { datasetId, scope: 'full', format: 'PTMD' },
    };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/markdown\r\n\r\n${ptmd}\r\n--${boundary}--`;
    const response = await this.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime,size,mimeType,appProperties', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    return { folder, file: await response.json() };
  }

  async pullVisibleBackup(fileId) {
    if (!fileId) throw new Error('Visible backup file is required');
    const response = await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`);
    return response.text();
  }
}
