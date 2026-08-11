function append(map, key, value) {
  const entries = map.get(key);
  if (entries) entries.push(value);
  else map.set(key, [value]);
}

export function createEngineIndex(state) {
  const itemById = new Map();
  const categoryById = new Map();
  const childrenByParent = new Map();
  const itemsByCategory = new Map();
  const historyByItem = new Map();
  const remindersByItem = new Map();
  const conflictsByItem = new Map();

  for (const category of state.categories) categoryById.set(category.id, category);
  for (const item of state.items) {
    itemById.set(item.id, item);
    append(childrenByParent, item.parentId, item);
    append(itemsByCategory, item.categoryId, item);
  }
  for (const entry of state.history) append(historyByItem, entry.itemId, entry);
  for (const reminder of state.reminders) append(remindersByItem, reminder.itemId, reminder);
  for (const conflict of state.conflicts) if (conflict.itemId) append(conflictsByItem, conflict.itemId, conflict);

  return {
    state,
    itemById,
    categoryById,
    childrenByParent,
    itemsByCategory,
    historyByItem,
    remindersByItem,
    conflictsByItem,
    dueByItem: new Map(),
    plannedStartByItem: new Map(),
    pathByItem: new Map(),
    progressByItem: new Map(),
    progressResultByItem: new Map(),
  };
}
