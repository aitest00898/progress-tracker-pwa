import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEmptyState } from '../src/schema.js';
import { diagnosticReport, recordError, recordSemantic } from '../src/diagnostics.js';
import { documentShell, getLocale, messages, relativeDueText, t } from '../src/i18n.js';

test('diagnostics are off by default and exported reports contain no user content', () => {
  const state = makeEmptyState('2026-08-10T09:00:00.000Z'); state.items.push({ id: 'item', title: 'SECRET TITLE', notes: 'PRIVATE NOTE' });
  recordSemantic(state, 'item_clicked', { title: 'SECRET TITLE' }); recordError(state, new Error('SECRET TITLE'), 'test');
  assert.equal(state.diagnostics.events.length, 0); assert.equal(state.diagnostics.errors.length, 0);
  state.settings.developerEnabled = true; recordSemantic(state, 'item_clicked', { page: 'detail', title: 'SECRET TITLE' }); recordError(state, new Error('synthetic'), 'test'); const report = diagnosticReport(state);
  assert.equal(report.privacy.includesUserContent, false); assert.equal(JSON.stringify(report).includes('SECRET TITLE'), false); assert.equal(JSON.stringify(report).includes('PRIVATE NOTE'), false);
});

test('localization keeps presentation strings localized', () => {
  assert.equal(getLocale(undefined), 'zh-TW'); assert.equal(t('zh-TW', 'today'), '今天'); assert.equal(t('en', 'today'), 'Today'); assert.equal(t('en', 'progressPercent', { value: 100 }), '100%'); assert.equal(t('zh-TW', 'progressPercent', { value: 100 }), '100%');
  for (const key of Object.keys(messages['zh-TW'])) assert.ok(Object.prototype.hasOwnProperty.call(messages.en, key), `English locale missing ${key}`);
  for (const key of Object.keys(messages.en)) assert.ok(Object.prototype.hasOwnProperty.call(messages['zh-TW'], key), `Traditional Chinese locale missing ${key}`);
  for (const [key, value] of Object.entries(messages.en)) assert.equal(/[\u3400-\u9fff]/u.test(String(value)), false, `English locale leaks CJK text at ${key}`);
  assert.deepEqual(documentShell('en'), {
    lang: 'en',
    title: 'Progress Tracker',
    description: 'A local-first, offline-ready progress tracker with unlimited hierarchy.',
    manifest: './manifest.en.webmanifest',
  });
  assert.equal(documentShell('zh-TW').lang, 'zh-Hant-TW');
  assert.equal(documentShell('zh-TW').manifest, './manifest.webmanifest');
  const now = new Date('2026-08-10T09:00:00.000Z');
  assert.equal(relativeDueText('zh-TW', '2026-08-09T09:00:00.000Z', now), '逾期 1 天');
  assert.equal(relativeDueText('en', '2026-08-11T09:00:00.000Z', now), 'Tomorrow');
});
