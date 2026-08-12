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
  assert.match(css, /--bottom-nav-height: 74px/);
  assert.match(css, /--bottom-nav-clearance: calc\(var\(--bottom-nav-height\)/);
  assert.match(css, /\.mobile-fab \{/);
  assert.match(css, /\.mobile-search-drawer \{/);
  assert.match(css, /\.topbar \{ display: none; \}/);
  assert.match(css, /\.category-page \.page-header \{ display: none; \}/);
  assert.doesNotMatch(css, /body\s*\{[^}]*touch-action\s*:\s*none/);
});

test('new calendar and search UI copy exists in both strict locales', () => {
  const keys = [
    'pullToSearch', 'recentSearches', 'quickFilters', 'filterHasProgress', 'filterOverdue',
    'addToDeviceCalendar', 'calendarAlert', 'calendarAlertNone', 'calendarAlert10m',
    'calendarAlert1d', 'calendarDateRequired', 'calendarPrepared', 'calendarImportHonesty',
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
