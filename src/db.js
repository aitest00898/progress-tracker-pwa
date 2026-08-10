import { makeEmptyState, normalizeState } from './schema.js';

export const DB_NAME = 'progress-tracker-local';
export const DB_VERSION = 1;
export const STORE_NAMES = ['meta', 'categories', 'items', 'history', 'reminders', 'today', 'settings', 'smartOrders', 'syncChanges', 'conflicts', 'conflictArchive', 'deleted', 'backupMeta', 'migrationSnapshots', 'recoverySnapshots', 'diagnostics', 'performance', 'capabilities'];
export const SINGLETON_STORES = ['meta', 'today', 'settings', 'smartOrders', 'diagnostics', 'capabilities'];
export const ARRAY_STORES = ['categories', 'items', 'history', 'reminders', 'syncChanges', 'conflicts', 'conflictArchive', 'deleted', 'backupMeta', 'migrationSnapshots', 'recoverySnapshots', 'performance'];

export class StorageError extends Error {
  constructor(message, cause) { super(message); this.name = 'StorageError'; this.cause = cause; }
}

export function openDatabase(name = DB_NAME) {
  if (!globalThis.indexedDB) return Promise.reject(new StorageError('IndexedDB is not available'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of STORE_NAMES) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new StorageError('IndexedDB open failed', request.error));
    request.onblocked = () => reject(new StorageError('IndexedDB upgrade is blocked'));
  });
}

function oneRecord(key, value) { return { key, value }; }

function recordKey(store, value, index) {
  return value?.id ?? value?.key ?? `${store}_${index}`;
}

function recordMaps(inputState) {
  const state = normalizeState(inputState);
  const maps = Object.fromEntries(STORE_NAMES.map((store) => [store, new Map()]));
  for (const store of SINGLETON_STORES) maps[store].set('root', oneRecord('root', state[store]));
  for (const store of ARRAY_STORES) {
    (state[store] ?? []).forEach((value, index) => {
      const key = recordKey(store, value, index);
      maps[store].set(key, oneRecord(key, value));
    });
  }
  return maps;
}

function sameRecord(left, right) {
  return JSON.stringify(left?.value) === JSON.stringify(right?.value);
}

export function planStateChanges(beforeState, afterState) {
  const before = recordMaps(beforeState);
  const after = recordMaps(afterState);
  const stores = {};
  let putCount = 0;
  let deleteCount = 0;
  for (const store of STORE_NAMES) {
    const puts = [];
    const deletes = [];
    for (const [key, record] of after[store]) {
      if (!sameRecord(before[store].get(key), record)) puts.push(record);
    }
    for (const key of before[store].keys()) if (!after[store].has(key)) deletes.push(key);
    if (puts.length || deletes.length) {
      stores[store] = { puts, deletes };
      putCount += puts.length;
      deleteCount += deletes.length;
    }
  }
  return { stores, putCount, deleteCount, operationCount: putCount + deleteCount };
}

export function loadState(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAMES, 'readonly');
    const requests = Object.fromEntries(STORE_NAMES.map((store) => [store, tx.objectStore(store).getAll()]));
    tx.oncomplete = async () => {
      try {
        const values = Object.fromEntries(Object.entries(requests).map(([store, request]) => [store, request.result ?? []]));
        const root = values.meta.find((record) => record.key === 'root')?.value;
        const hasPersistedRecords = Object.values(values).some((records) => records.length > 0);
        if (!root && !hasPersistedRecords) {
          const initial = makeEmptyState();
          await saveState(db, initial);
          resolve(initial);
          return;
        }
        const state = normalizeState(root ? { meta: root } : makeEmptyState());
        for (const store of STORE_NAMES) {
          if (['meta', 'today', 'settings', 'smartOrders'].includes(store)) continue;
          if (store === 'categories') state.categories = values[store].map((record) => record.value);
          else if (store === 'items') state.items = values[store].map((record) => record.value);
          else if (store === 'history') state.history = values[store].map((record) => record.value);
          else if (store === 'reminders') state.reminders = values[store].map((record) => record.value);
          else if (store === 'syncChanges') state.syncChanges = values[store].map((record) => record.value);
          else if (store === 'conflicts') state.conflicts = values[store].map((record) => record.value);
          else if (store === 'conflictArchive') state.conflictArchive = values[store].map((record) => record.value);
          else if (store === 'deleted') state.deleted = values[store].map((record) => record.value);
          else if (store === 'backupMeta') state.backupMeta = values[store].map((record) => record.value);
          else if (store === 'migrationSnapshots') state.migrationSnapshots = values[store].map((record) => record.value);
          else if (store === 'recoverySnapshots') state.recoverySnapshots = values[store].map((record) => record.value);
          else if (store === 'diagnostics') state.diagnostics = values[store].find((record) => record.key === 'root')?.value ?? state.diagnostics;
          else if (store === 'performance') state.performance = values[store].map((record) => record.value);
          else if (store === 'capabilities') state.capabilities = values[store].find((record) => record.key === 'root')?.value ?? state.capabilities;
        }
        state.today = values.today.find((record) => record.key === 'root')?.value ?? state.today;
        state.settings = values.settings.find((record) => record.key === 'root')?.value ?? state.settings;
        state.smartOrders = values.smartOrders.find((record) => record.key === 'root')?.value ?? state.smartOrders;
        if (!root) state.meta.schemaVersion = 0;
        resolve(normalizeState(state));
      } catch (error) { reject(new StorageError('IndexedDB state read failed', error)); }
    };
    tx.onerror = () => reject(new StorageError('IndexedDB state read transaction failed', tx.error));
  });
}

export function saveState(db, inputState) {
  return new Promise((resolve, reject) => {
    const state = normalizeState(inputState);
    const tx = db.transaction(STORE_NAMES, 'readwrite');
    for (const store of STORE_NAMES) tx.objectStore(store).clear();
    tx.objectStore('meta').put(oneRecord('root', state.meta));
    tx.objectStore('today').put(oneRecord('root', state.today));
    tx.objectStore('settings').put(oneRecord('root', state.settings));
    tx.objectStore('smartOrders').put(oneRecord('root', state.smartOrders));
    tx.objectStore('diagnostics').put(oneRecord('root', state.diagnostics));
    tx.objectStore('capabilities').put(oneRecord('root', state.capabilities));
    for (const store of ARRAY_STORES) for (const [index, value] of (state[store] ?? []).entries()) {
      const id = recordKey(store, value, index);
      tx.objectStore(store).put(oneRecord(id, value));
    }
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(new StorageError('IndexedDB state write failed', tx.error));
    tx.onabort = () => reject(new StorageError('IndexedDB state write aborted', tx.error));
  });
}

export function saveStateChanges(db, beforeState, afterState) {
  const plan = planStateChanges(beforeState, afterState);
  const stores = Object.keys(plan.stores);
  if (!stores.length) return Promise.resolve(plan);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    for (const [store, operations] of Object.entries(plan.stores)) {
      const objectStore = tx.objectStore(store);
      for (const key of operations.deletes) objectStore.delete(key);
      for (const record of operations.puts) objectStore.put(record);
    }
    tx.oncomplete = () => resolve(plan);
    tx.onerror = () => reject(new StorageError('IndexedDB incremental write failed', tx.error));
    tx.onabort = () => reject(new StorageError('IndexedDB incremental write aborted', tx.error));
  });
}

export function saveMigrationSnapshot(db, snapshot) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['migrationSnapshots'], 'readwrite');
    tx.objectStore('migrationSnapshots').put(oneRecord(snapshot.id, snapshot));
    tx.oncomplete = () => resolve(snapshot);
    tx.onerror = () => reject(new StorageError('Migration safety snapshot write failed', tx.error));
    tx.onabort = () => reject(new StorageError('Migration safety snapshot write aborted', tx.error));
  });
}

export async function deleteDatabase(name = DB_NAME) {
  if (!globalThis.indexedDB) throw new StorageError('IndexedDB is not available');
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve(); request.onerror = () => reject(new StorageError('IndexedDB delete failed', request.error)); request.onblocked = () => reject(new StorageError('IndexedDB delete is blocked'));
  });
}
