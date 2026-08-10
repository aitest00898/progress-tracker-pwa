import test from 'node:test';
import assert from 'node:assert/strict';
import { nextThemePreference, normalizeThemePreference, resolveTheme } from '../src/appearance.js';
import { makeEmptyState, normalizeState } from '../src/schema.js';

test('appearance preference persists without mutating user data', () => {
  const state = makeEmptyState('2026-08-10T09:00:00.000Z');
  state.categories[0].title = 'User category';
  state.settings.theme = 'dark';
  const normalized = normalizeState(state);
  assert.equal(normalized.settings.theme, 'dark');
  assert.equal(normalized.categories[0].title, 'User category');
  assert.equal(normalizeThemePreference('unexpected'), 'system');
});

test('system appearance follows the live color-scheme while explicit choices override it', () => {
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.deepEqual(['system', 'dark', 'light', 'system'], [
    'system',
    nextThemePreference('system'),
    nextThemePreference('dark'),
    nextThemePreference('light'),
  ]);
});
