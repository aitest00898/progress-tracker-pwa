import { t, documentShell, formatDate, formatDateTime, relativeDueText } from './i18n.js';
import { nextThemePreference, resolveTheme } from './appearance.js';
import { clone, dateKey, isoNow, makeEmptyState, newId } from './schema.js';
import {
  addReminder, addToToday, ancestorsOf, applyDailyRollover, attentionScore, canMove, childrenOf, completionNeedsConfirmation,
  createCategory, createItem, dateWarnings, descendantsOf, derivedTodayItems, duplicateSubtree, effectiveDue, effectivePlannedStart,
  estimateCompletion, getCategory, getItem, importanceMultiplier, isStale, itemPath, lastMeaningfulActivity, markTodayCompletion, createEngineIndex,
  momentumScore, moveImpact, moveSubtree, pathString, progressForItem, purgeDeleted, recordHistory, removeFromToday, removeReminder, renameCategory,
  renameItem, reorderCategories, reorderSiblings, reminderCenter, reminderOccurrence, reminderState, routineSuggestion, searchItems,
  setDue, setImportance, setItemStatus, setNotes, setPriority, setTags, siblingItems, softDeleteCategory, softDeleteItem, snoozeReminder,
  smartViewItems, suppressReminderToday, updateReminder, restoreDeleted, reorderSmartView, reminderPatternSuggestion, dueImpactOnRemoval,
} from './engine.js';
import { renderMarkdown } from './markdown.js';
import { VirtualList } from './virtual-list.js';
import { treeRowClassNames, treeRowMetrics, treeRowSemantics } from './tree-view.js';
import { downloadText } from './storage.js';
import { browserStorageEstimate, storageBreakdown } from './storage-metrics.js';
import { exportPTMD, parsePTMD, previewImport, applyImportPreview, restorePreview } from './ptmd.js';
import { diagnosticReport, dataHealth, recordError, recordPerformance, recordSemantic, capabilityReport, clearDiagnostics } from './diagnostics.js';
import {
  canPushState, datasetSwitchGate, GoogleDriveSync, mergeDatasets, prepareDatasetSwitch, resolveConflict,
} from './sync.js';
import { restoreMigrationSnapshot } from './migration.js';

const root = document.querySelector('#app');
let repository;
let renderScheduled = false;
let activeVirtualList = null;
let renderEngineIndex = null;
let renderNow = new Date();
let initialised = false;
const driveSync = new GoogleDriveSync();
let syncTimer = null;
let syncInFlight = false;
const ui = {
  page: 'categories', categoryId: null, smartView: 'today', settingsPage: 'general', detailId: null,
  search: '', tag: '', quickActionId: null, expanded: new Set(), focusRoot: null, notesTab: 'edit',
  modal: null, toast: null, importPreview: null, restorePreview: null, contextItemId: null, continuousCreate: true,
  dragItemId: null, dragCategoryId: null, selectedDeleted: new Set(), moveItemId: null, duplicateItemId: null,
  dragTargetId: null,
  routineSuggestionId: null, reminderCenter: false,
  highlightId: null,
};

function currentState() { return repository.getState(); }
function renderIndex(state) { return renderEngineIndex?.state === state ? renderEngineIndex : createEngineIndex(state); }
function language() { return currentState()?.settings?.language === 'en' ? 'en' : 'zh-TW'; }
function tr(key, vars) { return t(language(), key, vars); }

function node(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  let deferredValue;
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key === 'html') element.innerHTML = value;
    else if (key === 'style' && typeof value === 'object') {
      for (const [property, propertyValue] of Object.entries(value)) {
        if (property.startsWith('--')) element.style.setProperty(property, propertyValue);
        else element.style[property] = propertyValue;
      }
    }
    else if (key === 'dataset' && typeof value === 'object') Object.assign(element.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'ariaLabel') element.setAttribute('aria-label', value);
    else if (key === 'title') element.title = value;
    else if (key === 'disabled') element.disabled = Boolean(value);
    else if (key === 'checked') element.checked = Boolean(value);
    else if (key === 'value') deferredValue = value;
    else element.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  if (deferredValue !== undefined) element.value = deferredValue;
  return element;
}

function icon(glyph, label) { return node('span', { class: 'icon', ariaLabel: label, title: label, role: 'img' }, glyph); }
function button(label, onClick, options = {}) {
  return node('button', { type: 'button', class: options.className ?? 'button', ariaLabel: options.ariaLabel ?? label, title: options.title, disabled: options.disabled, onClick }, options.icon ? icon(options.icon, options.ariaLabel ?? label) : null, options.text === false ? null : label);
}
function iconButton(glyph, label, onClick, options = {}) {
  const className = ['icon-button', options.className].filter(Boolean).join(' ');
  return button(label, onClick, { ...options, className, icon: glyph, text: false });
}
function heading(text, level = 2, className = '') { return node(`h${level}`, { class: className }, text); }
function setText(element, text) { element.textContent = text; return element; }
function stop(event) { event.preventDefault(); event.stopPropagation(); }

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => { renderScheduled = false; render(); });
}

function toast(message, kind = 'success', undo) {
  ui.toast = { message, kind, undo };
  scheduleRender();
  setTimeout(() => { if (ui.toast?.message === message) { ui.toast = null; scheduleRender(); } }, 5000);
}

function scheduleCloudSync(delay = 1200) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = null; void syncNow({ automatic: true }); }, delay);
}

function reasonMessage(reason) {
  const map = { required: 'errorRequired', invalid_category: 'errorNoCategory', invalid_parent: 'errorCycle', cycle: 'errorCycle', max: 'errorMaxReminders', no_due: 'relativeReminderNoDue', recovery: 'errorRecovery', validation: 'errorGeneric', storage: 'errorGeneric', exception: 'errorGeneric', invalid: 'errorGeneric', missing: 'errorGeneric' };
  return tr(map[reason] ?? 'errorGeneric');
}

async function mutate(label, mutator, successKey = null, options = {}) {
  const result = await repository.update(label, mutator, options);
  if (!result.ok) {
    if (result.reason === 'validation' && currentState().settings.developerEnabled) {
      await repository.update('diagnostic_validation_failure', (draft) => { recordError(draft, new Error('State validation failed'), 'mutation'); return { ok: true }; }, null, { queue: false });
    }
    toast(reasonMessage(result.reason), 'error');
    return result;
  }
  if (successKey) toast(tr(successKey));
  if (options.queue !== false) scheduleCloudSync();
  scheduleRender();
  return result;
}

function localDateInput(iso) { return iso ? new Date(iso).toISOString().slice(0, 10) : ''; }
function dateFromInput(value) { return value ? new Date(`${value}T12:00:00`).toISOString() : null; }
function priorityColor(priority) { return { none: 'var(--border-subtle)', low: 'var(--priority-low)', medium: 'var(--priority-medium)', high: 'var(--priority-high)' }[priority] ?? 'var(--border-subtle)'; }
function priorityLabel(priority) { return tr(priority === 'none' ? 'noPriority' : priority); }
function statusLabel(status) { return tr({ active: 'statusActive', completed: 'statusCompleted', skipped: 'statusSkipped', deleted: 'statusDeleted' }[status] ?? 'unknown'); }
function fieldLabel(field) { return tr({ title: 'itemTitle', status: 'status', categoryId: 'categoryName', parentId: 'selectParent', activeOrder: 'itemOrderSaved', completedOrder: 'itemOrderSaved', priority: 'priority', importance: 'importance', plannedStart: 'plannedStart', dueMode: 'dueDate', dueDate: 'dueDate', notes: 'notes', tags: 'tags' }[field] ?? 'syncConflict'); }
function itemHasConflict(state, itemId) { return state.conflicts.some((conflict) => conflict.itemId === itemId); }
function blockConflictedEdit() { openInfoModal(tr('conflictEditBlocked')); }
function activityLabel(type) { return tr({ created: 'activityCreated', edited: 'activityEdited', completed: 'activityCompleted', reopened: 'activityReopened', skipped: 'activitySkipped', deleted: 'activityDeleted', restored: 'activityRestored', moved: 'activityMoved', due_changed: 'activityDueChanged', priority_changed: 'activityPriorityChanged', importance_changed: 'activityImportanceChanged', reminder_changed: 'activityReminderChanged', note_edited: 'activityNoteEdited', tag_changed: 'activityTagChanged', today_added: 'todayAdded', today_removed: 'todayRemoved', reordered: 'itemOrderSaved', conflict_resolved: 'activityConflictResolved' }[type] ?? 'activityEdited'); }

function focusRootForCategory(state, categoryId) { return ui.focusRoot ?? state.settings.focusByCategory?.[categoryId] ?? null; }

function setFocus(categoryId, itemId) {
  ui.focusRoot = itemId;
  mutate('focus_changed', (state) => { state.settings.focusByCategory[categoryId] = itemId; recordSemantic(state, 'focus_changed', { page: 'categories' }); return { ok: true }; }, null, { queue: false });
}

function clearFocus(categoryId) {
  ui.focusRoot = null;
  mutate('focus_cleared', (state) => { delete state.settings.focusByCategory[categoryId]; return { ok: true }; }, null, { queue: false });
}

function bindLongPress(element, callback, { duration = 650, onStart, onCancel } = {}) {
  let timer = null; let startX = 0; let startY = 0; let triggered = false;
  const start = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    startX = event.clientX; startY = event.clientY; triggered = false; onStart?.(element);
    timer = setTimeout(() => { triggered = true; element.classList.add('long-pressed'); if (canVibrate()) navigator.vibrate(8); callback(event); }, duration);
  };
  const cancel = (event) => {
    if (timer && (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10 || event.type === 'pointerup' || event.type === 'pointercancel')) clearTimeout(timer);
    timer = null; if (!triggered) onCancel?.(element); element.classList.remove('long-pressed');
  };
  element.addEventListener('pointerdown', start);
  element.addEventListener('pointermove', cancel);
  element.addEventListener('pointerup', cancel);
  element.addEventListener('pointercancel', cancel);
  element.addEventListener('pointerleave', cancel);
}

function bindPointerReorder(handle, row, item, smartView = null) {
  let timer = null;
  let active = false;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  const clearTargets = () => { document.querySelectorAll('.item-row.drag-target').forEach((target) => target.classList.remove('drag-target')); ui.dragTargetId = null; };
  const cleanup = () => {
    clearTimeout(timer); timer = null; active = false; pointerId = null; ui.dragItemId = null; row.classList.remove('dragging'); handle.classList.remove('long-pressed'); clearTargets();
  };
  handle.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' || event.button !== 0) return;
    if (itemHasConflict(currentState(), item.id)) { blockConflictedEdit(); return; }
    pointerId = event.pointerId; startX = event.clientX; startY = event.clientY;
    timer = setTimeout(() => {
      active = true; ui.dragItemId = item.id; row.classList.add('dragging'); handle.classList.add('long-pressed');
      if (canVibrate()) navigator.vibrate(8);
      handle.setPointerCapture?.(pointerId);
    }, 650);
  });
  handle.addEventListener('pointermove', (event) => {
    if (!active) {
      if (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10) clearTimeout(timer);
      return;
    }
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.item-row');
    clearTargets();
    if (!target || target === row) return;
    const targetItem = getItem(currentState(), target.dataset.itemId);
    const allowed = smartView
      ? smartViewItems(currentState(), smartView).some((candidate) => candidate.id === targetItem?.id)
      : targetItem?.categoryId === item.categoryId && targetItem?.parentId === item.parentId && targetItem?.status === item.status;
    if (allowed) { target.classList.add('drag-target'); ui.dragTargetId = targetItem.id; }
  });
  handle.addEventListener('pointerup', (event) => {
    if (!active) { clearTimeout(timer); timer = null; return; }
    const targetId = ui.dragTargetId;
    cleanup();
    if (!targetId || targetId === item.id) return;
    if (smartView) mutate('smart_reorder', (draft) => reorderSmartView(draft, smartView, item.id, targetId), 'itemOrderSaved');
    else mutate('reorder_siblings', (draft) => reorderSiblings(draft, item.id, targetId), 'itemOrderSaved');
  });
  handle.addEventListener('pointercancel', cleanup);
}

function bindPointerCategoryReorder(handle, row, category) {
  let timer = null;
  let active = false;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  const clearTargets = () => { document.querySelectorAll('.category-nav-row.category-drag-target').forEach((target) => target.classList.remove('category-drag-target')); ui.dragCategoryId = null; };
  const cleanup = () => {
    clearTimeout(timer); timer = null; active = false; pointerId = null;
    row.classList.remove('category-dragging'); handle.classList.remove('long-pressed'); clearTargets();
  };
  handle.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' || event.button !== 0) return;
    pointerId = event.pointerId; startX = event.clientX; startY = event.clientY;
    timer = setTimeout(() => {
      active = true; ui.dragCategoryId = category.id; row.classList.add('category-dragging'); handle.classList.add('long-pressed');
      if (canVibrate()) navigator.vibrate(8);
      handle.setPointerCapture?.(pointerId);
    }, 650);
  });
  handle.addEventListener('pointermove', (event) => {
    if (!active) {
      if (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10) clearTimeout(timer);
      return;
    }
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.category-nav-row');
    document.querySelectorAll('.category-nav-row.category-drag-target').forEach((candidate) => candidate.classList.remove('category-drag-target'));
    if (target && target !== row) target.classList.add('category-drag-target');
  });
  handle.addEventListener('pointerup', (event) => {
    if (!active) { clearTimeout(timer); timer = null; return; }
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.category-nav-row');
    const targetId = target?.dataset?.categoryId;
    cleanup();
    if (!targetId || targetId === category.id) return;
    mutate('category_reorder', (draft) => reorderCategories(draft, category.id, targetId), 'categoryReordered');
  });
  handle.addEventListener('pointercancel', cleanup);
}

function canVibrate() { return Boolean(globalThis.navigator?.vibrate) && /Android/i.test(globalThis.navigator?.userAgent ?? ''); }
function handleKeyboardShortcuts(event) {
  if (event.key === 'Escape') {
    if (ui.modal || ui.detailId) { ui.modal = null; ui.detailId = null; scheduleRender(); }
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  const editing = target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
  if (editing) return;
  if (event.key === '?' || (event.key === '/' && event.shiftKey)) { event.preventDefault(); openInfoModal(tr('keyboardShortcuts')); }
  else if (event.key === '/') { event.preventDefault(); document.querySelector('.global-search')?.focus(); }
  else if (event.key.toLowerCase() === 'n' && ui.page === 'categories') { event.preventDefault(); document.querySelector('.quick-create-input')?.focus(); }
}
function swipeHandler(element, item) {
  let startX = 0; let startY = 0; let startAt = 0; let active = false;
  element.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' || event.clientX < 28 || event.clientX > window.innerWidth - 28) return;
    startX = event.clientX; startY = event.clientY; startAt = performance.now(); active = true;
  });
  element.addEventListener('pointerup', (event) => {
    if (!active) return; active = false;
    const dx = event.clientX - startX; const dy = event.clientY - startY; const elapsed = Math.max(1, performance.now() - startAt);
    const horizontal = Math.abs(dx) >= 72 && Math.abs(dx) > Math.abs(dy) * 1.3 && Math.abs(dx / elapsed) >= 0.25;
    if (!horizontal) return;
    if (itemHasConflict(currentState(), item.id)) { blockConflictedEdit(); return; }
    element.classList.add(dx < 0 ? 'swipe-left' : 'swipe-right');
    setTimeout(() => element.classList.remove('swipe-left', 'swipe-right'), 280);
    if (dx < 0) performStatus(item, item.status === 'completed' ? 'active' : 'completed');
    else performDelete(item);
  });
  element.addEventListener('pointercancel', () => { active = false; });
}

function categoryDepthLimit() { return Math.max(2, Math.floor((window.innerWidth - (window.innerWidth < 720 ? 32 : 360)) / 145)); }

function setPage(page, value = null) {
  ui.page = page;
  if (page === 'categories' && value) { ui.categoryId = value; ui.focusRoot = null; }
  if (page === 'smart' && value) ui.smartView = value;
  ui.detailId = null; ui.contextItemId = null; ui.modal = null;
  scheduleRender();
}

function openDetail(itemId) {
  if (!getItem(currentState(), itemId)) return;
  ui.detailId = itemId;
  ui.contextItemId = null;
  mutate('detail_opened', (state) => { recordSemantic(state, 'detail_opened', { page: 'detail' }); return { ok: true }; }, null, { queue: false });
  scheduleRender();
}

function focusItem(item) {
  const state = currentState();
  ui.page = 'categories'; ui.categoryId = item.categoryId; ui.focusRoot = item.id; ui.search = ''; ui.highlightId = item.id;
  mutate('search_focus', (draft) => {
    const expanded = new Set(draft.settings.expandedByCategory[item.categoryId] ?? []);
    for (const ancestor of itemPath(draft, item.id)) expanded.add(ancestor.id);
    draft.settings.expandedByCategory[item.categoryId] = [...expanded];
    draft.settings.focusByCategory[item.categoryId] = item.id;
    recordSemantic(draft, 'search', { result: 'focus' });
    return { ok: true };
  }, null, { queue: false });
  scheduleRender();
  setTimeout(() => { if (ui.highlightId === item.id) { ui.highlightId = null; scheduleRender(); } }, 1700);
}

function render() {
  if (!initialised || !repository?.getState()) return;
  const state = currentState();
  renderNow = new Date();
  renderEngineIndex = createEngineIndex(state);
  const shell = documentShell(language());
  document.documentElement.lang = shell.lang;
  document.title = shell.title;
  const descriptionMeta = document.querySelector('meta[name="description"]');
  if (descriptionMeta) descriptionMeta.content = shell.description;
  const manifestLink = document.querySelector('link[rel="manifest"]');
  if (manifestLink && manifestLink.getAttribute('href') !== shell.manifest) manifestLink.setAttribute('href', shell.manifest);
  const visualTheme = resolveTheme(state.settings.theme, Boolean(globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches));
  document.documentElement.dataset.theme = visualTheme;
  const themeMeta = document.querySelector('meta[name="theme-color"]'); if (themeMeta) themeMeta.content = visualTheme === 'dark' ? '#0b0b0f' : '#f2f2f7';
  const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]'); if (appleTitle) appleTitle.content = shell.title;
  activeVirtualList?.destroy();
  activeVirtualList = null;
  root.replaceChildren(renderShell(state));
}

function renderShell(state) {
  const index = renderIndex(state);
  const shell = node('div', { class: 'app-shell' });
  shell.append(renderTopbar(state));
  const recoveryMode = state.meta.recoveryMode;
  const body = node('div', { class: `app-body ${recoveryMode ? 'recovery-only' : ''}` });
  if (!recoveryMode) body.append(renderSidebar(state));
  const main = node('main', { class: 'main-content', id: 'main-content' });
  if (recoveryMode) main.append(renderRecoveryMode(state));
  else if (ui.page === 'today') main.append(renderTodayPage(state));
  else if (ui.page === 'reminders') main.append(renderReminderPage(state));
  else if (ui.page === 'smart') main.append(renderSmartPage(state));
  else if (ui.page === 'settings') main.append(renderSettingsPage(state));
  else main.append(renderCategoryPage(state));
  body.append(main);
  shell.append(body);
  if (!recoveryMode) shell.append(renderMobileNav(state));
  const detailItem = !recoveryMode && ui.detailId ? getItem(state, ui.detailId, index) : null;
  if (detailItem) shell.append(renderDetailPanel(state, detailItem));
  if (ui.modal) shell.append(renderModal(state));
  if (ui.toast) shell.append(node('div', { class: `toast toast-${ui.toast.kind}`, role: 'status' }, node('span', {}, ui.toast.message), ui.toast.undo ? button(tr('undo'), ui.toast.undo, { className: 'toast-undo' }) : null));
  return shell;
}

function renderTopbar(state) {
  const header = node('header', { class: 'topbar' });
  if (state.meta.recoveryMode) {
    header.append(
      node('div', { class: 'brand recovery-brand' }, renderBrandMark(), node('span', { class: 'brand-copy' }, node('strong', {}, tr('appName')), node('small', {}, tr('dataRecoveryMode')))),
      node('div', { class: 'topbar-recovery-spacer' }),
    );
    return header;
  }
  const brand = node('button', { class: 'brand', type: 'button', onClick: () => setPage('categories', state.settings.defaultCategoryId ?? state.categories[0]?.id) }, renderBrandMark(), node('span', { class: 'brand-copy' }, node('strong', {}, tr('appName')), node('small', {}, tr('brandTagline'))));
  const search = node('input', { class: 'global-search', type: 'search', placeholder: tr('searchPlaceholder'), value: ui.search, ariaLabel: tr('searchPlaceholder'), onInput: (event) => { ui.search = event.target.value; scheduleRender(); }, onKeydown: (event) => { if (event.key === 'Escape') { ui.search = ''; scheduleRender(); } } });
  const online = navigator.onLine;
  const storageLabel = repository.volatile ? tr('storageVolatile') : online ? tr('connectionOnline') : tr('connectionOffline');
  const status = node('span', { class: `connection-status ${online && !repository.volatile ? 'online' : 'offline'}` }, icon(online && !repository.volatile ? '●' : '○', storageLabel), storageLabel);
  const actions = node('div', { class: 'topbar-actions' }, status, iconButton('☼', tr('theme'), () => cycleTheme(state)), iconButton('⚙', tr('navSettings'), () => setPage('settings')));
  header.append(brand, node('div', { class: 'topbar-search' }, search), actions);
  return header;
}

function renderBrandMark() {
  return node('span', { class: 'brand-mark', ariaLabel: tr('appName'), role: 'img' }, node('img', { src: './icon-192.png', alt: '' }));
}

function cycleTheme(state) {
  const next = nextThemePreference(state.settings.theme);
  updateSetting('theme_changed', (settings) => { settings.theme = next; }, 'themeChanged');
}

function renderSidebar(state) {
  const aside = node('aside', { class: 'sidebar' });
  aside.append(node('div', { class: 'sidebar-section-title' }, tr('navCategories')), button(tr('addCategory'), () => openCategoryCreate(), { className: 'sidebar-add', icon: '+' }));
  const categoryList = node('div', { class: 'category-list' });
  for (const category of [...state.categories].sort((a, b) => a.order - b.order)) categoryList.append(renderCategoryNav(state, category));
  aside.append(categoryList);
  aside.append(node('div', { class: 'sidebar-divider' }), node('div', { class: 'sidebar-section-title' }, tr('navSmart')), navButton(tr('navToday'), 'today', ui.page === 'today', () => setPage('today'), '◷'), navButton(tr('navReminders'), 'reminders', ui.page === 'reminders', () => setPage('reminders'), '⌁'), navButton(tr('navSmart'), 'smart', ui.page === 'smart', () => setPage('smart', ui.smartView), '✦'));
  const footer = node('div', { class: 'sidebar-footer' }, button(tr('navSettings'), () => setPage('settings'), { className: 'nav-button', icon: '⚙' }), node('small', {}, navigator.onLine ? tr('pwaReady') : tr('connectionOffline')));
  aside.append(footer);
  return aside;
}

function navButton(label, key, active, onClick, glyph) { return button(label, onClick, { className: `nav-button ${active ? 'active' : ''}`, icon: glyph, ariaLabel: label, title: label }); }

function renderCategoryNav(state, category) {
  const index = renderIndex(state);
  const active = ui.page === 'categories' && (ui.categoryId ?? state.settings.defaultCategoryId ?? state.categories[0]?.id) === category.id;
  const itemCount = index.itemsByCategory.get(category.id)?.length ?? 0;
  const row = node('div', { class: `category-nav-row ${active ? 'active' : ''}`, draggable: 'true', dataset: { categoryId: category.id }, onDragstart: (event) => { ui.dragCategoryId = category.id; event.dataTransfer.effectAllowed = 'move'; }, onDragover: (event) => event.preventDefault(), onDrop: (event) => { event.preventDefault(); if (ui.dragCategoryId && ui.dragCategoryId !== category.id) mutate('category_reorder', (draft) => reorderCategories(draft, ui.dragCategoryId, category.id), 'categoryReordered'); } });
  const handle = node('button', { class: 'category-drag-handle', type: 'button', draggable: 'true', ariaLabel: tr('categoryDrag'), title: tr('categoryDrag'), onDragstart: (event) => { ui.dragCategoryId = category.id; event.dataTransfer.effectAllowed = 'move'; } }, '⠿');
  bindPointerCategoryReorder(handle, row, category);
  const title = node('button', { class: 'category-nav-title', type: 'button', onClick: () => setPage('categories', category.id) }, node('span', { class: 'category-dot' }, '•'), node('span', {}, category.title), node('small', {}, String(itemCount)));
  bindLongPress(title, () => openCategoryRename(category), { duration: 700 });
  row.append(handle, title, iconButton('⋮', tr('more'), (event) => { stop(event); openCategoryMenu(category); }));
  return row;
}

function renderMobileNav(state) {
  return node('nav', { class: 'mobile-nav', 'aria-label': tr('menu') }, navButton(tr('navCategories'), 'categories', ui.page === 'categories', () => setPage('categories', ui.categoryId ?? state.settings.defaultCategoryId), '▦'), navButton(tr('navToday'), 'today', ui.page === 'today', () => setPage('today'), '◷'), navButton(tr('navReminders'), 'reminders', ui.page === 'reminders', () => setPage('reminders'), '⌁'), navButton(tr('navSmart'), 'smart', ui.page === 'smart', () => setPage('smart', ui.smartView), '✦'), navButton(tr('navSettings'), 'settings', ui.page === 'settings', () => setPage('settings'), '⚙'));
}

function renderCategoryPage(state) {
  const index = renderIndex(state);
  const categoryId = ui.categoryId ?? state.settings.defaultCategoryId ?? state.categories[0]?.id;
  const category = getCategory(state, categoryId, index) ?? state.categories[0];
  if (!category) return renderEmptyState('errorNoCategory', 'addCategory', openCategoryCreate);
  ui.categoryId = category.id;
  const page = node('section', { class: 'page category-page' });
  const header = node('div', { class: 'page-header' }, node('div', { class: 'page-header-main' }, renderCategoryBreadcrumb(state, category), heading(category.title, 1), node('p', { class: 'page-subtitle' }, `${index.itemsByCategory.get(category.id)?.length ?? 0} · ${tr('swipeComplete')} · ${tr('swipeDelete')}`)), node('div', { class: 'page-header-actions' }, button(tr('addItem'), () => { ui.quickActionId = null; document.querySelector('.quick-create-input')?.focus(); }, { className: 'primary-button', icon: '+' }), iconButton('⌘', tr('keyboardShortcuts'), () => openInfoModal(tr('keyboardShortcuts')))));
  page.append(header);
  if (ui.search.trim()) page.append(renderSearchResults(state));
  else page.append(renderQuickCreate(state, category), renderTreeList(state, category));
  return page;
}

function renderCategoryBreadcrumb(state, category) {
  const index = renderIndex(state);
  const focusId = focusRootForCategory(state, category.id);
  const focus = focusId ? getItem(state, focusId, index) : null;
  const path = focus ? itemPath(state, focus.id, index) : [];
  const limit = categoryDepthLimit();
  const hidden = Math.max(0, path.length - limit);
  const crumbs = [button(category.title, () => clearFocus(category.id), { className: 'breadcrumb-link', ariaLabel: tr('focusCategoryRoot') })];
  if (focus) {
    if (hidden > 0) crumbs.push(node('span', { class: 'breadcrumb-separator' }, '›'), button('…', () => openAncestorMenu(state, focus), { className: 'breadcrumb-link', ariaLabel: tr('showAncestors'), title: tr('hiddenAncestors', { count: hidden }) }));
    for (const item of path.slice(hidden)) crumbs.push(node('span', { class: 'breadcrumb-separator' }, '›'), button(item.title, () => setFocus(category.id, item.id), { className: `breadcrumb-link ${item.id === focus.id ? 'current' : ''}` }));
  }
  return node('nav', { class: 'breadcrumbs', 'aria-label': tr('path') }, ...crumbs);
}

function renderQuickCreate(state, category) {
  const submit = () => { void createFromQuickInput(state, category.id); };
  const form = node('form', { class: 'quick-create', onSubmit: (event) => { stop(event); submit(); } });
  const input = node('input', {
    class: 'quick-create-input',
    type: 'text',
    placeholder: tr('quickCreatePlaceholder'),
    ariaLabel: tr('addItem'),
    onKeydown: (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        stop(event);
        submit();
      }
    },
  });
  const mode = node('label', { class: 'continuous-toggle' }, node('input', { type: 'checkbox', checked: ui.continuousCreate, onChange: (event) => { ui.continuousCreate = event.target.checked; } }), node('span', {}, tr('quickCreateHint')));
  const quickCreateSubmit = node('button', { type: 'submit', class: 'quick-create-submit', ariaLabel: tr('addItem'), title: tr('addItem') }, '+');
  form.append(quickCreateSubmit, input, button(tr('addItem'), submit, { className: 'primary-button quick-create-button' }), mode);
  return form;
}

async function createFromQuickInput(state, categoryId, parentId = null) {
  const input = document.querySelector('.quick-create-input');
  const title = input?.value?.trim();
  if (!title) { input?.focus(); toast(tr('errorRequired'), 'error'); return; }
  const result = await mutate(parentId ? 'add_child' : 'create_item', (draft) => createItem(draft, { categoryId, parentId, title }), null);
  if (result.ok) { if (input) input.value = ''; if (!ui.continuousCreate) input?.blur(); recordSemantic(currentState(), parentId ? 'add_child' : 'create', {}); input?.focus(); }
}

function flattenTree(state, categoryId, focusId = null) {
  const index = renderIndex(state);
  const focus = focusId ? getItem(state, focusId, index) : null;
  const categoryItems = index.itemsByCategory.get(categoryId) ?? [];
  const roots = focus ? [focus] : sortTreeForDisplay(state, categoryItems.filter((item) => item.parentId === null && item.status !== 'completed'), index);
  const expanded = state.settings.expandedByCategory?.[categoryId] ?? [];
  const expandedSet = new Set([...expanded, ...(focus ? [focus.id] : [])]);
  const result = [];
  const visit = (item, depth, siblingIndex = 0, siblingCount = 1) => {
    result.push({ kind: 'item', item, depth, siblingIndex, siblingCount });
    if (!expandedSet.has(item.id)) return;
    const children = childrenOf(state, item.id, index);
    const activeChildren = sortTreeForDisplay(state, children.filter((candidate) => candidate.status !== 'completed'), index);
    activeChildren.forEach((child, childIndex) => visit(child, depth + 1, childIndex, activeChildren.length));
    const completedChildren = children.filter((candidate) => candidate.status === 'completed').sort((a, b) => a.completedOrder - b.completedOrder);
    if (completedChildren.length) {
      result.push({ kind: 'section', label: tr('completedItems'), count: completedChildren.length, depth: depth + 1 });
      completedChildren.forEach((child, childIndex) => visit(child, depth + 1, childIndex, completedChildren.length));
    }
  };
  roots.forEach((item, itemIndex) => visit(item, 0, itemIndex, roots.length));
  const completedRoots = categoryItems.filter((item) => item.parentId === (focus?.id ?? null) && item.status === 'completed').sort((a, b) => a.completedOrder - b.completedOrder);
  if (completedRoots.length && !focus) {
    result.push({ kind: 'section', label: tr('completedItems'), count: completedRoots.length });
    completedRoots.forEach((item, itemIndex) => visit(item, 0, itemIndex, completedRoots.length));
  }
  const itemEntries = result.filter((entry) => entry.kind === 'item');
  let itemPosition = 0;
  result.forEach((entry, index) => {
    if (entry.kind !== 'item') return;
    const previous = itemEntries[itemPosition - 1];
    const next = itemEntries[itemPosition + 1];
    entry.previousDepth = previous?.depth ?? null;
    entry.nextDepth = next?.depth ?? null;
    entry.itemIndex = index;
    itemPosition += 1;
  });
  return result;
}

function sortTreeForDisplay(state, items, index = renderIndex(state)) {
  return [...items].sort((a, b) => {
    if (state.settings.smartSort && state.settings.experimental?.enabled !== false && state.settings.experimental?.smart !== false) {
      const priority = { high: 3, medium: 2, low: 1, none: 0 };
      return (priority[b.priority] - priority[a.priority]) || (attentionScore(state, b.id, renderNow, index) - attentionScore(state, a.id, renderNow, index)) || (a.activeOrder - b.activeOrder);
    }
    return (a.status === 'skipped') - (b.status === 'skipped') || a.activeOrder - b.activeOrder;
  });
}

function renderTreeList(state, category) {
  const focus = focusRootForCategory(state, category.id);
  const holder = node('div', { class: `tree-list-holder ${focus ? 'focus-view' : ''}`, 'aria-label': tr('navCategories') });
  const rows = flattenTree(state, category.id, focus);
  const maxDepth = categoryDepthLimit();
  const index = renderIndex(state);
  const treeRowOptions = (entry) => {
    if (entry.kind === 'section') return { height: 46, gap: 0 };
    const depth = entry.depth;
    const nextDepth = entry.nextDepth === null ? null : Math.min(entry.nextDepth, maxDepth);
    const semantics = treeRowSemantics({ childCount: childrenOf(state, entry.item.id, index).length, depth, sourceDepth: entry.depth, maxDepth, tree: true, siblingIndex: entry.siblingIndex, siblingCount: entry.siblingCount, nextDepth });
    return treeRowMetrics(semantics, { quickActions: ui.quickActionId === entry.item.id, hoverActions: window.innerWidth > 700 });
  };
  activeVirtualList?.destroy();
  activeVirtualList = new VirtualList(holder, {
    rowHeight: 116,
    overscan: 10,
    itemMetrics: treeRowOptions,
    renderRow: (entry) => entry.kind === 'section'
      ? node('div', { class: 'list-section-heading' }, node('span', {}, entry.label), node('small', {}, String(entry.count)))
      : renderItemRow(state, entry.item, {
        depth: entry.depth,
        maxDepth,
        nextDepth: entry.nextDepth,
        siblingIndex: entry.siblingIndex,
        siblingCount: entry.siblingCount,
        tree: true,
      }),
    empty: () => renderEmptyState('noItems', 'addItem', () => document.querySelector('.quick-create-input')?.focus()),
  });
  activeVirtualList.setItems(rows);
  return holder;
}

function renderSearchResults(state) {
  const index = renderIndex(state);
  const results = searchItems(state, ui.search, ui.tag, index);
  const tagInput = node('input', { class: 'tag-filter-input', type: 'search', placeholder: tr('filterTag'), value: ui.tag, ariaLabel: tr('filterTag'), onInput: (event) => { ui.tag = event.target.value; scheduleRender(); } });
  const section = node('section', { class: 'search-results' }, node('div', { class: 'section-toolbar' }, heading(tr('searchResults'), 2), tagInput, button(tr('clearFilter'), () => { ui.search = ''; ui.tag = ''; scheduleRender(); }, { className: 'text-button' })));
  if (!results.length) return node('div', { class: 'search-results' }, renderEmptyState('noResults', 'clearFilter', () => { ui.search = ''; scheduleRender(); }));
  const holder = node('div', { class: 'search-list-holder' });
  activeVirtualList?.destroy();
  activeVirtualList = new VirtualList(holder, { rowHeight: 116, overscan: 10, renderRow: (item) => renderItemRow(state, item, { depth: 0, tree: false, pathContext: true }), empty: () => renderEmptyState('noResults') });
  activeVirtualList.setItems(results);
  section.append(holder); return section;
}

function renderEmptyState(messageKey, actionKey = null, action = null) { return node('div', { class: 'empty-state' }, node('div', { class: 'empty-orbit' }, '◌'), heading(tr(messageKey), 2), node('p', {}, tr(`${messageKey}Hint`) === `${messageKey}Hint` ? '' : tr(`${messageKey}Hint`)), actionKey && action ? button(tr(actionKey), action, { className: 'primary-button' }) : null); }

function renderItemRow(state, item, { depth = 0, sourceDepth = depth, maxDepth = 2, tree = true, pathContext = false, smartView = null, siblingIndex = 0, siblingCount = 1, nextDepth = null } = {}) {
  const index = renderIndex(state);
  const childItems = childrenOf(state, item.id, index);
  const isParent = childItems.length > 0;
  const semantics = treeRowSemantics({ childCount: childItems.length, depth, sourceDepth, maxDepth, tree, pathContext, smartView, siblingIndex, siblingCount, nextDepth });
  const showRing = semantics.hasProgressRing;
  const progress = progressForItem(state, item.id, index.progressByItem, new Set(), index);
  const due = effectiveDue(state, item.id, index);
  const dueText = due.value ? relativeDueText(language(), due.value) : tr('noDeadline');
  const dueDate = due.value ? new Date(due.value) : null;
  const overdue = dueDate && dateKey(dueDate) < dateKey(renderNow) && item.status !== 'completed';
  const isToday = dueDate && dateKey(dueDate) === dateKey(renderNow);
  const conflict = index.conflictsByItem.has(item.id);
  const reminders = index.remindersByItem.get(item.id) ?? [];
  const expanded = state.settings.expandedByCategory?.[item.categoryId]?.includes(item.id);
  const row = node('article', {
    class: `item-row priority-${item.priority} ${treeRowClassNames(semantics)} ${item.status === 'completed' ? 'is-completed' : ''} ${ui.quickActionId === item.id ? 'quick-open' : ''} ${ui.highlightId === item.id ? 'item-highlight' : ''}`,
    style: { '--priority-color': priorityColor(item.priority), '--depth': String(semantics.depth) },
    dataset: {
      itemId: item.id,
      tree: String(semantics.isTreeRow),
      depth: String(semantics.depth),
      sourceDepth: String(semantics.sourceDepth),
      parentId: item.parentId ?? '',
      hasChildren: String(semantics.isParent),
      leaf: String(semantics.isLeaf),
      siblingIndex: String(semantics.siblingIndex),
      siblingLast: String(semantics.isLastSibling),
      nextDepth: semantics.nextDepth === null ? '' : String(semantics.nextDepth),
      treeSpacing: semantics.spacing,
    },
    draggable: 'false',
    onContextmenu: (event) => { stop(event); if (conflict) blockConflictedEdit(); else openItemMenu(item); },
    onDragover: (event) => { event.preventDefault(); row.classList.add('drag-target'); },
    onDragleave: () => row.classList.remove('drag-target'),
    onDrop: (event) => { event.preventDefault(); row.classList.remove('drag-target'); if (itemHasConflict(currentState(), item.id) || itemHasConflict(currentState(), ui.dragItemId)) { blockConflictedEdit(); return; } if (ui.dragItemId && ui.dragItemId !== item.id) { if (smartView) mutate('smart_reorder', (draft) => reorderSmartView(draft, smartView, ui.dragItemId, item.id), 'itemOrderSaved'); else mutate('reorder_siblings', (draft) => reorderSiblings(draft, ui.dragItemId, item.id), 'itemOrderSaved'); } },
  });
  const handle = node('button', { class: 'drag-handle', type: 'button', draggable: 'true', ariaLabel: tr('longPressDrag'), title: tr('longPressDrag'), onDragstart: (event) => { ui.dragItemId = item.id; event.dataTransfer.effectAllowed = 'move'; }, onDragend: () => { ui.dragItemId = null; } }, '⠿');
  bindPointerReorder(handle, row, item, smartView);
  const nextStatus = item.status === 'completed' ? 'active' : item.status === 'skipped' ? 'active' : 'completed';
  const statusButton = button(item.status === 'completed' ? '✓' : item.status === 'skipped' ? '–' : '○', () => conflict ? blockConflictedEdit() : performStatus(item, nextStatus), { className: `status-button ${item.status}`, ariaLabel: item.status === 'completed' ? tr('reopen') : item.status === 'skipped' ? tr('unskip') : tr('complete'), title: item.status === 'completed' ? tr('reopen') : item.status === 'skipped' ? tr('unskip') : tr('complete') });
  const ring = node('span', { class: 'progress-ring', style: { '--progress': `${progress}%` }, ariaLabel: tr('progressPercent', { value: progress }) }, node('span', {}, `${Math.round(progress)}%`));
  const title = node('button', { type: 'button', class: 'item-title', onClick: () => { if (pathContext) focusItem(item); else if (isParent) toggleExpanded(item); else toggleQuickActions(item.id); } }, item.title);
  bindLongPress(title, () => conflict ? blockConflictedEdit() : openRenameItem(item), { duration: 700 });
  const titleLine = node('div', { class: 'item-title-line' }, title, item.importance ? node('span', { class: 'importance-stars', title: tr('importance') }, '★'.repeat(item.importance)) : null, reminders.length ? node('span', { class: 'reminder-symbol', title: tr('reminder'), ariaLabel: tr('reminder') }, '⌁') : null, conflict ? node('span', { class: 'conflict-indicator', title: tr('syncConflict'), ariaLabel: tr('syncConflict') }, '⚠') : null);
  const path = pathContext ? node('span', { class: 'item-path-context' }, pathString(state, item.id, index)) : null;
  const meta = node('div', { class: `item-meta ${pathContext ? 'with-path' : ''}` }, node('span', { class: `due-text ${overdue ? 'overdue' : isToday ? 'today' : ''}`, title: due.source === 'inherited' ? tr('inherited') : due.source === 'explicit' ? tr('explicit') : tr('noDeadline') }, dueText), item.tags.length ? node('span', { class: 'tag-count' }, `#${item.tags.length}`) : null, path);
  const info = node('div', { class: 'item-main' }, titleLine, meta);
  const chevron = iconButton('›', tr('detail'), () => openDetail(item.id), { className: 'detail-chevron' });
  const main = node('div', { class: `item-row-main ${showRing ? 'parent' : 'leaf'} ${semantics.isTreeRow ? 'tree-row-main' : ''}`, onClick: (event) => { if (event.target.closest('button, input')) return; toggleQuickActions(item.id); } }, handle, showRing ? ring : statusButton, info, chevron);
  const actionRow = node('div', { class: 'item-actions' }, button(item.status === 'completed' ? tr('reopen') : item.status === 'skipped' ? tr('unskip') : tr('complete'), () => conflict ? blockConflictedEdit() : performStatus(item, nextStatus), { className: 'row-action', icon: item.status === 'completed' ? '↺' : '✓' }), button(tr('addChild'), () => conflict ? blockConflictedEdit() : (ui.quickActionId = item.id, ui.addChildFor = item.id, scheduleRender()), { className: 'row-action', icon: '+' }), button(state.today.items[item.id] ? tr('removeFromToday') : tr('moveToToday'), () => conflict ? blockConflictedEdit() : toggleToday(item), { className: 'row-action', icon: '◷' }), iconButton('⋯', tr('more'), (event) => { stop(event); if (conflict) blockConflictedEdit(); else openItemMenu(item); }, { className: 'row-action-more' }));
  row.append(main, actionRow);
  if (ui.quickActionId === item.id) row.append(renderQuickActionRow(state, item));
  swipeHandler(row, item);
  return row;
}

function renderQuickActionRow(state, item) {
  const row = node('div', { class: 'quick-action-row' }, node('span', { class: 'quick-action-label' }, tr('more')), button(tr('addChild'), () => itemHasConflict(state, item.id) ? blockConflictedEdit() : openChildCreate(item), { className: 'quick-action-button' }), button(state.today.items[item.id] ? tr('removeFromToday') : tr('moveToToday'), () => itemHasConflict(state, item.id) ? blockConflictedEdit() : toggleToday(item), { className: 'quick-action-button' }), node('label', { class: 'quick-priority' }, tr('priority'), node('select', { value: item.priority, ariaLabel: tr('priority'), onChange: (event) => itemHasConflict(currentState(), item.id) ? blockConflictedEdit() : mutate('priority_changed', (draft) => setPriority(draft, item.id, event.target.value) , 'priorityChanged') }, ...['none', 'low', 'medium', 'high'].map((value) => node('option', { value }, priorityLabel(value))))), button(tr('close'), () => { ui.quickActionId = null; scheduleRender(); }, { className: 'quick-action-button' }));
  return row;
}

function toggleQuickActions(itemId) {
  ui.quickActionId = ui.quickActionId === itemId ? null : itemId;
  scheduleRender();
}

function toggleExpanded(item) {
  mutate('expand_collapse', (state) => {
    const current = new Set(state.settings.expandedByCategory[item.categoryId] ?? []);
    if (current.has(item.id)) current.delete(item.id); else current.add(item.id);
    state.settings.expandedByCategory[item.categoryId] = [...current];
    recordSemantic(state, current.has(item.id) ? 'expand' : 'collapse', { page: 'categories' });
    return { ok: true };
  }, null, { queue: false });
}

async function performStatus(item, nextStatus) {
  if (itemHasConflict(currentState(), item.id)) { blockConflictedEdit(); return; }
  if (nextStatus === 'completed' && completionNeedsConfirmation(currentState(), item.id)) {
    openConfirm({ title: tr('complete'), message: tr('confirmCompleteParent'), onConfirm: () => performStatusConfirmed(item, nextStatus) });
    return;
  }
  await performStatusConfirmed(item, nextStatus);
}

async function performStatusConfirmed(item, nextStatus) {
  const result = await mutate(nextStatus === 'completed' ? 'complete' : 'reopen', (state) => {
    const outcome = setItemStatus(state, item.id, nextStatus, { force: true });
    if (outcome.ok) markTodayCompletion(state, item.id, nextStatus);
    recordSemantic(state, nextStatus === 'completed' ? 'complete' : 'reopen', { status: nextStatus });
    return outcome;
  }, nextStatus === 'completed' ? 'itemCompleted' : 'itemReopened');
  if (result.ok) ui.modal = null;
}

function performDelete(item) {
  if (itemHasConflict(currentState(), item.id)) { blockConflictedEdit(); return; }
  const hasDescendants = descendantsOf(currentState(), item.id).length > 0;
  if (hasDescendants) openConfirm({ title: tr('delete'), message: tr('confirmDeleteTree'), danger: true, onConfirm: () => deleteConfirmed(item) });
  else deleteConfirmed(item);
}

async function deleteConfirmed(item) {
  const hasDescendants = descendantsOf(currentState(), item.id).length > 0;
  const result = await mutate('delete', (state) => { const outcome = softDeleteItem(state, item.id); if (outcome.ok) recordSemantic(state, 'delete', { count: outcome.ids.length }); return outcome; }, hasDescendants ? 'deletedWithDescendants' : 'itemDeleted');
  if (result.ok) {
    const deletedId = currentState().deleted.find((entry) => entry.rootId === item.id)?.id;
    ui.detailId = null; ui.modal = null;
    toast(tr(hasDescendants ? 'deletedWithDescendants' : 'itemDeleted'), 'success', deletedId ? () => restoreById(deletedId) : null);
  }
}

async function restoreById(deletedId) { await mutate('restore', (state) => restoreDeleted(state, deletedId), 'restoredMessage'); }

function toggleToday(item) {
  if (itemHasConflict(currentState(), item.id)) { blockConflictedEdit(); return; }
  if (currentState().today.items[item.id]) mutate('remove_today', (state) => removeFromToday(state, item.id), 'todayRemoved');
  else mutate('add_today', (state) => addToToday(state, item.id), 'todayAdded');
}

function renderTodayPage(state) {
  const page = node('section', { class: 'page today-page' });
  const groups = derivedTodayItems(state, renderNow, renderIndex(state));
  const selected = ui.selectedToday ?? new Set();
  const all = [...groups.overdue, ...groups.active, ...groups.completed];
  const header = node('div', { class: 'page-header' }, node('div', { class: 'page-header-main' }, node('span', { class: 'eyebrow' }, tr('currentDate')), heading(tr('navToday'), 1), node('p', { class: 'page-subtitle' }, tr('todayEmptyHint'))), node('div', { class: 'page-header-actions' }, button(tr('complete'), () => batchToday('complete'), { className: 'secondary-button', disabled: !selected.size, icon: '✓' }), button(tr('removeFromToday'), () => batchToday('remove'), { className: 'secondary-button', disabled: !selected.size, icon: '−' })));
  page.append(header);
  if (!all.length) { page.append(renderEmptyState('todayEmpty')); return page; }
  page.append(renderTodaySection(state, tr('todayOverdue'), groups.overdue, 'overdue', true), renderTodaySection(state, tr('todayActive'), groups.active, 'active', false), renderTodaySection(state, tr('todayCompleted'), groups.completed, 'completed', false));
  return page;
}

function renderTodaySection(state, label, items, key, collapsible) {
  if (!items.length) return node('div', { class: `today-section today-${key} empty-section` });
  const expanded = key !== 'overdue' || state.settings.overdueExpanded !== false;
  const header = node('div', { class: 'section-toolbar today-section-header' }, heading(label, 2), node('span', { class: 'section-count' }, String(items.length)), collapsible ? button(expanded ? tr('collapse') : tr('expand'), () => mutate('today_section_toggle', (draft) => { draft.settings.overdueExpanded = !expanded; return { ok: true }; }, null, { queue: false }), { className: 'text-button' }) : null);
  const list = node('div', { class: 'today-list' });
  if (expanded) {
    const groups = key === 'overdue' ? overdueGroups(state, items) : [{ label: null, items }];
    for (const group of groups) {
      if (group.label) list.append(node('div', { class: 'today-deadline-group' }, group.label));
      for (const item of group.items) list.append(renderTodayRow(state, item));
    }
  }
  const section = node('section', { class: `today-section today-${key}` }, header, list);
  return section;
}

function overdueGroups(state, items) {
  const index = renderIndex(state);
  if (items.length < 12) return [{ label: null, items }];
  const grouped = new Map();
  for (const item of items) {
    const due = effectiveDue(state, item.id, index);
    const key = due.source === 'inherited' ? due.sourceItemId : 'direct';
    const group = grouped.get(key) ?? { key, items: [] };
    group.items.push(item); grouped.set(key, group);
  }
  if (grouped.size < 2 && ![...grouped.values()].some((group) => group.key !== 'direct')) return [{ label: null, items }];
  return [...grouped.values()].map((group) => ({
    label: group.key === 'direct' ? tr('overdueDirectGroup') : tr('overdueGroupSource', { path: pathString(state, group.key, index) }),
    items: group.items,
  }));
}

function renderTodayRow(state, item) {
  const row = renderItemRow(state, item, { depth: 0, tree: false, pathContext: true });
  const selected = ui.selectedToday?.has(item.id);
  const checkbox = node('input', { class: 'bulk-checkbox', type: 'checkbox', checked: selected, ariaLabel: item.title, onChange: (event) => { ui.selectedToday ??= new Set(); if (event.target.checked) ui.selectedToday.add(item.id); else ui.selectedToday.delete(item.id); scheduleRender(); } });
  const main = row.querySelector('.item-row-main');
  main?.classList.add('has-bulk-checkbox');
  main?.prepend(checkbox);
  return row;
}

async function batchToday(action) {
  const ids = [...(ui.selectedToday ?? [])];
  if (!ids.length) return;
  if (action === 'complete' && ids.some((id) => completionNeedsConfirmation(currentState(), id))) {
    openConfirm({ title: tr('complete'), message: tr('confirmCompleteParent'), onConfirm: () => batchTodayConfirmed(ids, action) });
    return;
  }
  await batchTodayConfirmed(ids, action);
}

async function batchTodayConfirmed(ids, action) {
  const result = await mutate(`today_batch_${action}`, (state) => {
    for (const id of ids) {
      if (action === 'complete') { const outcome = setItemStatus(state, id, 'completed', { force: true }); if (outcome.ok) markTodayCompletion(state, id, 'completed'); }
      else removeFromToday(state, id);
    }
    return { ok: true };
  }, action === 'complete' ? 'itemCompleted' : 'todayRemoved');
  if (result.ok) { ui.selectedToday?.clear(); recordSemantic(currentState(), 'batch_action', { count: ids.length, status: action }); }
}

function renderSmartPage(state) {
  const page = node('section', { class: 'page smart-page' });
  if (state.settings.experimental?.enabled === false || state.settings.experimental?.smart === false) {
    page.append(node('div', { class: 'page-header' }, node('div', { class: 'page-header-main' }, node('span', { class: 'eyebrow' }, tr('navSmart')), heading(tr('navSmart'), 1)), button(tr('settingsExperimental'), () => { ui.page = 'settings'; ui.settingsPage = 'experimental'; scheduleRender(); }, { className: 'secondary-button' })), settingCard(tr('settingsExperimental'), node('p', { class: 'muted' }, tr('smartDisabled'))));
    return page;
  }
  const views = ['today', 'upcoming', 'overdue', 'recentlyCompleted', 'readyToClose', 'recentlyActive', 'highAttention', 'stale', 'momentum', 'estimated', 'routine'];
  const viewNav = node('div', { class: 'smart-view-nav' });
  for (const view of views) viewNav.append(button(tr(`view${view[0].toUpperCase()}${view.slice(1)}`), () => { ui.smartView = view; ui.page = 'smart'; scheduleRender(); }, { className: `smart-view-button ${ui.smartView === view ? 'active' : ''}` }));
  const items = smartViewItems(state, ui.smartView, renderNow, renderIndex(state));
  const activeItems = items.filter((item) => item.status !== 'completed');
  const completedItems = items.filter((item) => item.status === 'completed');
  const smartRows = [...activeItems, ...(completedItems.length ? [{ kind: 'section', label: tr('completedItems'), count: completedItems.length }] : []), ...completedItems];
  const header = node('div', { class: 'page-header' }, node('div', { class: 'page-header-main' }, node('span', { class: 'eyebrow' }, tr('navSmart')), heading(tr(`view${ui.smartView[0].toUpperCase()}${ui.smartView.slice(1)}`), 1), node('p', { class: 'page-subtitle' }, smartDescription(ui.smartView))), node('div', { class: 'page-header-actions' }, button(tr('enableSmartSort'), () => setPage('settings'), { className: 'secondary-button' })));
  page.append(header, viewNav);
  if (!items.length) { page.append(renderEmptyState('smartEmpty')); return page; }
  const holder = node('div', { class: 'smart-list-holder' });
  activeVirtualList?.destroy(); activeVirtualList = new VirtualList(holder, { rowHeight: 116, overscan: 10, renderRow: (entry) => entry.kind === 'section' ? node('div', { class: 'list-section-heading' }, node('span', {}, entry.label), node('small', {}, String(entry.count))) : renderSmartRow(state, entry, ui.smartView), empty: () => renderEmptyState('smartEmpty') });
  activeVirtualList.setItems(smartRows);
  page.append(holder);
  return page;
}

function smartDescription(view) {
  return { today: tr('todayEmptyHint'), upcoming: tr('dueSoon'), overdue: tr('todayOverdue'), recentlyCompleted: tr('activityCompleted'), readyToClose: tr('iconRing'), recentlyActive: tr('attention'), highAttention: tr('attention'), stale: tr('stale'), momentum: tr('momentum'), estimated: tr('estimatedCompletion'), routine: tr('routineSuggestion') }[view] ?? '';
}

function renderSmartRow(state, item, view) {
  const index = renderIndex(state);
  const row = renderItemRow(state, item, { depth: 0, tree: false, pathContext: true, smartView: view });
  const badges = node('div', { class: 'smart-badges' });
  if (view === 'highAttention') badges.append(node('span', { class: 'metric-badge' }, `${tr('attention')} ${attentionScore(state, item.id, renderNow, index).toFixed(1)}`));
  if (view === 'momentum') badges.append(node('span', { class: 'metric-badge' }, `${tr('momentum')} ${momentumScore(state, item.id, renderNow, index).toFixed(1)}`));
  if (view === 'stale') badges.append(node('span', { class: 'metric-badge warning' }, tr('stale')));
  if (view === 'estimated') { const estimate = estimateCompletion(state, item.id, renderNow, index); badges.append(node('span', { class: 'metric-badge' }, estimate.value ? `${tr('estimatedCompletion')}: ${formatDate(language(), estimate.value)}` : tr('insufficientData'))); }
  if (view === 'routine') badges.append(node('span', { class: 'metric-badge' }, tr('routineSuggestion')));
  if (badges.childNodes.length) row.querySelector('.item-main')?.append(badges);
  return row;
}

function renderReminderPage(state) {
  const page = node('section', { class: 'page reminder-page' });
  const groups = reminderCenter(state, renderNow, renderIndex(state));
  page.append(node('div', { class: 'page-header' }, node('div', { class: 'page-header-main' }, node('span', { class: 'eyebrow' }, tr('navReminders')), heading(tr('navReminders'), 1), node('p', { class: 'page-subtitle' }, tr('missedReminder'))), node('div', { class: 'page-header-actions' }, button(tr('exportCalendar'), exportCalendar, { className: 'secondary-button', icon: '⇩' }), button(tr('settingsReminders'), () => { ui.page = 'settings'; ui.settingsPage = 'reminders'; scheduleRender(); }, { className: 'secondary-button', icon: '⚙' }))));
  page.append(reminderGroup(state, tr('remindersNeedAction'), groups.needAction, 'needAction'), reminderGroup(state, tr('remindersToday'), groups.today, 'today'), reminderGroup(state, tr('remindersLater'), groups.later, 'later'), reminderGroup(state, tr('remindersHandled'), groups.handled, 'handled'));
  return page;
}

function reminderGroup(state, label, entries, key) {
  if (!entries.length) return node('section', { class: `reminder-group reminder-${key} empty-section` });
  const group = node('section', { class: `reminder-group reminder-${key}` }, node('div', { class: 'section-toolbar' }, heading(label, 2), node('span', { class: 'section-count' }, String(entries.length))));
  for (const entry of entries) group.append(renderReminderCard(state, entry));
  return group;
}

function exportCalendar() {
  const state = currentState();
  const index = createEngineIndex(state);
  const escapeICS = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const utc = (value) => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Progress Tracker//Reminder Center//EN', 'CALSCALE:GREGORIAN'];
  for (const reminder of state.reminders) {
    const item = getItem(state, reminder.itemId, index); const occurrence = reminderOccurrence(state, reminder, new Date(), index);
    if (!item || !occurrence || reminder.enabled === false) continue;
    lines.push('BEGIN:VEVENT', `UID:${reminder.id}@progress-tracker`, `DTSTAMP:${utc(new Date())}`, `DTSTART:${utc(occurrence)}`, `SUMMARY:${escapeICS(item.title)}`, `DESCRIPTION:${escapeICS(pathString(state, item.id, index))}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  downloadText(`progress-tracker-reminders-${dateKey(new Date())}.ics`, `${lines.join('\r\n')}\r\n`, 'text/calendar;charset=utf-8');
  mutate('export_calendar', (draft) => { recordSemantic(draft, 'export', { scope: 'calendar' }); return { ok: true }; }, null, { queue: false });
}

function renderReminderCard(state, entry) {
  const item = entry.item;
  const missed = entry.missedCount > 0;
  const card = node('article', { class: `reminder-card ${missed ? 'missed' : ''}` }, node('div', { class: 'reminder-card-main' }, node('span', { class: 'reminder-card-icon' }, '⌁'), node('div', {}, node('strong', {}, item.title), node('small', {}, pathString(state, item.id, renderIndex(state))), missed ? node('span', { class: 'missed-label' }, `${tr('missedReminder')} · ${tr('missedCount', { count: entry.missedCount })}`) : null)));
  const actions = node('div', { class: 'reminder-card-actions' }, button(tr('remindComplete'), () => performStatus(item, 'completed'), { className: 'small-button' }), button(tr('remindToday'), () => { const reminder = entry.reminders.find((candidate) => candidate.status === 'missed' || candidate.status === 'today')?.reminder; if (reminder) mutate('reminder_suppress_today', (draft) => suppressReminderToday(draft, reminder.id), 'savedOffline'); }, { className: 'small-button' }), button(tr('remindNextLaunch'), () => { const reminder = entry.reminders[0]?.reminder; if (reminder) mutate('reminder_next_launch', (draft) => updateReminder(draft, reminder.id, { lastTriggeredAt: reminderOccurrence(draft, reminder)?.toISOString() }), 'savedOffline'); }, { className: 'small-button' }), button(tr('remindView'), () => openDetail(item.id), { className: 'small-button' }));
  const snooze = node('div', { class: 'snooze-actions' }, node('span', {}, tr('remindSnooze')), ...[[10, 'snooze10'], [30, 'snooze30'], [60, 'snooze60']].map(([minutes, key]) => button(tr(key), () => snoozeEntry(entry, minutes), { className: 'text-button' })), button(tr('snoozeCustom'), () => openCustomSnooze(entry), { className: 'text-button' }));
  card.append(actions, snooze); return card;
}

async function snoozeEntry(entry, minutes) {
  const reminder = entry.reminders.find((candidate) => candidate.status === 'missed' || candidate.status === 'today')?.reminder ?? entry.reminders[0]?.reminder;
  if (!reminder) return;
  await mutate('reminder_snooze', (state) => snoozeReminder(state, reminder.id, Date.now() + minutes * 60000), 'savedOffline');
}

function openCustomSnooze(entry) { ui.modal = { kind: 'customSnooze', title: tr('snoozeCustom'), entry, value: '' }; scheduleRender(); }

async function submitCustomSnooze(modal) {
  const reminder = modal.entry.reminders.find((candidate) => candidate.status === 'missed' || candidate.status === 'today')?.reminder ?? modal.entry.reminders[0]?.reminder;
  const until = new Date(modal.value);
  if (!reminder || Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) { toast(tr('errorInvalidDate'), 'error'); return; }
  const result = await mutate('reminder_snooze_custom', (state) => snoozeReminder(state, reminder.id, until.toISOString()), 'savedOffline');
  if (result.ok) ui.modal = null;
}

function inputField(label, input, hint = null) { return node('label', { class: 'field' }, node('span', { class: 'field-label' }, label), input, hint ? node('small', { class: 'field-hint' }, hint) : null); }
function selectOptions(values, selected, labels = {}) { return values.map((value) => node('option', { value, selected: value === selected }, labels[value] ?? value)); }

function renderDetailPanel(state, item) {
  const index = renderIndex(state);
  const due = effectiveDue(state, item.id, index);
  const progress = progressForItem(state, item.id, index.progressByItem, new Set(), index);
  const lockedByConflict = itemHasConflict(state, item.id);
  const panel = node('aside', { class: 'detail-pane', role: 'dialog', 'aria-label': tr('detail') });
  const header = node('div', { class: 'detail-header' }, node('div', { class: 'detail-heading' }, node('span', { class: 'eyebrow' }, tr('detail')), heading(item.title, 2)), iconButton('×', tr('closePanel'), () => { ui.detailId = null; scheduleRender(); }));
  panel.append(header);
  const content = node('div', { class: 'detail-content' });
  const editable = node('div', { class: lockedByConflict ? 'conflict-edit-locked' : '' });
  const titleInput = node('input', { class: 'detail-title-input', type: 'text', value: item.title, ariaLabel: tr('itemTitle'), onChange: (event) => mutate('edit_title', (draft) => renameItem(draft, item.id, event.target.value), 'savedOffline') });
  editable.append(inputField(tr('itemTitle'), titleInput));
  const progressCard = node('div', { class: 'detail-progress-card' }, node('div', { class: 'detail-progress-ring progress-ring', style: { '--progress': `${progress}%` } }, node('span', {}, `${Math.round(progress)}%`)), node('div', {}, node('strong', {}, tr('progress')), node('small', {}, tr('iconRing'))));
  const conflictSection = renderConflictSection(state, item);
  if (conflictSection) content.append(conflictSection);
  const basicGrid = node('div', { class: 'detail-grid' });
  basicGrid.append(inputField(tr('status'), node('select', { value: item.status, ariaLabel: tr('status'), onChange: (event) => { const value = event.target.value; if (value === 'completed') performStatus(item, value); else mutate('status_changed', (draft) => setItemStatus(draft, item.id, value, { force: true }), 'savedOffline'); } }, ...selectOptions(['active', 'completed', 'skipped'], item.status, { active: tr('active'), completed: tr('completed'), skipped: tr('skipped') }))));
  basicGrid.append(inputField(tr('priority'), node('select', { value: item.priority, ariaLabel: tr('priority'), onChange: (event) => mutate('priority_changed', (draft) => setPriority(draft, item.id, event.target.value), 'savedOffline') }, ...selectOptions(['none', 'low', 'medium', 'high'], item.priority, { none: tr('noPriority'), low: tr('low'), medium: tr('medium'), high: tr('high') }))));
  basicGrid.append(inputField(tr('importance'), node('select', { value: String(item.importance), ariaLabel: tr('importance'), onChange: (event) => mutate('importance_changed', (draft) => setImportance(draft, item.id, Number(event.target.value)), 'savedOffline') }, ...selectOptions(['0', '1', '2', '3'], String(item.importance), { 0: tr('unset'), 1: '★', 2: '★★', 3: '★★★' }))));
  editable.append(progressCard, basicGrid, renderDateFields(state, item, due), renderTagsField(state, item), renderReminderFields(state, item), renderNotesField(state, item), renderChildrenField(state, item), renderHistoryField(state, item));
  const more = node('div', { class: 'detail-more' }, heading(tr('more'), 3), button(tr('move'), () => openMoveModal(item), { className: 'secondary-button', icon: '↗' }), button(tr('duplicate'), () => openDuplicateModal(item), { className: 'secondary-button', icon: '⧉' }), button(tr('exportTree'), () => exportItemTree(item), { className: 'secondary-button', icon: '⇩' }), button(tr('delete'), () => performDelete(item), { className: 'danger-button', icon: '⌫' }));
  editable.append(more);
  content.append(editable);
  panel.append(content);
  return panel;
}

function renderConflictSection(state, item) {
  const conflicts = renderIndex(state).conflictsByItem.get(item.id) ?? [];
  if (!conflicts.length) return null;
  const section = node('section', { class: 'detail-section conflict-section' }, heading(tr('syncConflict'), 3), node('p', { class: 'warning-note' }, `${tr('conflictArchive')} ${tr('conflictEditBlocked')}`));
  for (const conflict of conflicts) section.append(renderConflictComparison(conflict));
  return section;
}

async function resolveOneConflict(conflictId, choice) { await mutate('conflict_resolved', (state) => resolveConflict(state, conflictId, choice), 'savedOffline'); }

export async function mountApp(repo) {
  repository = repo;
  const startupStartedAt = performance.now();
  const result = await repository.initialize();
  let state = currentState();
  if (state.settings.cloudSync?.authorized) {
    await repository.update('cloud_session_reauth_required', (draft) => {
      draft.settings.cloudSync = { ...(draft.settings.cloudSync ?? {}), authorized: false, status: draft.settings.cloudSync?.clientId ? 'configured' : 'disabled' };
      return { ok: true };
    }, null, { queue: false });
    state = currentState();
  }
  ui.categoryId = state.settings.defaultCategoryId ?? state.categories[0]?.id ?? null;
  ui.page = state.meta.recoveryMode ? 'settings' : state.settings.defaultPage ?? 'categories';
  ui.smartView = state.settings.defaultSmartView ?? 'today';
  if (!state.settings.cloudSync) state.settings.cloudSync = { enabled: false, clientId: '', authorized: false, status: 'disabled', lastSyncAt: null };
  driveSync.configure(state.settings.cloudSync.clientId ?? '');
  repository.subscribe(() => scheduleRender());
  globalThis.addEventListener('keydown', handleKeyboardShortcuts);
  globalThis.addEventListener('online', () => { scheduleRender(); scheduleCloudSync(250); });
  globalThis.addEventListener('offline', scheduleRender);
  globalThis.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleCloudSync(250); });
  globalThis.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', scheduleRender);
  globalThis.addEventListener('beforeunload', () => { repository.markNormalShutdown(); });
  if (repository.previousSessionAbnormal && state.settings.developerEnabled && !state.meta.recoveryMode) {
    await repository.update('session_abnormal_end', (draft) => { recordSemantic(draft, 'session_lifecycle', { status: 'suspected_abnormal_end' }); return { ok: true }; }, null, { queue: false });
  }
  if (!state.meta.recoveryMode) {
    await repository.update('capabilities', (draft) => { draft.capabilities = capabilityReport(); recordSemantic(draft, 'page_opened', { page: ui.page }); recordPerformance(draft, 'startup', performance.now() - startupStartedAt, { itemCount: draft.items.length }); return { ok: true }; }, null, { queue: false });
    if (navigator.storage?.estimate) {
      try {
        const estimate = browserStorageEstimate(await navigator.storage.estimate());
        if (estimate) await repository.update('storage_capability', (draft) => { draft.capabilities.storageEstimate = estimate; return { ok: true }; }, null, { queue: false });
      } catch { /* optional capability; omit unreliable values */ }
    }
  }
  initialised = true;
  render();
  if (!state.meta.recoveryMode && state.settings.cloudSync?.authorized) scheduleCloudSync(250);
  if (!state.meta.recoveryMode && state.settings.developerEnabled) await repository.update('performance_tti', (draft) => { recordPerformance(draft, 'time_to_interactive', performance.now() - startupStartedAt, { itemCount: draft.items.length }); return { ok: true }; }, null, { queue: false });
  return result;
}


function renderDateFields(state, item, due) {
  const index = renderIndex(state);
  const block = node('section', { class: 'detail-section' }, heading(tr('dueDate'), 3));
  const dateGrid = node('div', { class: 'detail-grid' });
  const mode = node('select', { value: item.dueMode, ariaLabel: tr('dueDate'), onChange: (event) => changeDueMode(item, event.target.value) }, ...selectOptions(['inherit', 'explicit', 'none'], item.dueMode, { inherit: tr('inheritDue'), explicit: tr('explicitDue'), none: tr('noDeadline') }));
  const dateInput = node('input', { type: 'date', value: localDateInput(item.dueDate), disabled: item.dueMode !== 'explicit', ariaLabel: tr('dueDate'), onChange: (event) => mutate('due_changed', (draft) => setDue(draft, item.id, { mode: 'explicit', date: dateFromInput(event.target.value) }), 'savedOffline') });
  dateGrid.append(inputField(tr('dueDate'), mode, due.source === 'inherited' ? `${tr('inherited')} · ${getItem(state, due.sourceItemId, index)?.title ?? ''}` : null), inputField(tr('explicitDue'), dateInput));
  const planned = node('input', { type: 'date', value: localDateInput(item.plannedStart), ariaLabel: tr('plannedStart'), onChange: (event) => mutate('planned_start_changed', (draft) => { const target = getItem(draft, item.id); target.plannedStart = dateFromInput(event.target.value); target.revision += 1; target.fieldRevisions = { ...(target.fieldRevisions ?? {}), plannedStart: target.revision }; target.updatedAt = isoNow(); recordHistory(draft, item.id, 'edited', { fields: ['plannedStart'] }); return { ok: true }; }, 'savedOffline') });
  const plannedContext = effectivePlannedStart(state, item.id, index);
  dateGrid.append(inputField(tr('plannedStart'), planned, plannedContext && !item.plannedStart ? `${tr('inherited')} · ${getItem(state, plannedContext.sourceItemId, index)?.title ?? ''}` : tr('plannedStart')));
  block.append(dateGrid);
  const warnings = dateWarnings(state, item.id, index);
  if (warnings.includes('child_due_after_parent')) block.append(node('p', { class: 'warning-note' }, tr('parentDueWarning')));
  if (warnings.includes('planned_start_after_due')) block.append(node('p', { class: 'warning-note' }, tr('moveConflictWarning')));
  return block;
}

function changeDueMode(item, mode) {
  const state = currentState();
  const relativeReminders = state.reminders.filter((reminder) => reminder.itemId === item.id && reminder.type === 'relative');
  const impact = mode !== 'explicit' && item.dueMode === 'explicit' ? dueImpactOnRemoval(state, item.id) : null;
  const impactMessage = impact ? `${tr('dueDeleteQuestion')} ${tr('dueDeleteImpact', { lost: impact.lost.length, changed: impact.changed.length })}` : tr('relativeReminderNoDue');
  const duePreview = clone(state);
  const previewItem = getItem(duePreview, item.id);
  previewItem.dueMode = mode;
  previewItem.dueDate = mode === 'explicit' ? item.dueDate : null;
  const losesDue = relativeReminders.length > 0 && !effectiveDue(duePreview, item.id).value;
  if (losesDue) {
    const choices = [
      { label: tr('reminderDisabled'), action: () => mutate('due_changed', (draft) => { for (const reminder of draft.reminders.filter((candidate) => candidate.itemId === item.id && candidate.type === 'relative')) updateReminder(draft, reminder.id, { enabled: false }); return setDue(draft, item.id, { mode, date: null }); }, 'savedOffline') },
      { label: tr('reminderAbsolute'), action: () => mutate('due_changed', (draft) => { const occurrences = new Map(draft.reminders.filter((candidate) => candidate.itemId === item.id && candidate.type === 'relative').map((reminder) => [reminder.id, reminderOccurrence(draft, reminder)?.toISOString() ?? null])); const result = setDue(draft, item.id, { mode, date: null }); for (const reminder of draft.reminders.filter((candidate) => occurrences.has(candidate.id))) { const occurrence = occurrences.get(reminder.id); if (occurrence) updateReminder(draft, reminder.id, { type: 'absolute', at: occurrence, offsetDays: 0 }); } return result; }, 'savedOffline') },
      { label: tr('cancel'), action: () => {} },
    ];
    ui.modal = { kind: 'choice', title: tr('dueDeletePreview'), message: impactMessage, body: node('div', { class: 'modal-actions vertical' }, ...choices.map((choice) => button(choice.label, () => { ui.modal = null; choice.action(); }, { className: choice.label === tr('cancel') ? 'text-button' : 'secondary-button' }))) };
    scheduleRender();
  } else if (item.dueMode === 'explicit' && mode !== 'explicit') {
    openConfirm({ title: tr('dueDeletePreview'), message: impactMessage, onConfirm: () => mutate('due_changed', (draft) => setDue(draft, item.id, { mode, date: null }), 'savedOffline') });
  } else mutate('due_changed', (draft) => setDue(draft, item.id, { mode, date: mode === 'explicit' ? item.dueDate : null }), 'savedOffline');
}

function renderTagsField(state, item) {
  const section = node('section', { class: 'detail-section' }, heading(tr('tags'), 3));
  const tagList = node('div', { class: 'tag-list' });
  for (const tag of item.tags) tagList.append(node('span', { class: 'tag-chip' }, `#${tag}`, iconButton('×', `${tr('delete')} ${tag}`, () => mutate('tag_changed', (draft) => setTags(draft, item.id, item.tags.filter((candidate) => candidate !== tag)), 'savedOffline'), { className: 'tag-remove' })));
  const input = node('input', { type: 'text', placeholder: tr('tagPlaceholder'), ariaLabel: tr('tags'), onKeydown: (event) => { if (event.key === 'Enter') { stop(event); const value = event.target.value.trim(); if (value) mutate('tag_changed', (draft) => setTags(draft, item.id, [...item.tags, value]), 'savedOffline'); event.target.value = ''; } } });
  section.append(tagList, input); return section;
}

function renderReminderFields(state, item) {
  const reminders = renderIndex(state).remindersByItem.get(item.id) ?? [];
  const block = node('section', { class: 'detail-section reminder-settings' }, heading(tr('reminder'), 3), node('p', { class: 'field-hint' }, tr('reminderLimit')));
  for (const reminder of reminders) block.append(renderReminderRow(state, reminder));
  if (reminders.length < 3) block.append(renderAddReminderForm(state, item));
  return block;
}

function renderReminderRow(state, reminder) {
  const occurrence = reminderOccurrence(state, reminder, renderNow, renderIndex(state));
  const row = node('div', { class: 'reminder-setting-row' }, node('span', { class: 'reminder-setting-icon' }, '⌁'), node('div', { class: 'reminder-setting-main' }, node('strong', {}, reminder.type === 'relative' ? tr('reminderRelative') : tr('reminderAbsolute')), node('small', {}, occurrence ? formatDateTime(language(), occurrence.toISOString()) : tr('relativeReminderNoDue'))), node('label', { class: 'switch' }, node('input', { type: 'checkbox', checked: reminder.enabled !== false, ariaLabel: tr('reminderEnable'), onChange: (event) => mutate('reminder_changed', (draft) => updateReminder(draft, reminder.id, { enabled: event.target.checked }), 'savedOffline') }), node('span', { class: 'switch-track' })), iconButton('×', tr('delete'), () => mutate('reminder_changed', (draft) => removeReminder(draft, reminder.id), 'savedOffline'), { className: 'icon-button danger-icon' }));
  return row;
}

function renderAddReminderForm(state, item) {
  const type = node('select', { value: 'relative', ariaLabel: tr('reminder') }, node('option', { value: 'relative' }, tr('reminderRelative')), node('option', { value: 'absolute' }, tr('reminderAbsolute')));
  const offset = node('input', { type: 'number', value: '-1', ariaLabel: tr('reminderOffset'), placeholder: tr('reminderOffset') });
  const time = node('input', { type: 'time', value: state.settings.defaultReminderTime ?? '09:00', ariaLabel: tr('reminderTime') });
  const absolute = node('input', { type: 'datetime-local', ariaLabel: tr('reminderAbsolute'), class: 'reminder-absolute-input' });
  const add = button(tr('addReminder'), async () => {
    const at = absolute.value ? new Date(absolute.value).toISOString() : null;
    const result = await mutate('reminder_changed', (draft) => addReminder(draft, item.id, { type: type.value, offsetDays: Number(offset.value), time: time.value, at }), 'savedOffline');
    if (result.ok) { absolute.value = ''; }
  }, { className: 'secondary-button', icon: '+' });
  return node('div', { class: 'add-reminder-form' }, type, offset, time, absolute, add);
}

function renderNotesField(state, item) {
  const section = node('section', { class: 'detail-section notes-section' }, node('div', { class: 'section-toolbar' }, heading(tr('notes'), 3), node('div', { class: 'segmented' }, button(tr('notesEdit'), () => { ui.notesTab = 'edit'; scheduleRender(); }, { className: ui.notesTab === 'edit' ? 'active' : '' }), button(tr('notesPreview'), () => { ui.notesTab = 'preview'; scheduleRender(); }, { className: ui.notesTab === 'preview' ? 'active' : '' }))));
  if (ui.notesTab === 'preview') section.append(node('div', { class: 'markdown-preview', html: renderMarkdown(item.notes) || `<p class="muted">${tr('noItems')}</p>` }));
  else section.append(node('textarea', { class: 'notes-editor', placeholder: tr('notesPlaceholder'), ariaLabel: tr('notes'), value: item.notes, onBlur: (event) => { if (event.target.value !== item.notes) mutate('note_edited', (draft) => setNotes(draft, item.id, event.target.value), 'savedOffline'); } }), node('small', { class: 'field-hint' }, tr('markdownHelp')));
  return section;
}

function renderChildrenField(state, item) {
  const children = [...childrenOf(state, item.id, renderIndex(state))].sort((a, b) => (a.status === 'completed') - (b.status === 'completed') || a.activeOrder - b.activeOrder);
  const section = node('section', { class: 'detail-section children-section' }, node('div', { class: 'section-toolbar' }, heading(tr('children'), 3), button(tr('addChild'), () => openChildCreate(item), { className: 'text-button', icon: '+' })));
  if (!children.length) section.append(node('p', { class: 'muted' }, tr('noItems')));
  else children.forEach((child, childIndex) => section.append(renderItemRow(state, child, {
    depth: 1,
    maxDepth: 2,
    nextDepth: childIndex < children.length - 1 ? 1 : null,
    siblingIndex: childIndex,
    siblingCount: children.length,
    tree: true,
  })));
  return section;
}

function renderHistoryField(state, item) {
  const history = [...(renderIndex(state).historyByItem.get(item.id) ?? [])].sort((a, b) => b.at.localeCompare(a.at));
  const section = node('section', { class: 'detail-section history-section' }, heading(tr('history'), 3));
  if (!history.length) section.append(node('p', { class: 'muted' }, tr('noHistory')));
  else for (const entry of history) section.append(node('div', { class: 'history-entry' }, node('span', { class: 'history-dot' }, '•'), node('div', {}, node('strong', {}, activityLabel(entry.type)), node('small', {}, formatDateTime(language(), entry.at)))));
  const latestCompletion = history.find((entry) => entry.type === 'completed')?.at ?? item.completedAt;
  const elapsed = latestCompletion ? Math.max(0, new Date(latestCompletion).getTime() - new Date(item.createdAt).getTime()) : null;
  section.append(node('div', { class: 'detail-facts' }, node('span', {}, `${tr('createdTime')}: ${formatDateTime(language(), item.createdAt)}`), node('span', {}, `${tr('elapsed')}: ${elapsed === null ? tr('active') : formatElapsed(elapsed)}`), node('span', {}, `${tr('parentPath')}: ${pathString(state, item.id, renderIndex(state))}`)));
  return section;
}

function formatElapsed(milliseconds) {
  const days = Math.floor(milliseconds / 86400000); const hours = Math.floor((milliseconds % 86400000) / 3600000);
  if (language() === 'en') return days ? `${days}d ${hours}h` : `${hours}h`;
  return days ? `${days} 天 ${hours} 小時` : `${hours} 小時`;
}

function openCategoryCreate() { openTextPrompt(tr('addCategory'), tr('categoryName'), '', (value) => mutate('create_category', (state) => createCategory(state, value, isoNow(), ui.categoryId ?? state.settings.defaultCategoryId), 'categoryCreated')); }
function openCategoryRename(category) { openTextPrompt(tr('rename'), tr('categoryName'), category.title, (value) => mutate('rename_category', (state) => renameCategory(state, category.id, value), 'categoryRenamed')); }

function openCategoryMenu(category) {
  const hasContent = currentState().items.some((item) => item.categoryId === category.id);
  ui.modal = { kind: 'menu', title: category.title, body: node('div', { class: 'modal-actions vertical' }, button(tr('rename'), () => { ui.modal = null; openCategoryRename(category); }, { className: 'secondary-button' }), button(tr('delete'), () => { ui.modal = null; deleteCategoryFlow(category, hasContent); }, { className: 'danger-button' })) };
  scheduleRender();
}

function deleteCategoryFlow(category, hasContent) {
  if (!hasContent) { openConfirm({ title: tr('delete'), message: tr('categoryEmpty'), danger: true, onConfirm: () => deleteCategory(category) }); return; }
  ui.modal = { kind: 'choice', title: tr('delete'), message: tr('categoryDeleteQuestion'), body: node('div', { class: 'modal-actions vertical' }, button(tr('deleteCategoryTree'), () => { ui.modal = null; deleteCategory(category); }, { className: 'danger-button' }), button(tr('moveItemsFirst'), () => { ui.modal = null; openMoveCategoryItems(category); }, { className: 'secondary-button' })) };
  scheduleRender();
}

async function deleteCategory(category) {
  const result = await mutate('delete_category', (state) => softDeleteCategory(state, category.id), 'categoryDeleted');
  if (result.ok) { ui.categoryId = currentState().categories[0]?.id ?? null; ui.modal = null; }
}

function openMoveCategoryItems(category) {
  const targets = currentState().categories.filter((candidate) => candidate.id !== category.id);
  if (!targets.length) { toast(tr('errorNoCategory'), 'error'); return; }
  openChoiceModal(tr('moveItemsFirst'), tr('selectCategory'), targets.map((target) => ({ label: target.title, action: () => moveCategoryItems(category, target) })));
}

async function moveCategoryItems(category, target) {
  const result = await mutate('move_category_items', (state) => {
    const roots = state.items.filter((item) => item.categoryId === category.id && item.parentId === null);
    for (const rootItem of roots) moveSubtree(state, rootItem.id, { categoryId: target.id, parentId: null });
    return { ok: true };
  }, 'itemMoved');
  if (result.ok) await deleteCategory(category);
}

function openAncestorMenu(state, focus) {
  const ancestors = itemPath(state, focus.id).slice(0, -1);
  openChoiceModal(tr('showAncestors'), tr('path'), ancestors.map((item) => ({ label: item.title, action: () => setFocus(focus.categoryId, item.id) })));
}

function openItemMenu(item) {
  if (itemHasConflict(currentState(), item.id)) { blockConflictedEdit(); return; }
  ui.modal = { kind: 'menu', title: item.title, body: node('div', { class: 'modal-actions vertical' }, button(tr('addChild'), () => { ui.modal = null; openChildCreate(item); }, { className: 'secondary-button', icon: '+' }), button(item.status === 'completed' ? tr('reopen') : tr('complete'), () => { ui.modal = null; performStatus(item, item.status === 'completed' ? 'active' : 'completed'); }, { className: 'secondary-button' }), button(currentState().today.items[item.id] ? tr('removeFromToday') : tr('moveToToday'), () => { ui.modal = null; toggleToday(item); }, { className: 'secondary-button' }), button(tr('move'), () => { ui.modal = null; openMoveModal(item); }, { className: 'secondary-button' }), button(tr('duplicate'), () => { ui.modal = null; openDuplicateModal(item); }, { className: 'secondary-button' }), button(tr('exportTree'), () => { ui.modal = null; exportItemTree(item); }, { className: 'secondary-button' }), button(tr('delete'), () => { ui.modal = null; performDelete(item); }, { className: 'danger-button' })) };
  scheduleRender();
}

function openChildCreate(parent) {
  if (itemHasConflict(currentState(), parent.id)) { blockConflictedEdit(); return; }
  openTextPrompt(tr('addChild'), tr('itemTitle'), '', (value) => mutate('add_child', (state) => createItem(state, { categoryId: parent.categoryId, parentId: parent.id, title: value }, isoNow()), 'savedOffline'));
}

function openRenameItem(item) { if (itemHasConflict(currentState(), item.id)) { blockConflictedEdit(); return; } openTextPrompt(tr('rename'), tr('itemTitle'), item.title, (value) => mutate('edit_title', (state) => renameItem(state, item.id, value), 'savedOffline')); }

function exportItemTree(item) {
  const content = exportPTMD(currentState(), { scope: 'item', targetId: item.id });
  downloadText(`progress-tracker-${item.id}.ptmd`, content, 'text/markdown;charset=utf-8');
  mutate('export', (state) => { recordSemantic(state, 'export', { scope: 'item' }); return { ok: true }; }, null, { queue: false });
}

function openMoveModal(item) { if (itemHasConflict(currentState(), item.id)) { blockConflictedEdit(); return; } ui.moveItemId = item.id; ui.modal = { kind: 'move', title: tr('move'), itemId: item.id }; scheduleRender(); }

function openDuplicateModal(item) { if (itemHasConflict(currentState(), item.id)) { blockConflictedEdit(); return; } ui.duplicateItemId = item.id; ui.modal = { kind: 'duplicate', title: tr('duplicate'), itemId: item.id }; scheduleRender(); }

function openInfoModal(message) { ui.modal = { kind: 'info', title: tr('about'), message }; scheduleRender(); }

function openConfirm({ title, message, danger = false, typed = false, onConfirm }) { ui.modal = { kind: 'confirm', title, message, danger, typed, onConfirm }; scheduleRender(); }
function openTextPrompt(title, label, value, onSubmit) { ui.modal = { kind: 'prompt', title, label, value, onSubmit }; scheduleRender(); }
function openChoiceModal(title, message, choices) { ui.modal = { kind: 'choice', title, message, body: node('div', { class: 'modal-actions vertical' }, ...choices.map((choice) => button(choice.label, () => { ui.modal = null; choice.action(); }, { className: 'secondary-button' }))) }; scheduleRender(); }

const settingsSections = [
  ['general', 'settingsGeneral'], ['items', 'settingsItems'], ['reminders', 'settingsReminders'], ['experimental', 'settingsExperimental'],
  ['data', 'settingsData'], ['icons', 'settingsIcons'], ['developer', 'settingsDeveloper'], ['about', 'settingsAbout'],
];

function renderSettingsPage(state) {
  const page = node('section', { class: 'page settings-page' });
  const nav = node('div', { class: 'settings-nav' }, heading(tr('settings'), 1));
  for (const [key, labelKey] of settingsSections) nav.append(button(tr(labelKey), () => { ui.settingsPage = key; scheduleRender(); }, { className: `settings-nav-button ${ui.settingsPage === key ? 'active' : ''}` }));
  const content = node('div', { class: 'settings-content' });
  const titleKey = settingsSections.find(([key]) => key === ui.settingsPage)?.[1] ?? 'settingsGeneral';
  content.append(node('div', { class: 'settings-content-header' }, heading(tr(titleKey), 1)));
  if (ui.settingsPage === 'general') content.append(renderGeneralSettings(state));
  else if (ui.settingsPage === 'items') content.append(renderItemSettings(state));
  else if (ui.settingsPage === 'reminders') content.append(renderReminderSettings(state));
  else if (ui.settingsPage === 'experimental') content.append(renderExperimentalSettings(state));
  else if (ui.settingsPage === 'data') content.append(renderDataSettings(state));
  else if (ui.settingsPage === 'icons') content.append(renderIconGuide());
  else if (ui.settingsPage === 'developer') content.append(renderDeveloperSettings(state));
  else content.append(renderAboutSettings());
  page.append(node('div', { class: 'settings-layout' }, nav, content));
  return page;
}

function settingsToggle(label, checked, onChange, hint = null) { return node('label', { class: 'settings-toggle' }, node('span', {}, node('strong', {}, label), hint ? node('small', {}, hint) : null), node('input', { type: 'checkbox', checked, onChange }), node('span', { class: 'switch-track' })); }

async function updateSetting(label, updater, success = null) {
  const result = await mutate(label, (state) => { updater(state.settings); recordSemantic(state, 'setting_changed', { fieldCount: 1 }); return { ok: true }; }, success, { queue: false });
  if (result.ok && ['language_changed', 'theme_changed'].includes(label)) {
    const settings = currentState().settings;
    localStorage.setItem('progress-tracker-shell', JSON.stringify({ language: settings.language, theme: settings.theme }));
  }
  return result;
}

function renderGeneralSettings(state) {
  const section = node('div', { class: 'settings-stack' });
  const languageSelect = node('select', { value: language(), ariaLabel: tr('language'), onChange: (event) => { updateSetting('language_changed', (settings) => { settings.language = event.target.value; }, 'languageChanged'); } }, node('option', { value: 'zh-TW' }, tr('traditionalChinese')), node('option', { value: 'en' }, tr('english')));
  const themeSelect = node('select', { value: state.settings.theme, ariaLabel: tr('theme'), onChange: (event) => updateSetting('theme_changed', (settings) => { settings.theme = event.target.value; }, 'themeChanged') }, node('option', { value: 'system' }, tr('themeSystem')), node('option', { value: 'light' }, tr('themeLight')), node('option', { value: 'dark' }, tr('themeDark')));
  const pageSelect = node('select', { value: state.settings.defaultPage, ariaLabel: tr('defaultStartPage'), onChange: (event) => updateSetting('default_page_changed', (settings) => { settings.defaultPage = event.target.value; }, 'savedOffline') }, node('option', { value: 'categories' }, tr('pageCategories')), node('option', { value: 'today' }, tr('pageToday')), node('option', { value: 'reminders' }, tr('pageReminders')), node('option', { value: 'smart' }, tr('pageSmart')));
  const categorySelect = node('select', { value: state.settings.defaultCategoryId ?? '', ariaLabel: tr('defaultStartCategory'), onChange: (event) => updateSetting('default_category_changed', (settings) => { settings.defaultCategoryId = event.target.value; }, 'savedOffline') }, ...[...state.categories].sort((a, b) => a.order - b.order).map((category) => node('option', { value: category.id }, category.title)));
  section.append(settingCard(tr('language'), inputField(tr('language'), languageSelect)), settingCard(tr('theme'), inputField(tr('theme'), themeSelect)), settingCard(tr('defaultStart'), inputField(tr('defaultStartPage'), pageSelect), inputField(tr('defaultStartCategory'), categorySelect)));
  return section;
}

function settingCard(title, ...children) { return node('section', { class: 'setting-card' }, heading(title, 2), ...children); }

function renderItemSettings(state) {
  return node('div', { class: 'settings-stack' }, settingCard(tr('settingsItems'), settingsToggle(tr('enableSmartSort'), state.settings.smartSort, (event) => updateSetting('smart_sort_changed', (settings) => { settings.smartSort = event.target.checked; }, 'savedOffline'), tr('smartSortHint')), settingsToggle(tr('showCompleted'), state.settings.showCompleted !== false, (event) => updateSetting('show_completed_changed', (settings) => { settings.showCompleted = event.target.checked; }, 'savedOffline'))));
}

function renderReminderSettings(state) {
  const time = node('input', { type: 'time', value: state.settings.defaultReminderTime ?? '09:00', ariaLabel: tr('defaultReminderTime'), onChange: (event) => updateSetting('default_reminder_time_changed', (settings) => { settings.defaultReminderTime = event.target.value; }, 'savedOffline') });
  const capability = capabilityReport();
  const suggestion = state.settings.experimental?.enabled !== false && state.settings.experimental?.reminderLearning !== false ? reminderPatternSuggestion(state) : null;
  return node('div', { class: 'settings-stack' }, settingCard(tr('settingsReminders'), inputField(tr('defaultReminderTime'), time), suggestion ? node('p', { class: 'suggestion-note' }, tr('reminderPatternSuggestion', { time: suggestion.time, count: suggestion.count })) : null, node('p', { class: 'field-hint' }, tr('capabilityNoPush')), node('div', { class: 'capability-row' }, node('span', {}, tr('capabilityNoPush')), node('span', { class: 'metric-badge' }, capability.notifications ? '●' : '○'))));
}

function renderExperimentalSettings(state) {
  const experimental = state.settings.experimental ?? {};
  return node('div', { class: 'settings-stack' }, settingCard(tr('settingsExperimental'), settingsToggle(tr('experimentalMaster'), experimental.enabled !== false, (event) => updateSetting('experimental_master_changed', (settings) => { settings.experimental.enabled = event.target.checked; }, 'savedOffline')), settingsToggle(tr('experimentalSmart'), experimental.smart !== false, (event) => updateSetting('experimental_smart_changed', (settings) => { settings.experimental.smart = event.target.checked; }, 'savedOffline'), tr('smartSortHint')), settingsToggle(tr('experimentalRoutine'), experimental.routine !== false, (event) => updateSetting('experimental_routine_changed', (settings) => { settings.experimental.routine = event.target.checked; }, 'savedOffline')), settingsToggle(tr('experimentalLearning'), experimental.reminderLearning !== false, (event) => updateSetting('experimental_learning_changed', (settings) => { settings.experimental.reminderLearning = event.target.checked; }, 'savedOffline'))));
}

function renderDataSettings(state) {
  const deletedHistory = state.deleted.reduce((sum, entry) => sum + (entry.snapshot?.history?.length ?? 0), 0);
  const stats = { items: state.items.length, completed: state.items.filter((item) => item.status === 'completed').length, deleted: state.deleted.length, history: state.history.length + deletedHistory };
  const usage = storageBreakdown(state);
  const lastBackup = state.backupMeta.filter((backup) => backup.scope === 'full').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const section = node('div', { class: 'settings-stack' });
  section.append(settingCard(tr('dataOverview'), metricGrid([[tr('itemCount'), stats.items], [tr('completedCount'), stats.completed], [tr('deletedCount'), stats.deleted], [tr('historyCount'), stats.history], [tr('lastBackup'), lastBackup ? formatDateTime(language(), lastBackup.createdAt) : tr('notBackedUp')]])));
  section.append(renderExportCard(state), renderImportCard(), renderFullRestoreCard(), renderCloudCard(state), renderActiveConflicts(state), renderRecycleBin(state), renderRecoveryCard(state), renderDangerousDataCard());
  const labels = {
    metadata: 'usageMetadata', categories: 'usageCategories', items: 'usageItems', notes: 'usageNotes', tags: 'usageTags', history: 'usageHistory', reminders: 'usageReminders',
    today: 'usageToday', deleted: 'usageDeleted', sync: 'usageSync', conflicts: 'usageConflicts', backup: 'usageBackup',
    recovery: 'usageRecovery', diagnostics: 'usageDiagnostics', settings: 'usageSettings',
  };
  const estimate = state.capabilities?.storageEstimate ?? null;
  section.append(settingCard(
    tr('localStorage'),
    node('div', { class: 'usage-list' },
      node('strong', {}, `${tr('logicalUsageEstimate')}: ${formatBytes(usage.total)}`),
      ...Object.entries(usage.breakdown).map(([key, value]) => node('div', { class: 'usage-row' }, node('span', {}, tr(labels[key] ?? key)), node('span', {}, formatBytes(value)))),
    ),
    heading(tr('browserStorageEstimate'), 3),
    estimate ? node('div', { class: 'usage-list' },
      node('div', { class: 'usage-row' }, node('span', {}, tr('browserUsage')), node('span', {}, formatBytes(estimate.usage))),
      node('div', { class: 'usage-row' }, node('span', {}, tr('browserQuota')), node('span', {}, formatBytes(estimate.quota))),
      node('div', { class: 'usage-row' }, node('span', {}, tr('browserAvailable')), node('span', {}, formatBytes(estimate.available))),
    ) : node('p', { class: 'field-hint' }, tr('quotaUnavailable')),
  ));
  return section;
}

function conflictTypeLabel(type) { return tr({ order: 'conflictTypeOrder', parent: 'conflictTypeParent', delete_edit: 'conflictTypeDeleteEdit', field: 'conflictTypeField', membership: 'conflictTypeMembership', new_entity: 'conflictTypeNewEntity', new_item: 'conflictTypeNewItem' }[type] ?? 'syncConflict'); }

function conflictFieldLabel(conflict) {
  if (conflict.field === 'title' && conflict.entityType === 'category') return tr('categoryName');
  const key = {
    time: 'reminderTime', at: 'reminderAbsolute', offsetDays: 'reminderOffset', enabled: 'reminderEnable',
    source: 'todaySource', order: 'itemOrderSaved', location: 'selectParent',
  }[conflict.field];
  return key ? tr(key) : fieldLabel(conflict.field);
}

function conflictValue(value) {
  if (value === null || value === undefined) return tr('none');
  if (typeof value === 'string') return value || tr('none');
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

function renderConflictComparison(conflict, interactive = true) {
  const label = conflict.field ? conflictFieldLabel(conflict) : conflictTypeLabel(conflict.type);
  const entityLabel = tr({
    item: 'entityItem', category: 'entityCategory', reminder: 'entityReminder', today: 'entityToday',
    settings: 'entitySettings', sibling_order: 'entityOrder', smart_order: 'entityOrder', deleted: 'entityDeleted',
    history: 'entityHistory', backup: 'entityBackup',
  }[conflict.entityType] ?? 'entityItem');
  const card = node('article', { class: 'conflict-card' },
    node('div', { class: 'conflict-card-header' },
      node('div', {}, node('strong', {}, label), node('small', {}, `${conflictTypeLabel(conflict.type)} · ${entityLabel}`)),
      node('span', { class: 'sync-warning', ariaLabel: tr('syncConflict'), title: tr('syncConflict') }, '⚠'),
    ),
    node('div', { class: 'conflict-versions' },
      node('section', { class: 'conflict-version base' }, node('span', {}, tr('conflictBase')), node('pre', {}, conflictValue(conflict.baseState))),
      node('section', { class: 'conflict-version local' }, node('span', {}, tr('conflictLocal')), node('pre', {}, conflictValue(conflict.localState))),
      node('section', { class: 'conflict-version cloud' }, node('span', {}, tr('conflictCloud')), node('pre', {}, conflictValue(conflict.remoteState))),
    ),
  );
  if (interactive) card.append(node('div', { class: 'conflict-actions' },
    button(tr('chooseLocal'), () => resolveOneConflict(conflict.id, 'local'), { className: 'secondary-button' }),
    button(tr('chooseCloud'), () => resolveOneConflict(conflict.id, 'remote'), { className: 'secondary-button' }),
  ));
  return card;
}

function renderActiveConflicts(state) {
  if (!state.conflicts.length) return settingCard(tr('activeConflicts'), node('p', { class: 'muted' }, tr('noActiveConflicts')));
  const list = node('div', { class: 'conflict-list' });
  for (const conflict of state.conflicts) {
    list.append(renderConflictComparison(conflict));
  }
  return settingCard(tr('activeConflicts'), node('p', { class: 'warning-note' }, tr('conflictBlocked', { count: state.conflicts.length })), node('p', { class: 'field-hint' }, tr('conflictChoiceRequired')), list);
}

function formatBytes(bytes) { if (!bytes) return '0 B'; if (bytes < 1024) return `${bytes} B`; if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1048576).toFixed(2)} MB`; }
function metricGrid(values) { return node('div', { class: 'metric-grid' }, ...values.map(([label, value]) => node('div', { class: 'metric-card' }, node('span', {}, label), node('strong', {}, String(value))))); }

function renderExportCard(state) {
  return settingCard(tr('export'), node('p', { class: 'field-hint' }, tr('restoreSafety')), node('div', { class: 'button-grid' }, button(tr('exportFull'), () => exportData('full'), { className: 'primary-button', icon: '⇩' }), button(tr('exportCategory'), () => exportData('category', ui.categoryId), { className: 'secondary-button' }), button(tr('exportItem'), () => ui.detailId ? exportData('item', ui.detailId) : toast(tr('errorRequired'), 'error'), { className: 'secondary-button' })));
}

function exportData(scope, targetId = null) {
  const content = exportPTMD(currentState(), { scope, targetId });
  const filename = scope === 'full' ? `progress-tracker-backup-${dateKey(new Date())}.ptmd` : `progress-tracker-${scope}-${dateKey(new Date())}.ptmd`;
  downloadText(filename, content, 'text/markdown;charset=utf-8');
  if (scope === 'full') mutate('backup_created', (state) => { state.backupMeta.push({ id: newId('backup'), scope: 'full', format: 'PTMD', createdAt: isoNow(), independentlyRestorable: true, bytes: new TextEncoder().encode(content).byteLength }); return { ok: true }; }, 'backupCreated', { queue: false });
  else mutate('export', (state) => { recordSemantic(state, 'export', { scope }); return { ok: true }; }, null, { queue: false });
}

function renderImportCard() {
  const input = node('input', { type: 'file', accept: '.ptmd,.md,text/markdown,text/plain', ariaLabel: tr('importFile'), onChange: (event) => importFileSelected(event.target.files?.[0]) });
  return settingCard(tr('import'), node('p', { class: 'field-hint' }, tr('importAddOnly')), input, node('p', { class: 'field-hint' }, tr('importNoMutation')));
}

function renderFullRestoreCard() {
  const input = node('input', { type: 'file', accept: '.ptmd,.md,text/markdown,text/plain', ariaLabel: tr('restoreFull'), onChange: (event) => restoreFileSelected(event.target.files?.[0]) });
  return settingCard(tr('restoreFull'), node('p', { class: 'field-hint' }, tr('restoreSafety')), input, node('p', { class: 'field-hint' }, tr('dangerousHint')));
}

async function importFileSelected(file) {
  if (!file) return;
  try {
    const parsed = parsePTMD(await file.text());
    const preview = previewImport(currentState(), parsed, { language: language() });
    if (!preview.ok) { toast(tr(preview.reason === 'unsupported' ? 'errorUnsupportedFormat' : 'errorMalformedImport'), 'error'); return; }
    ui.importPreview = preview; ui.modal = { kind: 'import', preview }; scheduleRender();
  } catch (error) { toast(tr('errorMalformedImport'), 'error'); await repository.update('diagnostic_import_error', (state) => { recordError(state, error, 'import'); return { ok: true }; }, null, { queue: false }); }
}

async function restoreFileSelected(file) {
  if (!file) return;
  try {
    const parsed = parsePTMD(await file.text());
    const preview = restorePreview(currentState(), parsed);
    if (!preview.ok) { toast(tr('errorMalformedImport'), 'error'); return; }
    ui.restorePreview = preview; ui.modal = { kind: 'restore', preview }; scheduleRender();
  } catch (error) { toast(tr('errorMalformedImport'), 'error'); await repository.update('diagnostic_restore_error', (state) => { recordError(state, error, 'restore'); return { ok: true }; }, null, { queue: false }); }
}

function renderCloudCard(state) {
  const cloud = state.settings.cloudSync ?? {};
  const syncSummary = metricGrid([
    [tr('syncStatus'), cloud.status ? tr(cloud.status === 'authorized' ? 'cloudSyncConnected' : 'cloudSyncOff') : tr('cloudSyncOff')],
    [tr('syncAccount'), cloud.accountId ?? tr('notAvailable')],
    [tr('syncDataset'), state.meta.datasetId],
    [tr('syncPending'), state.syncChanges.length],
    [tr('syncConflict'), state.conflicts.length],
    [tr('syncLast'), cloud.lastSyncAt ? formatDateTime(language(), cloud.lastSyncAt) : tr('notAvailable')],
  ]);
  const clientId = node('input', { type: 'text', value: cloud.clientId ?? '', placeholder: tr('configureClientId'), ariaLabel: tr('configureClientId'), autocomplete: 'off' });
  const visibleBackups = Array.isArray(cloud.visibleBackups) ? cloud.visibleBackups : [];
  const backupList = cloud.authorized ? node('div', { class: 'cloud-backup-list' }, visibleBackups.length
    ? visibleBackups.map((file) => node('div', { class: 'cloud-backup-row' },
      node('div', {}, node('strong', {}, file.name), node('small', {}, file.modifiedTime ? formatDateTime(language(), file.modifiedTime) : '')),
      node('div', { class: 'button-grid' },
        button(tr('cloudBackupDownload'), () => downloadVisibleBackup(file), { className: 'text-button' }),
        button(tr('cloudBackupRestore'), () => restoreVisibleBackup(file), { className: 'text-button' }),
      ),
    ))
    : node('p', { class: 'muted' }, tr('cloudBackupEmpty'))) : null;
  const cloudActions = node('div', { class: 'button-grid' },
    button(tr('googleLogin'), () => authorizeGoogle(clientId.value), { className: 'secondary-button' }),
    button(tr('syncNow'), () => syncNow(), { className: 'secondary-button', disabled: !cloud.authorized || !cloud.enabled }),
    cloud.authorized ? button(tr('googleLogout'), logoutGoogle, { className: 'text-button' }) : null,
    button(tr(cloud.enabled ? 'disableCloudSync' : 'enableCloudSync'), () => updateSetting(cloud.enabled ? 'cloud_disabled' : 'cloud_enabled', (settings) => {
      const enabled = !cloud.enabled;
      settings.cloudSync = { ...(settings.cloudSync ?? {}), enabled, status: enabled && settings.cloudSync?.authorized ? 'authorized' : enabled ? 'configured' : 'paused' };
    }, 'savedOffline'), { className: 'text-button' }),
  );
  const backupActions = cloud.authorized ? node('div', { class: 'cloud-backup-actions' },
    button(tr('cloudBackupCreate'), createCloudBackup, { className: 'secondary-button' }),
    button(tr('cloudBackupRefresh'), refreshCloudBackups, { className: 'text-button' }),
    button(tr('cloudDatasetDelete'), () => openConfirm({ title: tr('cloudDatasetDelete'), message: tr('cloudDatasetDeleteQuestion'), danger: true, typed: true, onConfirm: deleteCloudDataset }), { className: 'danger-button' }),
  ) : null;
  const backupSection = cloud.authorized ? node('div', { class: 'cloud-backup-section' }, heading(tr('cloudBackupFolder'), 3), node('p', { class: 'field-hint' }, tr('cloudBackupFolder')), backupList) : null;
  return settingCard(tr('cloudSync'), node('p', { class: 'field-hint' }, cloud.authorized ? tr('cloudSyncConnected') : tr('cloudSyncOff')), syncSummary, inputField(tr('configureClientId'), clientId, tr('cloudSyncConfig')), cloudActions, backupActions, backupSection, node('p', { class: 'field-hint' }, tr('noFakeSync')));
}

async function authorizeGoogle(clientId) {
  driveSync.configure(clientId);
  if (!clientId) { toast(tr('cloudSyncConfig'), 'error'); return; }
  try {
    await driveSync.authorize();
    const accountId = await driveSync.accountIdentity();
    await mutate('cloud_authorized', (state) => { state.meta.accountId ??= accountId ?? null; state.settings.cloudSync = { ...(state.settings.cloudSync ?? {}), enabled: true, clientId, accountId, authorized: true, status: 'authorized' }; return { ok: true }; }, 'savedOffline', { queue: false });
    await syncNow();
  } catch (error) { toast(error.message.includes('available') ? tr('cloudSyncConfig') : tr('errorGeneric'), 'error'); await repository.update('diagnostic_drive_error', (state) => { recordError(state, error, 'drive'); return { ok: true }; }, null, { queue: false }); }
}

async function syncNow({ automatic = false } = {}) {
  const state = currentState();
  const cloud = state.settings.cloudSync ?? {};
  if (!cloud.enabled || !cloud.authorized || !navigator.onLine || syncInFlight) return;
  if (cloud.accountId && state.meta.accountId && cloud.accountId !== state.meta.accountId) {
    ui.modal = { kind: 'dataset', title: tr('datasetMismatch'), remote: null, remoteFile: null, accountMismatch: true };
    scheduleRender();
    return;
  }
  syncInFlight = true;
  try {
    let remote = await driveSync.pull(state.meta.datasetId, cloud.fileId ?? null);
    if (remote.status === 'empty') {
      openConfirm({ title: tr('cloudFirstSync'), message: `${tr('cloudFirstSync')} · ${tr('itemCount')}: ${state.items.length} · ${tr('deletedCount')}: ${state.deleted.length}`, onConfirm: () => pushCloud(state) });
      return;
    }
    if (remote.status === 'dataset_choice') {
      ui.modal = { kind: 'datasetChoice', title: tr('datasetChoice'), files: remote.files, reason: remote.reason };
      scheduleRender();
      return;
    }
    if (remote.status === 'wrong_dataset' && remote.file) remote = await driveSync.pullFile(remote.file, null);
    if (remote.status !== 'remote' || !remote.state) {
      toast(tr('noCloudFileSelected'), 'error');
      return;
    }
    if (remote.state?.meta?.accountId && state.meta.accountId && remote.state.meta.accountId !== state.meta.accountId) { ui.modal = { kind: 'dataset', title: tr('datasetMismatch'), remote: remote.state, remoteFile: remote.file, accountMismatch: true }; scheduleRender(); return; }
    if (remote.state?.meta?.datasetId && remote.state.meta.datasetId !== state.meta.datasetId) { ui.modal = { kind: 'dataset', title: tr('datasetMismatch'), remote: remote.state, remoteFile: remote.file }; scheduleRender(); return; }
    const base = state.meta.syncBaseState ?? state;
    const merge = mergeDatasets(base, state, remote.state);
    if (automatic && !merge.conflicts.length) { await applySyncMerge(merge, remote.file, { automatic: true }); return; }
    ui.modal = { kind: 'sync', title: tr('syncPreview'), merge, remote: remote.state, remoteFile: remote.file }; scheduleRender();
  } catch (error) { toast(tr('errorGeneric'), 'error'); await repository.update('diagnostic_sync_error', (draft) => { recordError(draft, error, 'sync'); return { ok: true }; }, null, { queue: false }); }
  finally { syncInFlight = false; }
}

async function chooseDatasetFile(file) {
  try {
    const expected = file.appProperties?.datasetId === currentState().meta.datasetId ? currentState().meta.datasetId : null;
    const remote = await driveSync.pullFile(file, expected);
    if (remote.status !== 'remote' || !remote.state) { toast(tr('errorGeneric'), 'error'); return; }
    if (remote.state.meta.datasetId !== currentState().meta.datasetId) {
      ui.modal = { kind: 'dataset', title: tr('datasetMismatch'), remote: remote.state, remoteFile: remote.file };
      scheduleRender();
      return;
    }
    const base = currentState().meta.syncBaseState ?? currentState();
    const merge = mergeDatasets(base, currentState(), remote.state);
    ui.modal = { kind: 'sync', title: tr('syncPreview'), merge, remote: remote.state, remoteFile: remote.file };
    scheduleRender();
  } catch (error) {
    toast(tr('errorGeneric'), 'error');
    await repository.update('diagnostic_dataset_file_error', (draft) => { recordError(draft, error, 'sync'); return { ok: true }; }, null, { queue: false });
  }
}

function renderDatasetChoiceModal(content, modal) {
  const reasonKey = modal.reason === 'duplicate_dataset_files' ? 'duplicateDatasetFiles' : 'datasetNotFound';
  content.append(node('p', {}, tr('datasetChoiceHint')), node('p', { class: 'warning-note' }, tr(reasonKey)));
  const list = node('div', { class: 'dataset-choice-list' });
  for (const file of modal.files ?? []) {
    list.append(node('div', { class: 'dataset-choice-row' },
      node('div', {}, node('strong', {}, file.appProperties?.datasetId ?? tr('unknown')), node('small', {}, file.modifiedTime ? formatDateTime(language(), file.modifiedTime) : file.id)),
      button(tr('useDataset'), () => chooseDatasetFile(file), { className: 'secondary-button' }),
    ));
  }
  content.append(list, node('div', { class: 'modal-actions' }, button(tr('cancel'), () => { ui.modal = null; scheduleRender(); }, { className: 'text-button' })));
}

function renderDatasetModal(content, modal) {
  content.append(node('p', {}, tr('datasetMismatch')), node('p', { class: 'warning-note' }, tr('datasetRisk')), node('div', { class: 'modal-actions vertical' }, button(tr('datasetMerge'), () => modal.remote ? showDatasetMerge(modal.remote, modal.remoteFile) : loadDatasetChoice('merge'), { className: 'secondary-button' }), button(tr('datasetSwitch'), () => modal.remote ? requestDatasetSwitch(modal.remote, modal.remoteFile) : loadDatasetChoice('switch'), { className: 'danger-button' })));
}

function requestDatasetSwitch(remote, remoteFile = null) {
  const gate = datasetSwitchGate(currentState());
  if (!gate.allowed) {
    ui.modal = { kind: 'backupGate', title: tr('backupGateTitle'), remote, remoteFile };
    scheduleRender();
    return;
  }
  openConfirm({ title: tr('datasetSwitch'), message: tr('datasetRisk'), danger: true, typed: true, onConfirm: () => switchToRemoteDataset(remote, remoteFile) });
}

function renderBackupGateModal(content, modal) {
  content.append(
    node('p', {}, tr('backupGateMessage')),
    node('div', { class: 'modal-actions vertical' },
      button(tr('createBackupFirst'), () => { exportData('full'); ui.modal = null; scheduleRender(); }, { className: 'primary-button' }),
      button(tr('continueWithoutBackup'), () => openConfirm({
        title: tr('riskAcknowledgeTitle'),
        message: tr('riskAcknowledgeMessage'),
        danger: true,
        typed: true,
        onConfirm: () => switchToRemoteDataset(modal.remote, modal.remoteFile, true),
      }), { className: 'danger-button' }),
      button(tr('cancel'), () => { ui.modal = null; scheduleRender(); }, { className: 'text-button' }),
    ),
  );
}

async function showDatasetMerge(remote, remoteFile = null) {
  const base = currentState().meta.syncBaseState ?? makeEmptyState();
  const merge = mergeDatasets(base, currentState(), remote);
  ui.modal = { kind: 'sync', title: tr('syncPreview'), merge, remoteFile, accountMismatch: true };
  scheduleRender();
}

async function adoptEmptyCloudDataset() {
  await repository.update('account_merge_empty_cloud', (draft) => { draft.meta.accountId = draft.settings.cloudSync?.accountId ?? draft.meta.accountId; draft.settings.cloudSync.status = 'authorized'; return { ok: true }; }, null, { queue: false });
  await pushCloud(currentState());
  ui.modal = null;
}

async function switchToEmptyDataset() {
  const empty = makeEmptyState();
  await switchToRemoteDataset(empty, null);
}

async function loadDatasetChoice(choice) {
  try {
    const remote = await driveSync.pull(null, null);
    if (remote.status === 'dataset_choice') {
      ui.modal = { kind: 'datasetChoice', title: tr('datasetChoice'), files: remote.files, reason: remote.reason, intent: choice };
      scheduleRender();
      return;
    }
    if (remote.status === 'empty') {
      if (choice === 'merge') openConfirm({ title: tr('cloudFirstSync'), message: `${tr('cloudFirstSync')} · ${tr('itemCount')}: ${currentState().items.length} · ${tr('deletedCount')}: ${currentState().deleted.length}`, onConfirm: adoptEmptyCloudDataset });
      else requestDatasetSwitch(makeEmptyState(), null);
      return;
    }
    if (choice === 'merge') await showDatasetMerge(remote.state, remote.file);
    else requestDatasetSwitch(remote.state, remote.file);
  } catch (error) {
    toast(tr('errorGeneric'), 'error');
    await repository.update('diagnostic_dataset_choice_error', (draft) => { recordError(draft, error, 'sync'); return { ok: true }; }, null, { queue: false });
  }
}

async function switchToRemoteDataset(remote, remoteFile = null, riskAccepted = false) {
  const current = clone(currentState());
  const incoming = clone(remote);
  incoming.meta.accountId = current.settings.cloudSync?.accountId ?? incoming.meta.accountId ?? null;
  const fileId = remoteFile?.id ?? incoming.settings.cloudSync?.fileId ?? null;
  incoming.settings.cloudSync = {
    ...(incoming.settings.cloudSync ?? {}),
    ...(current.settings.cloudSync ?? {}),
    enabled: true,
    authorized: true,
    status: 'authorized',
    fileId,
    selectedDatasetId: incoming.meta.datasetId,
    datasetFiles: { ...(current.settings.cloudSync?.datasetFiles ?? {}), ...(fileId ? { [incoming.meta.datasetId]: fileId } : {}) },
  };
  const prepared = prepareDatasetSwitch(current, incoming, { riskAccepted });
  if (!prepared.ok) { requestDatasetSwitch(remote, remoteFile); return; }
  const safety = await repository.createSafetySnapshot('dataset_switch');
  if (!safety.ok) { toast(tr('errorGeneric'), 'error'); return; }
  prepared.state.recoverySnapshots = [
    ...(prepared.state.recoverySnapshots ?? []).filter((snapshot) => snapshot.id !== prepared.safety.id),
    safety.snapshot,
  ];
  const result = await repository.replaceState(prepared.state, 'switch_dataset');
  if (result.ok) { ui.modal = null; toast(tr('datasetSwitchSuccess')); }
}

async function pushCloud(state) {
  const gate = canPushState(state);
  if (!gate.ok) { toast(tr('syncPushBlocked'), 'error'); return { ok: false, reason: gate.reason }; }
  try {
    const pushed = await driveSync.push(state, state.settings.cloudSync?.fileId ?? null);
    await mutate('sync_push', (draft) => {
      const base = clone(draft);
      delete base.meta.syncBaseState;
      base.syncChanges = [];
      draft.meta.syncBaseState = base;
      draft.meta.baseRevision = draft.meta.revision;
      draft.syncChanges = [];
      const fileId = pushed.file?.id ?? draft.settings.cloudSync?.fileId ?? null;
      draft.settings.cloudSync = {
        ...(draft.settings.cloudSync ?? {}),
        fileId,
        selectedDatasetId: draft.meta.datasetId,
        datasetFiles: { ...(draft.settings.cloudSync?.datasetFiles ?? {}), ...(fileId ? { [draft.meta.datasetId]: fileId } : {}) },
        lastSyncAt: isoNow(),
      };
      return { ok: true };
    }, 'savedOffline', { queue: false });
    return { ok: true, pushed };
  } catch (error) {
    toast(error.code === 'unresolved_conflicts' ? tr('syncPushBlocked') : tr('errorGeneric'), 'error');
    await repository.update('diagnostic_sync_push_error', (draft) => { recordError(draft, error, 'sync'); return { ok: true }; }, null, { queue: false });
    return { ok: false, error };
  }
}

async function applySyncMerge(merge, remoteFile = null, { automatic = false } = {}) {
  if (!merge?.state) return;
  const state = clone(merge.state);
  if (state.settings.cloudSync?.accountId && state.meta.accountId !== state.settings.cloudSync.accountId) state.meta.accountId = state.settings.cloudSync.accountId;
  const result = await repository.replaceState(state, 'sync_merge');
  if (!result.ok) return;
  try {
    let fileId = remoteFile?.id ?? ui.modal?.remoteFile?.id ?? currentState().settings.cloudSync?.fileId ?? null;
    let pushed = null;
    if (!merge.conflicts.length) pushed = await driveSync.push(currentState(), fileId);
    else if (merge.safeChanges) pushed = await driveSync.push(merge.cloudState, fileId);
    fileId = pushed?.file?.id ?? fileId;
    const blocked = new Set(merge.blockedEntities ?? []);
    await repository.update('sync_merge_complete', (draft) => {
      const base = clone(merge.conflicts.length ? merge.cloudState : draft);
      delete base.meta.syncBaseState;
      base.syncChanges = [];
      base.conflicts = [];
      draft.meta.syncBaseState = base;
      draft.meta.baseRevision = base.meta.revision;
      draft.settings.cloudSync = {
        ...(draft.settings.cloudSync ?? {}),
        fileId,
        selectedDatasetId: draft.meta.datasetId,
        datasetFiles: { ...(draft.settings.cloudSync?.datasetFiles ?? {}), ...(fileId ? { [draft.meta.datasetId]: fileId } : {}) },
        lastSyncAt: pushed ? isoNow() : draft.settings.cloudSync?.lastSyncAt ?? null,
      };
      draft.syncChanges = merge.conflicts.length
        ? draft.syncChanges.filter((change) => {
          const entities = change.entityKeys?.length ? change.entityKeys : (change.itemIds ?? []).map((id) => `item:${id}`);
          return !entities.length || entities.some((entity) => blocked.has(entity));
        })
        : [];
      return { ok: true };
    }, null, { queue: false });
    ui.modal = null;
    if (!automatic) toast(merge.conflicts.length ? tr('conflictSafeApplied', { count: merge.conflicts.length }) : tr('savedOffline'), merge.conflicts.length ? 'info' : 'success');
  } catch (error) { toast(tr('errorGeneric'), 'error'); await repository.update('diagnostic_sync_merge_error', (draft) => { recordError(draft, error, 'sync'); return { ok: true }; }, null, { queue: false }); }
}

async function createCloudBackup() {
  const state = currentState();
  if (!state.settings.cloudSync?.authorized) { toast(tr('cloudSyncOff'), 'error'); return; }
  try {
    const content = exportPTMD(state, { scope: 'full' });
    const fileName = `progress-tracker-backup-${dateKey(new Date())}.ptmd`;
    const result = await driveSync.pushVisibleBackup(content, fileName, state.meta.datasetId, state.settings.cloudSync.backupFolderId);
    await repository.update('cloud_backup_created', (draft) => {
      const cloud = draft.settings.cloudSync ?? {};
      cloud.backupFolderId = result.folder.id;
      cloud.visibleBackups = [{ ...result.file }, ...(cloud.visibleBackups ?? []).filter((file) => file.id !== result.file.id)];
      draft.settings.cloudSync = cloud;
      draft.backupMeta.push({ id: newId('backup'), scope: 'full', format: 'PTMD', location: 'google_drive_visible', fileId: result.file.id, createdAt: isoNow(), independentlyRestorable: true, bytes: new TextEncoder().encode(content).byteLength });
      recordSemantic(draft, 'export', { scope: 'cloud_backup' });
      return { ok: true };
    }, null, { queue: false });
    toast(tr('backupCreated'));
  } catch (error) {
    toast(tr('errorGeneric'), 'error');
    await repository.update('diagnostic_cloud_backup_error', (draft) => { recordError(draft, error, 'drive'); return { ok: true }; }, null, { queue: false });
  }
}

async function refreshCloudBackups() {
  const state = currentState();
  if (!state.settings.cloudSync?.authorized) return;
  try {
    const result = await driveSync.listVisibleBackups(state.meta.datasetId, state.settings.cloudSync.backupFolderId);
    await updateSetting('cloud_backup_listed', (settings) => { settings.cloudSync = { ...(settings.cloudSync ?? {}), visibleBackups: result.files }; }, 'savedOffline');
  } catch (error) {
    toast(tr('errorGeneric'), 'error');
    await repository.update('diagnostic_cloud_backup_list_error', (draft) => { recordError(draft, error, 'drive'); return { ok: true }; }, null, { queue: false });
  }
}

async function downloadVisibleBackup(file) {
  try {
    const content = await driveSync.pullVisibleBackup(file.id);
    downloadText(file.name, content, 'text/markdown;charset=utf-8');
  } catch (error) {
    toast(tr('errorGeneric'), 'error');
    await repository.update('diagnostic_cloud_backup_download_error', (draft) => { recordError(draft, error, 'drive'); return { ok: true }; }, null, { queue: false });
  }
}

async function restoreVisibleBackup(file) {
  try {
    const content = await driveSync.pullVisibleBackup(file.id);
    const parsed = parsePTMD(content);
    const preview = restorePreview(currentState(), parsed);
    if (!preview.ok) { toast(tr('errorMalformedImport'), 'error'); return; }
    ui.restorePreview = preview; ui.modal = { kind: 'restore', preview }; scheduleRender();
  } catch (error) {
    toast(tr('errorGeneric'), 'error');
    await repository.update('diagnostic_cloud_backup_restore_error', (draft) => { recordError(draft, error, 'drive'); return { ok: true }; }, null, { queue: false });
  }
}

async function deleteCloudDataset() {
  const fileId = currentState().settings.cloudSync?.fileId;
  if (!fileId) { toast(tr('cloudSyncOff'), 'error'); return; }
  try {
    await driveSync.deleteDataset(fileId);
    await updateSetting('cloud_dataset_deleted', (settings) => {
      const datasetFiles = { ...(settings.cloudSync?.datasetFiles ?? {}) };
      delete datasetFiles[currentState().meta.datasetId];
      settings.cloudSync = {
        ...(settings.cloudSync ?? {}),
        enabled: false,
        status: settings.cloudSync?.authorized ? 'paused' : settings.cloudSync?.clientId ? 'configured' : 'disabled',
        fileId: null,
        selectedDatasetId: null,
        datasetFiles,
        lastSyncAt: null,
      };
    }, 'savedOffline');
    ui.modal = null;
  } catch (error) {
    toast(tr('errorGeneric'), 'error');
    await repository.update('diagnostic_cloud_dataset_delete_error', (draft) => { recordError(draft, error, 'drive'); return { ok: true }; }, null, { queue: false });
  }
}

async function logoutGoogle() {
  driveSync.logout();
  await updateSetting('google_logout', (settings) => { settings.cloudSync = { ...(settings.cloudSync ?? {}), enabled: false, authorized: false, status: settings.cloudSync?.clientId ? 'configured' : 'disabled' }; }, 'savedOffline');
}

function renderRecycleBin(state) {
  const section = settingCard(tr('recentlyDeleted'), node('p', { class: 'field-hint' }, tr('deletedRetention')));
  if (!state.deleted.length) return node('div', { class: 'settings-stack' }, section, settingCard(tr('recentlyDeleted'), node('p', { class: 'muted' }, tr('emptyRecentlyDeleted'))));
  const actions = node('div', { class: 'button-grid' }, button(tr('restore'), () => restoreSelectedDeleted(), { className: 'secondary-button', disabled: !ui.selectedDeleted.size }), button(tr('deleteForever'), () => permanentlyDeleteSelected(), { className: 'danger-button', disabled: !ui.selectedDeleted.size }), button(tr('deleteAll'), () => permanentlyDeleteAll(), { className: 'danger-button' }));
  const list = node('div', { class: 'deleted-list' });
  for (const entry of state.deleted.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))) {
    const checked = ui.selectedDeleted.has(entry.id);
    list.append(node('label', { class: 'deleted-row' }, node('input', { type: 'checkbox', checked, onChange: (event) => { if (event.target.checked) ui.selectedDeleted.add(entry.id); else ui.selectedDeleted.delete(entry.id); scheduleRender(); } }), node('div', {}, node('strong', {}, entry.kind === 'category_tree' ? getCategoryTitle(entry) : entry.snapshot.items[0]?.title ?? tr('softDeleted')), node('small', {}, `${formatDateTime(language(), entry.deletedAt)} · ${tr('deletedRetention')}`))));
  }
  section.append(actions, list); return section;
}

function getCategoryTitle(entry) { return entry.snapshot?.category?.title ?? tr('softDeleted'); }

async function restoreSelectedDeleted() { const ids = [...ui.selectedDeleted]; const result = await mutate('restore', (state) => { for (const id of ids) restoreDeleted(state, id); return { ok: true }; }, 'restoredMessage'); if (result.ok) { ui.selectedDeleted.clear(); } }
function permanentlyDeleteSelected() { openConfirm({ title: tr('deleteForever'), message: tr('confirmPermanent'), danger: true, typed: true, onConfirm: () => permanentlyDeleteSelectedConfirmed() }); }
async function permanentlyDeleteSelectedConfirmed() { const ids = [...ui.selectedDeleted]; const result = await mutate('permanent_delete', (state) => { state.deleted = state.deleted.filter((entry) => !ids.includes(entry.id)); return { ok: true }; }, 'savedOffline', { queue: false }); if (result.ok) { ui.selectedDeleted.clear(); ui.modal = null; } }
function permanentlyDeleteAll() { openConfirm({ title: tr('deleteAll'), message: tr('confirmPermanent'), danger: true, typed: true, onConfirm: async () => { const result = await mutate('permanent_delete_all', (state) => { state.deleted = []; return { ok: true }; }, 'savedOffline', { queue: false }); if (result.ok) { ui.selectedDeleted.clear(); ui.modal = null; } } }); }

function renderRecoveryCard(state) {
  const snapshots = [...(state.migrationSnapshots ?? []), ...(state.recoverySnapshots ?? [])]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return settingCard(tr('recoveryData'), node('p', { class: 'field-hint' }, snapshots.length ? `${snapshots.length}` : tr('noBackup')), snapshots.map((snapshot) => node('div', { class: 'recovery-row' }, node('span', {}, `${snapshot.fromVersion} → ${snapshot.toVersion} · ${formatDateTime(language(), snapshot.createdAt)}`), button(tr('restore'), () => restoreSnapshotFlow(snapshot), { className: 'text-button' }))));
}

function restoreSnapshotFlow(snapshot) {
  try {
    const restored = restoreMigrationSnapshot(currentState(), snapshot);
    ui.modal = { kind: 'snapshotRestore', title: tr('restoreDiff'), snapshot, restored };
    scheduleRender();
  } catch (error) {
    toast(tr('errorRecovery'), 'error');
    void repository.update('diagnostic_snapshot_restore_preview_error', (draft) => { recordError(draft, error, 'restore'); return { ok: true }; }, null, { queue: false });
  }
}

function renderSnapshotRestoreModal(content, modal) {
  const current = currentState();
  const incoming = modal.restored;
  content.append(node('p', {}, tr('restoreSafety')), metricGrid([[tr('itemCount'), `${current.items.length} → ${incoming.items.length}`], [tr('categoryName'), `${current.categories.length} → ${incoming.categories.length}`], [tr('deletedCount'), `${current.deleted.length} → ${incoming.deleted.length}`], [tr('syncConflict'), `${current.conflicts.length} → ${incoming.conflicts.length}`]]), node('div', { class: 'modal-actions' }, button(tr('cancel'), () => { ui.modal = null; scheduleRender(); }, { className: 'text-button' }), button(tr('restore'), () => openConfirm({ title: tr('recoveryData'), message: tr('restoreConfirm', { value: language() === 'en' ? 'CONFIRM' : '確認' }), danger: true, typed: true, onConfirm: () => confirmSnapshotRestore(modal.restored) }), { className: 'danger-button' })));
}

async function confirmSnapshotRestore(restoredState) {
  const safety = await repository.createSafetySnapshot('manual_migration_restore');
  if (!safety.ok) { toast(tr('errorGeneric'), 'error'); return; }
  const restored = clone(restoredState);
  restored.recoverySnapshots = [...(restored.recoverySnapshots ?? []), safety.snapshot];
  const result = await repository.replaceState(restored, 'restore_migration_snapshot');
  if (result.ok) { ui.modal = null; toast(tr('restoreSuccess')); }
  else toast(tr('errorGeneric'), 'error');
}

function renderDangerousDataCard() { return settingCard(tr('dangerousOperations'), node('p', { class: 'field-hint' }, tr('dangerousHint')), button(tr('clearLocal'), () => openConfirm({ title: tr('clearLocal'), message: tr('confirmClearData'), danger: true, typed: true, onConfirm: clearAllLocalData }), { className: 'danger-button' })); }
async function clearAllLocalData() { const result = await repository.replaceState(makeEmptyState(), 'clear_local_data'); if (result.ok) { ui.modal = null; ui.categoryId = null; ui.detailId = null; toast(tr('savedOffline')); } }

function renderIconGuide() {
  const entries = [['○', 'iconActive'], ['✓', 'iconCompleted'], ['◉', 'iconRing'], ['★★', 'iconImportance'], ['▏', 'iconPriority'], ['›', 'iconChevron'], ['⠿', 'iconDrag'], ['⋯', 'iconMore'], ['⌁', 'iconReminder'], ['⚠', 'iconSync']];
  return settingCard(tr('iconGuideTitle'), ...entries.map(([glyph, key]) => node('div', { class: 'icon-guide-row' }, node('span', { class: 'icon-guide-symbol' }, glyph), node('span', {}, tr(key)))));
}

function renderDeveloperSettingsLegacy(state) {
  const report = diagnosticReport(state);
  const health = dataHealth(state);
  return node('div', { class: 'settings-stack' }, settingCard(tr('settingsDeveloper'), node('p', { class: 'field-hint' }, tr('developerInfo')), settingsToggle(tr('developerEnabled'), state.settings.developerEnabled === true, (event) => updateSetting('developer_enabled_changed', (settings) => { settings.developerEnabled = event.target.checked; }, 'savedOffline')), node('div', { class: 'button-grid' }, button(tr('exportDiagnostics'), () => { downloadText(`progress-tracker-diagnostics-${dateKey(new Date())}.json`, JSON.stringify(diagnosticReport(currentState()), null, 2), 'application/json'); mutate('diagnostic_export', (draft) => { recordSemantic(draft, 'export', { scope: 'diagnostics' }); return { ok: true }; }, null, { queue: false }); }, { className: 'secondary-button' }), button(tr('clearDiagnostics'), () => mutate('clear_diagnostics', (draft) => { clearDiagnostics(draft); return { ok: true }; }, 'savedOffline', { queue: false }), { className: 'danger-button' }))), settingCard(tr('developerDiagnostics'), metricGrid([[tr('historyCount'), report.semanticEventMetadata.eventCount], [tr('developerDiagnostics'), report.errors.length], [tr('performance'), report.performance.length]]), node('p', { class: 'field-hint' }, tr('diagnosticsNoContent'))), settingCard(tr('developerHealth'), node('div', { class: health.ok ? 'health-ok' : 'health-error' }, health.ok ? '✓' : `${health.errors.length}`, health.ok ? tr('savedOffline') : tr('errorGeneric')), node('pre', { class: 'diagnostic-pre' }, JSON.stringify(health, null, 2))));
}

function localizedHealthLabel(type) {
  return tr({
    duplicate_category_id: 'healthDuplicate',
    duplicate_id: 'healthDuplicate',
    invalid_category: 'healthInvalidCategory',
    orphan_item: 'healthOrphan',
    orphan_reminder: 'healthOrphan',
    reminder_inconsistency: 'healthOrphan',
    cross_category_parent: 'healthCrossCategory',
    hierarchy_cycle: 'healthCycle',
    invalid_date: 'healthInvalidDate',
    invalid_reminder_date: 'healthInvalidDate',
    reminder_without_due: 'healthReminder',
    reminder_calculation_exception: 'healthReminder',
  }[type] ?? 'healthOther');
}

function renderDeveloperSettings(state) {
  const report = diagnosticReport(state);
  const health = dataHealth(state);
  const controls = settingCard(
    tr('settingsDeveloper'),
    node('p', { class: 'field-hint' }, tr('developerInfo')),
    settingsToggle(tr('developerEnabled'), state.settings.developerEnabled === true, (event) => updateSetting('developer_enabled_changed', (settings) => { settings.developerEnabled = event.target.checked; }, 'savedOffline')),
    node('div', { class: 'button-grid' },
      button(tr('exportDiagnostics'), () => {
        downloadText(`progress-tracker-diagnostics-${dateKey(new Date())}.json`, JSON.stringify(diagnosticReport(currentState()), null, 2), 'application/json');
        mutate('diagnostic_export', (draft) => { recordSemantic(draft, 'export', { scope: 'diagnostics' }); return { ok: true }; }, null, { queue: false });
      }, { className: 'secondary-button' }),
      button(tr('clearDiagnostics'), () => mutate('clear_diagnostics', (draft) => { clearDiagnostics(draft); return { ok: true }; }, 'savedOffline', { queue: false }), { className: 'danger-button' }),
    ),
  );
  const diagnostics = settingCard(
    tr('developerDiagnostics'),
    metricGrid([
      [tr('historyCount'), report.semanticEventMetadata.eventCount],
      [tr('developerDiagnostics'), report.errors.length],
      [tr('performance'), report.performance.length],
    ]),
    node('p', { class: 'field-hint' }, tr('diagnosticsNoContent')),
  );
  const issues = health.ok
    ? node('p', { class: 'field-hint' }, tr('healthNoIssues'))
    : node('ul', { class: 'health-issues' }, ...health.errors.map((issue) => node('li', {}, localizedHealthLabel(issue.type))));
  const healthCard = settingCard(
    tr('developerHealth'),
    node('div', { class: health.ok ? 'health-ok' : 'health-error' }, health.ok ? '✓' : String(health.errors.length), health.ok ? tr('healthNoIssues') : tr('errorGeneric')),
    metricGrid([
      [tr('healthCategories'), health.counts.categories],
      [tr('healthItems'), health.counts.items],
      [tr('healthReminders'), health.counts.reminders],
      [tr('healthCheckedAt'), formatDateTime(language(), health.checkedAt)],
    ]),
    issues,
  );
  return node('div', { class: 'settings-stack' }, controls, diagnostics, healthCard);
}

function renderAboutSettings() { return node('div', { class: 'settings-stack' }, settingCard(tr('settingsAbout'), node('p', {}, tr('aboutText')), node('p', {}, tr('aboutScope')), node('p', { class: 'field-hint' }, tr('capabilityNoPush')))); }

function renderRecoveryMode(state) {
  const error = repository?.lastError;
  const context = state.meta.recoveryContext ?? {};
  const retry = async () => {
    const result = await repository.retryRecovery();
    toast(tr(result.ok ? 'recoveryRetrySuccess' : 'recoveryRetryFailed'), result.ok ? 'success' : 'error');
    if (result.ok) ui.page = currentState().settings.defaultPage ?? 'categories';
    scheduleRender();
  };
  return node('section', { class: 'recovery-mode page' },
    node('div', { class: 'recovery-icon' }, '⚠'),
    heading(tr('dataRecoveryMode'), 1),
    node('p', {}, tr('recoveryReadOnly')),
    node('p', { class: 'field-hint' }, tr('recoveryExportActual')),
    metricGrid([
      [tr('recoverySourceVersion'), context.sourceSchemaVersion ?? tr('notAvailable')],
      [tr('recoveryTargetVersion'), context.targetSchemaVersion ?? tr('notAvailable')],
      [tr('recoveryEnteredAt'), context.enteredAt ? formatDateTime(language(), context.enteredAt) : tr('notAvailable')],
    ]),
    error ? node('p', { class: 'warning-note' }, tr('errorRecovery')) : null,
    node('div', { class: 'button-grid' },
      button(tr('exportSnapshot'), () => downloadText(`progress-tracker-recovery-${dateKey(new Date())}.json`, JSON.stringify(repository.recoveryExport(), null, 2), 'application/json'), { className: 'primary-button' }),
      button(tr('recoveryDiagnostics'), () => {
        ui.modal = {
          kind: 'info',
          title: tr('recoveryDiagnostics'),
          body: node('div', { class: 'settings-stack' },
            node('p', { class: 'warning-note' }, tr('errorRecovery')),
            metricGrid([
              [tr('recoverySourceVersion'), context.sourceSchemaVersion ?? tr('notAvailable')],
              [tr('recoveryTargetVersion'), context.targetSchemaVersion ?? tr('notAvailable')],
              [tr('recoveryEnteredAt'), context.enteredAt ? formatDateTime(language(), context.enteredAt) : tr('notAvailable')],
            ]),
          ),
        };
        scheduleRender();
      }, { className: 'secondary-button' }),
      button(tr('retryRecovery'), retry, { className: 'secondary-button' }),
    ),
  );
}

function renderModal(state) {
  const modal = ui.modal;
  const backdrop = node('div', { class: 'modal-backdrop', onClick: (event) => { if (event.target === event.currentTarget) { ui.modal = null; scheduleRender(); } } });
  const box = node('section', { class: `modal-box ${modal.danger ? 'danger-modal' : ''}`, role: 'alertdialog', 'aria-modal': 'true' }, node('div', { class: 'modal-header' }, heading(modal.title ?? tr('more'), 2), iconButton('×', tr('close'), () => { ui.modal = null; scheduleRender(); })), node('div', { class: 'modal-content' }));
  const content = box.querySelector('.modal-content');
  if (modal.kind === 'prompt') renderPromptModal(content, modal);
  else if (modal.kind === 'confirm') renderConfirmModal(content, modal);
  else if (modal.kind === 'choice' || modal.kind === 'menu' || modal.kind === 'info') renderSimpleModal(content, modal);
  else if (modal.kind === 'move') renderMoveModal(content, state, getItem(state, modal.itemId));
  else if (modal.kind === 'duplicate') renderDuplicateModal(content, state, getItem(state, modal.itemId));
  else if (modal.kind === 'import') renderImportModal(content, modal.preview);
  else if (modal.kind === 'restore') renderRestoreModal(content, modal.preview);
  else if (modal.kind === 'snapshotRestore') renderSnapshotRestoreModal(content, modal);
  else if (modal.kind === 'sync') renderSyncModal(content, modal);
  else if (modal.kind === 'dataset') renderDatasetModal(content, modal);
  else if (modal.kind === 'datasetChoice') renderDatasetChoiceModal(content, modal);
  else if (modal.kind === 'backupGate') renderBackupGateModal(content, modal);
  else if (modal.kind === 'customSnooze') renderCustomSnoozeModal(content, modal);
  backdrop.append(box); return backdrop;
}

function renderSimpleModal(content, modal) { if (modal.message) content.append(node('p', {}, modal.message)); if (modal.body) content.append(modal.body); }

function renderPromptModal(content, modal) {
  const form = node('form', { class: 'modal-form', onSubmit: (event) => { stop(event); const value = form.querySelector('input')?.value ?? ''; if (!value.trim()) return; ui.modal = null; modal.onSubmit(value); } });
  const input = node('input', { type: 'text', value: modal.value ?? '', ariaLabel: modal.label, autocomplete: 'off' });
  form.append(inputField(modal.label, input), node('div', { class: 'modal-actions' }, button(tr('cancel'), () => { ui.modal = null; scheduleRender(); }, { className: 'text-button' }), button(tr('save'), () => form.requestSubmit(), { className: 'primary-button' })));
  content.append(form); setTimeout(() => input.focus(), 0);
}

function renderConfirmModal(content, modal) {
  const exact = language() === 'en' ? 'CONFIRM' : '確認';
  const form = node('form', { class: 'modal-form', onSubmit: async (event) => { stop(event); if (modal.typed && form.querySelector('input')?.value !== exact) return; ui.modal = null; await modal.onConfirm?.(); scheduleRender(); } });
  form.append(node('p', {}, modal.message));
  if (modal.typed) form.append(inputField(tr('typedConfirm', { value: exact }), node('input', { type: 'text', value: '', autocomplete: 'off', ariaLabel: tr('typedConfirm', { value: exact }), onInput: (event) => { form.querySelector('button[type="submit"]').disabled = event.target.value !== exact; } })));
  form.append(node('div', { class: 'modal-actions' }, button(tr('cancel'), () => { ui.modal = null; scheduleRender(); }, { className: 'text-button' }), node('button', { type: 'submit', class: modal.danger ? 'danger-button' : 'primary-button', disabled: modal.typed }, tr('confirm'))));
  content.append(form);
}

function renderCustomSnoozeModal(content, modal) {
  const form = node('form', { class: 'modal-form', onSubmit: (event) => { stop(event); submitCustomSnooze(modal); } });
  const input = node('input', { type: 'datetime-local', value: modal.value ?? '', ariaLabel: tr('snoozeCustom'), onInput: (event) => { modal.value = event.target.value; } });
  form.append(inputField(tr('snoozeCustom'), input), node('div', { class: 'modal-actions' }, button(tr('cancel'), () => { ui.modal = null; scheduleRender(); }, { className: 'text-button' }), button(tr('save'), () => form.requestSubmit(), { className: 'primary-button' })));
  content.append(form);
}

function parentOptions(state, item, categoryId, selectedParent = null) {
  const candidates = state.items.filter((candidate) => candidate.categoryId === categoryId && candidate.id !== item?.id && (!item || !descendantsOf(state, item.id).some((descendant) => descendant.id === candidate.id))).sort((a, b) => a.title.localeCompare(b.title));
  return [node('option', { value: '', selected: !selectedParent }, tr('categoryRoot')), ...candidates.map((candidate) => node('option', { value: candidate.id, selected: candidate.id === selectedParent }, `${'　'.repeat(itemPath(state, candidate.id).length)}${candidate.title}`))];
}

function renderMoveModal(content, state, item) {
  if (!item) return;
  ui.moveForm ??= { categoryId: item.categoryId, parentId: item.parentId };
  const categorySelect = node('select', { value: ui.moveForm.categoryId, ariaLabel: tr('selectCategory'), onChange: (event) => { ui.moveForm.categoryId = event.target.value; ui.moveForm.parentId = null; scheduleRender(); } }, ...[...state.categories].sort((a, b) => a.order - b.order).map((category) => node('option', { value: category.id, selected: category.id === ui.moveForm.categoryId }, category.title)));
  const parentSelect = node('select', { value: ui.moveForm.parentId ?? '', ariaLabel: tr('selectParent'), onChange: (event) => { ui.moveForm.parentId = event.target.value || null; scheduleRender(); } }, ...parentOptions(state, item, ui.moveForm.categoryId, ui.moveForm.parentId));
  const count = descendantsOf(state, item.id).length;
  const check = canMove(state, item.id, { categoryId: ui.moveForm.categoryId, parentId: ui.moveForm.parentId });
  const impact = moveImpact(state, item.id, ui.moveForm);
  const derivedChange = impact.ok && (impact.dueChanges.length || impact.reminderChanges.length);
  const impactText = impact.warnings.length ? tr('moveConflictWarning') : derivedChange ? tr('moveDerivedChange', { due: impact.dueChanges.length, reminders: impact.reminderChanges.length }) : tr('moveSafe');
  const form = node('form', { class: 'modal-form', onSubmit: (event) => { stop(event); if (check.ok) performMove(item, ui.moveForm); } }, node('p', {}, count ? tr('moveImpact', { count }) : tr('moveSafe')), node('div', { class: `impact-preview ${impact.warnings.length ? 'warning' : 'safe'}` }, impactText), inputField(tr('selectCategory'), categorySelect), inputField(tr('selectParent'), parentSelect), node('div', { class: 'modal-actions' }, button(tr('cancel'), () => { ui.modal = null; ui.moveForm = null; scheduleRender(); }, { className: 'text-button' }), node('button', { type: 'submit', class: 'primary-button', disabled: !check.ok }, tr('move'))));
  content.append(form);
}

async function performMove(item, target) {
  const result = await mutate('move', (state) => moveSubtree(state, item.id, target), 'itemMoved');
  if (result.ok) { ui.modal = null; ui.moveForm = null; }
}

function renderDuplicateModal(content, state, item) {
  if (!item) return;
  ui.duplicateForm ??= { title: `${item.title}${language() === 'en' ? ' (copy)' : '（副本）'}`, categoryId: item.categoryId, parentId: item.parentId, includeChildren: true, copyNotes: true, referenceDate: localDateInput(new Date().toISOString()) };
  const formState = ui.duplicateForm;
  const title = node('input', { type: 'text', value: formState.title, ariaLabel: tr('duplicateName'), onInput: (event) => { formState.title = event.target.value; } });
  const categorySelect = node('select', { value: formState.categoryId, ariaLabel: tr('duplicateTarget'), onChange: (event) => { formState.categoryId = event.target.value; formState.parentId = null; scheduleRender(); } }, ...[...state.categories].sort((a, b) => a.order - b.order).map((category) => node('option', { value: category.id, selected: category.id === formState.categoryId }, category.title)));
  const parentSelect = node('select', { value: formState.parentId ?? '', ariaLabel: tr('selectParent'), onChange: (event) => { formState.parentId = event.target.value || null; } }, ...parentOptions(state, item, formState.categoryId, formState.parentId));
  const form = node('form', { class: 'modal-form', onSubmit: async (event) => { stop(event); const result = await duplicateItem(item, formState); if (result.ok) { ui.modal = null; ui.duplicateForm = null; } } }, inputField(tr('duplicateName'), title), inputField(tr('duplicateTarget'), categorySelect), inputField(tr('selectParent'), parentSelect), inputField(tr('duplicateReferenceDate'), node('input', { type: 'date', value: formState.referenceDate, onInput: (event) => { formState.referenceDate = event.target.value; } })), settingsToggle(tr('includeChildren'), formState.includeChildren, (event) => { formState.includeChildren = event.target.checked; }), settingsToggle(tr('copyNotes'), formState.copyNotes, (event) => { formState.copyNotes = event.target.checked; }), node('p', { class: 'field-hint' }, tr('dateShift')), node('p', { class: 'field-hint' }, tr('noAbsoluteReminderCopy')), node('div', { class: 'modal-actions' }, button(tr('cancel'), () => { ui.modal = null; ui.duplicateForm = null; scheduleRender(); }, { className: 'text-button' }), node('button', { type: 'submit', class: 'primary-button' }, tr('duplicate'))));
  content.append(form);
}

async function duplicateItem(item, formState) {
  return mutate('duplicate', (state) => duplicateSubtree(state, item.id, { categoryId: formState.categoryId, parentId: formState.parentId, title: formState.title, includeChildren: formState.includeChildren, copyNotes: formState.copyNotes, referenceDate: formState.referenceDate ? dateFromInput(formState.referenceDate) : null, suffix: language() === 'en' ? ' (copy)' : '（副本）' }), 'duplicateSuccess');
}

function renderImportModal(content, preview) {
  content.append(node('p', {}, tr('importAddOnly')), metricGrid([[tr('itemCount'), preview.importedItems.length], [tr('categoryName'), preview.importedCategories.length], [tr('importSameId', { count: preview.skippedCount }), preview.skippedCount], [tr('importIsolated'), preview.isolated ? tr('yes') : tr('no')]]), node('div', { class: 'modal-actions' }, button(tr('cancel'), () => { ui.modal = null; ui.importPreview = null; scheduleRender(); }, { className: 'text-button' }), button(tr('importConfirm'), () => confirmImport(preview), { className: 'primary-button' })));
}

async function confirmImport(preview) {
  const result = applyImportPreview(currentState(), preview);
  if (!result.ok) { toast(tr('errorMalformedImport'), 'error'); return; }
  const committed = await repository.replaceState(result.state, 'import_add_only');
  if (committed.ok) { ui.modal = null; ui.importPreview = null; toast(tr('savedOffline')); }
}

function renderRestoreModal(content, preview) {
  content.append(node('p', {}, tr('restoreSafety')), metricGrid([[tr('itemCount'), preview.summary.incomingItems], [tr('completedCount'), preview.summary.added], [tr('deletedCount'), preview.summary.deleted], [tr('categoryName'), preview.summary.categories]]), node('div', { class: 'modal-actions' }, button(tr('cancel'), () => { ui.modal = null; ui.restorePreview = null; scheduleRender(); }, { className: 'text-button' }), button(tr('restoreFull'), () => openConfirm({ title: tr('restoreFull'), message: tr('restoreConfirm', { value: language() === 'en' ? 'CONFIRM' : '確認' }), danger: true, typed: true, onConfirm: () => confirmFullRestore(preview) }), { className: 'danger-button' })));
}

async function confirmFullRestore(preview) {
  const safety = await repository.createSafetySnapshot('full_restore');
  if (!safety.ok) { toast(tr('errorGeneric'), 'error'); return; }
  const incoming = clone(preview.incoming);
  incoming.recoverySnapshots = [...(incoming.recoverySnapshots ?? []), safety.snapshot];
  const result = await repository.replaceState(incoming, 'full_restore');
  if (result.ok) { ui.modal = null; ui.restorePreview = null; toast(tr('restoreSuccess')); }
  else toast(tr('errorGeneric'), 'error');
}

function renderSyncModal(content, modal) {
  const merge = modal.merge;
  content.append(node('p', {}, merge.conflicts.length ? tr('syncConflict') : tr('savedOffline')), metricGrid([[tr('itemCount'), merge.state.items.length], [tr('syncConflict'), merge.conflicts.length], [tr('historyCount'), merge.state.history.length]]));
  if (merge.conflicts.length) {
    content.append(node('p', { class: 'warning-note' }, tr('conflictBlocked', { count: merge.conflicts.length })), node('p', { class: 'field-hint' }, tr('conflictChoiceRequired')));
    const preview = node('div', { class: 'conflict-list sync-conflict-preview' });
    for (const conflict of merge.conflicts) preview.append(renderConflictComparison(conflict, false));
    content.append(preview);
  }
  content.append(node('div', { class: 'modal-actions' }, button(tr('cancel'), () => { ui.modal = null; scheduleRender(); }, { className: 'text-button' }), button(merge.conflicts.length ? tr('applySafeSync') : tr('confirm'), () => applySyncMerge(merge, modal.remoteFile), { className: 'primary-button' })));
}
