import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { messages } from '../src/i18n.js';

test('approved mobile homepage is content-first and has accessible alternate search/create paths', async () => {
  const app = await readFile('src/app.js', 'utf8');
  const css = await readFile('src/styles.css', 'utf8');
  assert.match(app, /function renderMobileFab\(state\)/);
  assert.match(app, /function renderMobileSearchAffordance\(state\)/);
  assert.match(app, /openQuickCreate\(\{ categoryId: category\.id \}\)/);
  assert.doesNotMatch(app, /renderQuickCreate\(state, category\)/);
  assert.match(app, /if \(!isMobileViewport\(\) \|\| recoveryMode\) shell\.append\(renderTopbar\(state\)\)/);
  assert.match(app, /if \(!isMobileViewport\(\)\) page\.append\(header\)/);
  assert.match(app, /event\.key === '\/'/);
  assert.match(app, /if \(isMobileViewport\(\) && ui\.page === 'categories'\) openSearchDrawer\(\)/);
  assert.match(app, /const affordance = node\('div'/);
  assert.match(app, /role: 'button'/);
  assert.match(app, /onKeydown: \(event\) =>/);
  assert.doesNotMatch(app, /mobile-search-affordance[\s\S]{0,260}onClick: openSearchDrawer/);
  assert.match(app, /if \(shouldCaptureSearchPull\(previous, result\)\) record\.origin\?\.setPointerCapture/);
  assert.doesNotMatch(app, /sessions\.set\(event\.pointerId, session\);\s*origin\?\.setPointerCapture/);
  assert.match(app, /const affordance = target\?\.closest\?\.\('\.mobile-search-affordance'\)/);
  assert.match(app, /canStartSearchPull\(\{ isAffordance: Boolean\(affordance\)/);
  assert.match(app, /className: 'item-detail-trigger'/);
  assert.match(app, /className: 'child-create-trigger'/);
  assert.match(app, /function createUnnamedChild\(parent\)/);
  assert.match(app, /tapToName/);
  assert.match(app, /startInlineRename\(item\)/);
  assert.doesNotMatch(app, /function openItemMenu\(/);
  assert.doesNotMatch(app, /function renderQuickActionRow\(/);
  assert.doesNotMatch(app, /className: 'detail-chevron'/);
  assert.doesNotMatch(app, /className: 'quick-actions-trigger'/);
  assert.match(css, /--bottom-nav-height: 74px/);
  assert.match(css, /--bottom-nav-clearance: calc\(var\(--bottom-nav-height\)/);
  assert.match(css, /\.mobile-fab \{/);
  assert.match(css, /\.mobile-search-drawer \{/);
  assert.match(css, /--mobile-search-collapsed-height: 36px/);
  assert.doesNotMatch(css, /--mobile-list-floating-clearance/);
  assert.match(css, /\.mobile-search-affordance \{[\s\S]*touch-action: none;/);
  assert.match(css, /\.category-page \.tree-list-holder,\s*\.category-page \.search-list-holder \{ height: calc\(100svh - var\(--mobile-list-top-offset\) - var\(--bottom-nav-clearance\)/);
  assert.match(css, /\.item-main \{[\s\S]*touch-action: pan-y;/);
  assert.match(css, /\.item-row-main \{[\s\S]*touch-action: pan-y;/);
  assert.match(css, /--row-state-column: var\(--touch-target\)/);
  assert.match(css, /\.tree-child \.item-row-main\.leaf \{ grid-template-columns: var\(--touch-target\) var\(--row-state-column\) minmax\(0, 1fr\) calc\(var\(--touch-target\) \* 2 \+ 4px\); \}/);
  assert.match(css, /\.item-title-input \{/);
  assert.match(css, /\.child-create-trigger/);
  assert.match(css, /\.topbar \{ display: none; \}/);
  assert.match(css, /\.category-page \.page-header \{ display: none; \}/);
  assert.doesNotMatch(css, /body\s*\{[^}]*touch-action\s*:\s*none/);
});

test('child state control has a dedicated full hit-target column before title content', async () => {
  const css = await readFile('src/styles.css', 'utf8');
  const contract = css.slice(css.lastIndexOf('/* Final row interaction contract'));
  assert.match(css, /--row-state-column: var\(--touch-target\)/);
  assert.match(contract, /\.item-row-main\.parent \{ grid-template-columns: var\(--touch-target\) var\(--row-state-column\)/);
  assert.match(contract, /\.item-row-main\.leaf \{ grid-template-columns: var\(--touch-target\) var\(--row-state-column\)/);
  assert.match(contract, /\.tree-child \.item-row-main\.leaf \{ grid-template-columns: var\(--touch-target\) var\(--row-state-column\)/);
  assert.doesNotMatch(contract, /\.tree-child \.item-row-main\.leaf \{ grid-template-columns: var\(--touch-target\) 30px/);
});

test('new calendar and search UI copy exists in both strict locales', () => {
  const keys = [
    'pullToSearch', 'recentSearches', 'quickFilters', 'filterHasProgress', 'filterOverdue',
    'addToDeviceCalendar', 'calendarAlert', 'calendarAlertNone', 'calendarAlert10m',
    'calendarAlert1d', 'calendarDateRequired', 'calendarPrepared', 'calendarImportHonesty',
    'tapToName', 'addChildToItem', 'directDrag', 'openDetail',
  ];
  for (const key of keys) {
    assert.notEqual(messages['zh-TW'][key], undefined, `missing zh-TW key ${key}`);
    assert.notEqual(messages.en[key], undefined, `missing en key ${key}`);
  }
});

test('calendar integration is a read-only export path with no fake synced state', async () => {
  const app = await readFile('src/app.js', 'utf8');
  const calendar = await readFile('src/calendar.js', 'utf8');
  assert.match(app, /buildItemCalendarEvent/);
  assert.match(app, /shareCalendarFile/);
  assert.match(app, /calendarImportHonesty/);
  assert.doesNotMatch(app, /calendarSynced/);
  assert.match(calendar, /BEGIN:VALARM/);
  assert.match(calendar, /VALUE=DATE/);
  assert.match(calendar, /navigatorObject\.share/);
  assert.match(calendar, /AbortError/);
});

test('final row interaction routing keeps mutations on explicit controls', async () => {
  const app = await readFile('src/app.js', 'utf8');
  const gesture = await readFile('src/gesture.js', 'utf8');
  const controller = await readFile('src/gesture-controller.js', 'utf8');
  assert.match(app, /const detail = iconButton\('⋯', tr\('detail'/);
  assert.match(app, /else openDetail\(item\.id\)/);
  assert.match(app, /const addChild = iconButton\('\+', tr\('addChildToItem'/);
  assert.match(app, /createItem\(draft, \{ categoryId: currentParent\.categoryId, parentId, title: '', allowUnnamed: true \}\)/);
  assert.match(app, /if \(zone === GESTURE_ZONES\.title\)/);
  assert.match(app, /onKeydown: unnamed \? \(event\) =>/);
  assert.match(app, /onBlur: \(event\) => \{ void commitInlineRename\(item\.id, event\.target\.value\); \}/);
  assert.match(app, /tree-expand-trigger/);
  assert.match(app, /renderTodayField\(state, item\)/);
  assert.match(gesture, /event\.type === 'handleStart'/);
  assert.match(controller, /process\(record, \{ type: 'handleStart'/);
  assert.match(app, /ui\.searchDrawer === SEARCH_DRAWER_STATES\.CLOSED/);
  assert.doesNotMatch(app, /executeItemTapAction/);
});
