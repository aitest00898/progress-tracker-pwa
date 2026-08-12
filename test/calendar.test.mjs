import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEmptyState } from '../src/schema.js';
import { createItem, setDue } from '../src/engine.js';
import {
  CALENDAR_ALERT_OPTIONS, buildAlarm, buildCalendarEvent, buildCalendarICS,
  buildItemCalendarEvent, calendarFilename, escapeICS, shareCalendarFile, stableCalendarUid,
} from '../src/calendar.js';

function itemState({ title = '計畫,一;測試\\行\n第二行', plannedStart = null, due = null } = {}) {
  const state = makeEmptyState('2026-08-10T00:00:00.000Z');
  const categoryId = state.categories[0].id;
  const created = createItem(state, { categoryId, title }, '2026-08-10T08:00:00.000Z');
  const item = created.item;
  if (plannedStart) item.plannedStart = plannedStart;
  if (due) setDue(state, item.id, { mode: 'explicit', date: due }, '2026-08-10T08:00:00.000Z');
  return { state, item };
}

test('ICS escaping preserves machine-safe UTF-8 text', () => {
  assert.equal(escapeICS('逗號,分號;反斜線\\換行\n下一行'), '逗號\\,分號\\;反斜線\\\\換行\\n下一行');
});

test('calendar output has VCALENDAR and VEVENT shells with a stable UID', () => {
  const uid = stableCalendarUid({ datasetId: 'dataset-a', itemId: 'item-1' });
  const event = buildCalendarEvent({ uid, summary: '測試', start: { kind: 'all-day', date: '2026-08-10' } });
  const ics = buildCalendarICS([event], { timezone: 'Asia/Taipei' });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /UID:pt-dataset-a-item-1@progress-tracker/);
  assert.match(ics, /DTSTART;VALUE=DATE:20260810/);
  assert.match(ics, /DTEND;VALUE=DATE:20260811/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  assert.equal(stableCalendarUid({ datasetId: 'dataset-a', itemId: 'item-1' }), uid);
});

test('all-day item dates remain date-only and do not shift timezone', () => {
  const { state, item } = itemState({ plannedStart: '2026-08-10T12:00:00.000Z' });
  const built = buildItemCalendarEvent({ state, item, allDay: true });
  const ics = buildCalendarICS([built.event]);
  assert.match(ics, /DTSTART;VALUE=DATE:20260810/);
  assert.doesNotMatch(ics, /DTSTART:\d{8}T\d{6}Z/);
});

test('timed item events use the browser local time conversion', () => {
  const { state, item } = itemState({ plannedStart: '2026-08-10T12:00:00.000Z' });
  const built = buildItemCalendarEvent({ state, item, allDay: false, time: '09:30' });
  const expected = new Date('2026-08-10T09:30:00').toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  assert.match(buildCalendarICS([built.event]), new RegExp(`DTSTART:${expected}`));
});

test('calendar alert options generate the expected VALARM triggers', () => {
  const expected = { none: null, event: '-PT0M', '10m': '-PT10M', '30m': '-PT30M', '1h': '-PT1H', '1d': '-P1D' };
  for (const option of CALENDAR_ALERT_OPTIONS) {
    const lines = buildAlarm(option.value, '提醒').join('\n');
    if (expected[option.value]) assert.match(lines, new RegExp(`TRIGGER:${expected[option.value]}`));
    else assert.equal(lines, '');
  }
});

test('item calendar event refuses a missing date instead of inventing one', () => {
  const { state, item } = itemState();
  const built = buildItemCalendarEvent({ state, item });
  assert.deepEqual(built, { ok: false, reason: 'missing_date' });
  assert.equal(calendarFilename('長標題 / calendar: test?'), '長標題-calendar-test.ics');
});

test('share uses navigator.share when supported', async () => {
  let called = false;
  const result = await shareCalendarFile('event.ics', 'BEGIN:VCALENDAR', {
    navigatorObject: { canShare: () => true, share: async () => { called = true; } },
    documentObject: null,
    BlobCtor: Blob,
    FileCtor: class FakeFile extends Blob { constructor(parts, name, options) { super(parts, options); this.name = name; } },
  });
  assert.equal(called, true);
  assert.deepEqual(result, { ok: true, method: 'share' });
});

test('unsupported share falls back to a download and cancellation is not an error', async () => {
  let clicked = false;
  const documentObject = { createElement: () => ({ click: () => { clicked = true; } }) };
  const URLObject = { createObjectURL: () => 'blob:calendar', revokeObjectURL: () => {} };
  const fallback = await shareCalendarFile('event.ics', 'content', {
    navigatorObject: { canShare: () => false }, documentObject, URLObject, BlobCtor: Blob,
  });
  assert.equal(fallback.method, 'download');
  assert.equal(clicked, true);
  const cancelled = await shareCalendarFile('event.ics', 'content', {
    navigatorObject: { canShare: () => true, share: async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); } },
    documentObject: null,
    BlobCtor: Blob,
    FileCtor: class FakeFile extends Blob { constructor(parts, name, options) { super(parts, options); this.name = name; } },
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.ok, false);
});

