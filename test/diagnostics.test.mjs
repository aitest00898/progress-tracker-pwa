import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEmptyState } from '../src/schema.js';
import { diagnosticReport, recordError, recordPerformance, recordSemantic, sanitizeDiagnosticMessage, serializeSafeDiagnosticError } from '../src/diagnostics.js';
import { documentShell, getLocale, messages, relativeDueText, t } from '../src/i18n.js';

test('diagnostics are off by default and exported reports contain no user content', () => {
  const state = makeEmptyState('2026-08-10T09:00:00.000Z'); state.items.push({ id: 'item', title: 'SECRET TITLE', notes: 'PRIVATE NOTE' });
  recordSemantic(state, 'item_clicked', { title: 'SECRET TITLE' }); recordError(state, new Error('SECRET TITLE'), 'test');
  assert.equal(state.diagnostics.events.length, 0); assert.equal(state.diagnostics.errors.length, 0);
  state.settings.developerEnabled = true; recordSemantic(state, 'item_clicked', { page: 'detail', title: 'SECRET TITLE' }); recordError(state, new Error('synthetic'), 'test'); const report = diagnosticReport(state);
  assert.equal(report.privacy.includesUserContent, false); assert.equal(JSON.stringify(report).includes('SECRET TITLE'), false); assert.equal(JSON.stringify(report).includes('PRIVATE NOTE'), false);
});

test('diagnostic errors preserve safe technical context without leaking URLs, tokens, paths, or user text', () => {
  const state = makeEmptyState('2026-08-10T09:00:00.000Z');
  state.settings.developerEnabled = true;
  const databaseError = new DOMException('The database request failed because the quota was exceeded', 'QuotaExceededError');
  recordError(state, databaseError, 'storage');
  recordError(state, new Error('Network request failed for https://drive.google.com/file?id=SECRET and Bearer ya29.SECRET_TOKEN'), 'drive');
  recordError(state, new Error('PRIVATE NOTE from SECRET TITLE'), 'import');
  const local = state.diagnostics.errors;
  assert.equal(local[0].name, 'QuotaExceededError');
  assert.notEqual(local[0].name, local[0].message);
  assert.equal(local[0].classification, 'technical');
  assert.match(sanitizeDiagnosticMessage('Network request failed for https://example.com/secret'), /\[redacted-url\]/);
  assert.match(sanitizeDiagnosticMessage('Bearer ya29.secret-token'), /\[redacted-token\]/);
  assert.match(sanitizeDiagnosticMessage('/Users/joe/private/notes.txt'), /\[redacted-path\]/);
  assert.equal(local[2].message, null);
  const report = diagnosticReport(state);
  const json = JSON.stringify(report);
  assert.equal(json.includes('SECRET TITLE'), false);
  assert.equal(json.includes('PRIVATE NOTE'), false);
  assert.equal(json.includes('SECRET_TOKEN'), false);
  assert.equal(json.includes('https://'), false);
  assert.equal(json.includes('stack'), false);
  assert.equal(report.errors[0].message, local[0].message);
  assert.equal(report.errors[1].message, undefined);
  assert.equal(report.errors[1].classification, 'redacted');
  assert.deepEqual(Object.keys(serializeSafeDiagnosticError(local[0])).sort(), ['at', 'classification', 'errorCode', 'id', 'message', 'name', 'source']);
});

test('diagnostic error retention keeps the newest 500 entries and disabled collection stays empty', () => {
  const state = makeEmptyState('2026-08-10T09:00:00.000Z');
  for (let index = 0; index < 4; index += 1) recordError(state, new Error(`user text ${index}`), 'test');
  assert.equal(state.diagnostics.errors.length, 0);
  state.settings.developerEnabled = true;
  for (let index = 0; index < 501; index += 1) recordError(state, new Error(`State validation failed ${index}`), 'test');
  assert.equal(state.diagnostics.errors.length, 500);
  assert.equal(state.diagnostics.errors.at(-1).message, 'State validation failed 500');
});

test('diagnostic export sanitizes legacy performance metadata at the output boundary', () => {
  const state = makeEmptyState('2026-08-10T09:00:00.000Z');
  state.settings.developerEnabled = true;
  recordPerformance(state, 'search', 12.3456, { itemCount: 4, title: 'SECRET TITLE', path: '/Users/joe/private/notes.md' });
  state.performance.push({ id: 'legacy', metric: 'legacy', durationMs: 4, metadata: { notes: 'PRIVATE NOTE', url: 'https://example.com/secret' }, at: '2026-08-10T09:00:00.000Z' });
  state.diagnostics.aggregates['SECRET TITLE'] = { count: 1, firstAt: '2026-08-10T09:00:00.000Z', lastAt: '2026-08-10T09:00:00.000Z' };
  const report = diagnosticReport(state);
  const json = JSON.stringify(report);
  assert.equal(json.includes('SECRET TITLE'), false);
  assert.equal(json.includes('PRIVATE NOTE'), false);
  assert.equal(json.includes('https://'), false);
  assert.deepEqual(report.performance[0].metadata, { itemCount: 4 });
  assert.equal(report.performance[1].metadata.notes, undefined);
  assert.equal(report.usageAggregates['SECRET TITLE'], undefined);
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
