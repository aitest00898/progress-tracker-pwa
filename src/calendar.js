import { effectiveDue, pathString, reminderOccurrence } from './engine.js';

export const CALENDAR_ALERT_OPTIONS = Object.freeze([
  { value: 'none', minutes: null },
  { value: 'event', minutes: 0 },
  { value: '10m', minutes: 10 },
  { value: '30m', minutes: 30 },
  { value: '1h', minutes: 60 },
  { value: '1d', minutes: 1440 }
]);

const ALERT_MINUTES = Object.freeze(
  Object.fromEntries(CALENDAR_ALERT_OPTIONS.map((option) => [option.value, option.minutes]))
);

function asText(value) {
  return value === null || value === undefined ? '' : String(value);
}

export function escapeICS(value) {
  return asText(value)
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function normalizeDateOnly(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = asText(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function icsDate(value) {
  const date = normalizeDateOnly(value);
  return date ? date.replaceAll('-', '') : null;
}

function nextDateOnly(value) {
  const date = normalizeDateOnly(value);
  if (!date) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10).replaceAll('-', '');
}

function normalizeTime(value) {
  const raw = asText(value);
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function icsUtcStamp(value = new Date()) {
  const parsed = value instanceof Date ? value : new Date(value);
  const safe = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return safe.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function localDateTimeToUtc(date, time) {
  const normalizedDate = normalizeDateOnly(date);
  const normalizedTime = normalizeTime(time);
  if (!normalizedDate || !normalizedTime) return null;
  const local = new Date(`${normalizedDate}T${normalizedTime}:00`);
  if (Number.isNaN(local.getTime())) return null;
  return local.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function localDateTimeParts(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const pad = (number) => String(number).padStart(2, '0');
  return {
    date: `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`,
    time: `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
  };
}

export function buildAlarm(alert = 'none', summary = 'Progress Tracker reminder') {
  const minutes = typeof alert === 'number' ? alert : ALERT_MINUTES[alert];
  if (minutes === null || minutes === undefined) return [];
  let trigger;
  if (minutes === 0) trigger = '-PT0M';
  else if (minutes % 1440 === 0) trigger = `-P${minutes / 1440}D`;
  else if (minutes % 60 === 0) trigger = `-PT${minutes / 60}H`;
  else trigger = `-PT${minutes}M`;
  return [
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeICS(summary)}`,
    `TRIGGER:${trigger}`,
    'END:VALARM'
  ];
}

/** @param {any} [options] */
export function stableCalendarUid({ datasetId = 'local', itemId = 'item', entityId } = {}) {
  const suffix = entityId ?? itemId;
  return `pt-${encodeURIComponent(asText(datasetId))}-${encodeURIComponent(asText(suffix))}@progress-tracker`;
}

/** @param {any} [options] */
export function buildCalendarEvent({
  uid,
  summary,
  description = '',
  start,
  alert = 'none',
  dtstamp = new Date()
} = {}) {
  if (!start || !start.kind) return null;
  const lines = [
    'BEGIN:VEVENT',
    `UID:${escapeICS(uid ?? stableCalendarUid())}`,
    `DTSTAMP:${icsUtcStamp(dtstamp)}`
  ];

  if (start.kind === 'all-day') {
    const date = icsDate(start.date);
    const end = nextDateOnly(start.date);
    if (!date || !end) return null;
    lines.push(`DTSTART;VALUE=DATE:${date}`, `DTEND;VALUE=DATE:${end}`);
  } else {
    const utc = localDateTimeToUtc(start.date, start.time);
    if (!utc) return null;
    lines.push(`DTSTART:${utc}`);
    if (start.endDate || start.endTime) {
      const end = localDateTimeToUtc(start.endDate ?? start.date, start.endTime ?? start.time);
      if (end) lines.push(`DTEND:${end}`);
    }
  }

  lines.push(`SUMMARY:${escapeICS(summary ?? '')}`);
  if (description) lines.push(`DESCRIPTION:${escapeICS(description)}`);
  lines.push(...buildAlarm(alert, summary ?? 'Progress Tracker reminder'));
  lines.push('END:VEVENT');
  return { uid: uid ?? stableCalendarUid(), lines };
}

/** @param {any[]} [events] @param {any} [options] */
export function buildCalendarICS(events = [], { timezone, calendarName = 'Progress Tracker' } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Progress Tracker//Calendar Export//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeICS(calendarName)}`
  ];
  if (timezone) lines.push(`X-WR-TIMEZONE:${escapeICS(timezone)}`);
  for (const event of events) {
    if (event?.lines) lines.push(...event.lines);
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

function itemDescription(state, item, index) {
  const path = index ? pathString(state, item.id, index) : item.title;
  return `${path}\nGenerated by Progress Tracker`;
}

/** @param {any} [options] */
export function buildItemCalendarEvent({
  state,
  item,
  index,
  datasetId = state?.meta?.datasetId ?? 'local',
  date,
  time,
  allDay = true,
  alert = 'none',
  dtstamp = new Date()
} = {}) {
  if (!item) return { ok: false, reason: 'missing_item' };
  const inherited = effectiveDue(state, item.id, index);
  const selectedDate = normalizeDateOnly(date ?? item.plannedStart ?? inherited.value);
  if (!selectedDate) return { ok: false, reason: 'missing_date' };
  const start = allDay || !time
    ? { kind: 'all-day', date: selectedDate }
    : { kind: 'timed', date: selectedDate, time: normalizeTime(time) };
  const event = buildCalendarEvent({
    uid: stableCalendarUid({ datasetId, itemId: item.id }),
    summary: item.title,
    description: itemDescription(state, item, index),
    start,
    alert,
    dtstamp
  });
  return event ? { ok: true, event, date: selectedDate, start } : { ok: false, reason: 'invalid_date' };
}

/** @param {any} [options] */
export function buildReminderCalendarEvent({
  state,
  reminder,
  item,
  index,
  datasetId = state?.meta?.datasetId ?? 'local',
  dtstamp = new Date()
} = {}) {
  if (!reminder || !item) return null;
  const occurrence = reminderOccurrence(state, reminder, index);
  const parts = localDateTimeParts(occurrence);
  if (!parts) return null;
  return buildCalendarEvent({
    uid: stableCalendarUid({ datasetId, itemId: item.id, entityId: reminder.id }),
    summary: item.title,
    description: itemDescription(state, item, index),
    start: { kind: 'timed', date: parts.date, time: parts.time },
    dtstamp
  });
}

export function calendarFilename(title, fallback = 'progress-tracker') {
  const safe = asText(title)
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return `${safe || fallback}.ics`;
}

export async function shareCalendarFile(filename, content, {
  navigatorObject = globalThis.navigator,
  documentObject = globalThis.document,
  URLObject = globalThis.URL,
  BlobCtor = globalThis.Blob,
  FileCtor = globalThis.File
} = {}) {
  if (typeof BlobCtor !== 'function') return { ok: false, reason: 'unsupported' };
  const blob = new BlobCtor([content], { type: 'text/calendar;charset=utf-8' });
  let file = null;
  if (typeof FileCtor === 'function') file = new FileCtor([blob], filename, { type: 'text/calendar;charset=utf-8' });

  let shareable = false;
  try {
    shareable = Boolean(file && navigatorObject?.share && navigatorObject?.canShare?.({ files: [file] }));
  } catch {
    shareable = false;
  }
  if (shareable) {
    try {
      await navigatorObject.share({ files: [file], title: filename });
      return { ok: true, method: 'share' };
    } catch (error) {
      if (error?.name === 'AbortError') return { ok: false, cancelled: true, method: 'share' };
      // A broken share implementation still gets a normal download fallback.
    }
  }

  if (documentObject?.createElement && URLObject?.createObjectURL) {
    const url = URLObject.createObjectURL(blob);
    const anchor = documentObject.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    if (typeof anchor.click === 'function') anchor.click();
    URLObject.revokeObjectURL?.(url);
    return { ok: true, method: 'download' };
  }
  return { ok: false, reason: 'unsupported' };
}
