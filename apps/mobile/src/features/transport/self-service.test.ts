/// <reference types="node" />
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { confirmMismatch, sosShouldRetry, TRANSLATIONS, TRANSPORT_SELF_LIMITS } from '@veetracer/shared';
import {
  addDayKeys,
  bookableDays,
  bookingRequest,
  canConfirm,
  canReport,
  confirmKinds,
  hhmm,
  SELF_LIMITS,
  selfErrorText,
  selfServiceLabelStrings,
  shiftTimeFor,
  todayKeyIn,
  weekdayOfKey,
} from './self-service.ts';
import { sosRetryable } from './sos-queue.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIN = 60_000;

test('limits mirror the shared contract', () => {
  for (const k of Object.keys(SELF_LIMITS) as (keyof typeof SELF_LIMITS)[]) assert.equal(SELF_LIMITS[k], TRANSPORT_SELF_LIMITS[k], k);
});

test('day keys: today in a zone, weekdays (0 = Sunday), bookable days within the horizon on the shift days only', () => {
  // 2026-11-12 20:00 UTC is already 2026-11-13 in India.
  assert.equal(todayKeyIn('Asia/Kolkata', Date.parse('2026-11-12T20:00:00Z')), '2026-11-13');
  assert.equal(todayKeyIn('UTC', Date.parse('2026-11-12T20:00:00Z')), '2026-11-12');
  assert.equal(weekdayOfKey('2026-11-15'), 0);
  assert.equal(addDayKeys('2026-12-31', 1), '2027-01-01');
  const weekdays = bookableDays('2026-11-12', [1, 2, 3, 4, 5]);
  assert.equal(weekdays[0], '2026-11-12'); // a Thursday
  assert.ok(weekdays.every((d) => ![0, 6].includes(weekdayOfKey(d))));
  assert.ok(weekdays.at(-1)! <= addDayKeys('2026-11-12', 14));
  assert.equal(bookableDays('2026-11-12', [0, 1, 2, 3, 4, 5, 6]).length, 15);
  assert.deepEqual(bookableDays('2026-11-12', []), []);
});

test('shift times: login for IN, logout for OUT', () => {
  assert.equal(hhmm(540), '09:00');
  assert.equal(hhmm(1440 + 30), '00:30');
  assert.equal(shiftTimeFor({ startMin: 540, endMin: 1080 }, 'IN'), '09:00');
  assert.equal(shiftTimeFor({ startMin: 540, endMin: 1080 }, 'OUT'), '18:00');
});

test('booking form: shift, day and place required; the note is trimmed and capped; one body shape', () => {
  const base = { shiftId: 's1', serviceDate: '2026-11-13', direction: 'IN' as const, place: { kind: 'HOME' as const }, note: '' };
  assert.deepEqual(bookingRequest({ ...base, shiftId: null }), { ok: false, error: 'Choose a shift.' });
  assert.deepEqual(bookingRequest({ ...base, serviceDate: null }), { ok: false, error: 'Choose a day.' });
  assert.deepEqual(bookingRequest({ ...base, place: null }), { ok: false, error: 'Choose where you are picked up or dropped.' });
  assert.deepEqual(bookingRequest({ ...base, place: { kind: 'SAVED', placeId: '' } }), { ok: false, error: 'Choose a saved place.' });
  assert.deepEqual(bookingRequest(base), { ok: true, body: { serviceDate: '2026-11-13', direction: 'IN', shiftId: 's1', place: { kind: 'HOME' } } });
  const r = bookingRequest({ ...base, note: `  ${'x'.repeat(300)} ` });
  assert.ok(r.ok && r.body.note!.length === SELF_LIMITS.bookingNoteMax);
  // No passengerId / passengerCount: the server takes the passenger from the session and books one seat.
  assert.ok(r.ok && !('passengerId' in r.body) && !('passengerCount' in r.body));
});

test('confirm (P5): offered only inside the trip window, pickup until boarded, drop once boarded; never after drop', () => {
  const now = Date.parse('2026-11-12T08:00:00Z');
  const trip = (startInMin: number, status: 'PENDING' | 'BOARDED' | 'NO_SHOW' | 'DROPPED' | 'CANCELLED' = 'PENDING') => ({
    plannedStart: new Date(now + startInMin * MIN).toISOString(),
    plannedEnd: new Date(now + (startInMin + 60) * MIN).toISOString(),
    myStatus: status,
    derivedState: 'PUBLISHED' as const,
  });
  assert.equal(canConfirm(trip(10), now), true);
  assert.equal(canConfirm(trip(45), now), false); // window opens 30 min before start
  assert.equal(canConfirm(trip(-75), now), false); // ended more than 10 min ago
  assert.equal(canConfirm(trip(-100, 'NO_SHOW'), now), true); // a no-show may dispute until 2 h after the end
  assert.equal(canConfirm(trip(10, 'DROPPED'), now), false);
  assert.equal(canConfirm({ ...trip(10), derivedState: 'CANCELLED' }, now), false);
  assert.deepEqual(confirmKinds('PENDING'), ['PICKUP']);
  assert.deepEqual(confirmKinds('BOARDED'), ['DROP']);
  assert.deepEqual(confirmKinds('DROPPED'), []);
  // The server flags a contradiction for the desk; the app never changes what the trip shows.
  assert.equal(confirmMismatch('PICKUP', 'NO_SHOW'), true);
});

test('report window: 2 h before the start until 48 h after the end', () => {
  const now = Date.parse('2026-11-12T08:00:00Z');
  const t = (s: number) => ({ plannedStart: new Date(now + s * MIN).toISOString(), plannedEnd: new Date(now + (s + 60) * MIN).toISOString() });
  assert.equal(canReport(t(100), now), true);
  assert.equal(canReport(t(130), now), false);
  assert.equal(canReport(t(-60 - 47 * 60), now), true);
  assert.equal(canReport(t(-60 - 49 * 60), now), false);
  assert.equal(canReport({ plannedStart: null, plannedEnd: null }, now), false);
});

test('error codes get passenger wording; the cut-off text speaks of booking, not cancelling', () => {
  assert.match(selfErrorText('AFTER_CUTOFF', 'book')!, /booking cut-off/);
  assert.match(selfErrorText('TOO_MANY_OPEN_REQUESTS', 'book')!, /10 open ride requests/);
  assert.match(selfErrorText('SELF_BOOKING_DISABLED', 'book')!, /not switched on/);
  assert.match(selfErrorText('INVALID_STATE', 'report')!, /two days/);
  assert.equal(selfErrorText('SOMETHING_ELSE', 'book'), null);
});

test('SOS retry rule equals the shared contract helper', () => {
  for (const s of [undefined, 200, 201, 400, 401, 403, 404, 408, 422, 429, 500, 503]) assert.equal(sosRetryable(s), sosShouldRetry(s), String(s));
});

test('i18n: every self-service string (screens, labels, errors, SOS wording, web setting) has hi and ta', () => {
  const files = [
    'passenger/BookScreen.tsx',
    'passenger/PlacesScreen.tsx',
    'passenger/CommuteScheduleScreen.tsx',
    'passenger/ReportScreen.tsx',
    'passenger/SosPanel.tsx',
    'passenger/TripScreen.tsx',
    'passenger/CommuteHome.tsx',
    'passenger/BookingsScreen.tsx',
    '../../../../web/src/features/transport/SelfBookingSetting.tsx',
  ];
  const keys = new Set<string>(selfServiceLabelStrings());
  const re = /\bt\(\s*'((?:[^'\\]|\\.)*)'/g;
  for (const f of files) {
    const src = readFileSync(join(HERE, f), 'utf8');
    for (let m = re.exec(src); m; m = re.exec(src)) keys.add(m[1].replace(/\\'/g, "'"));
  }
  assert.ok(keys.size > 100, `only ${keys.size} strings found`);
  for (const lang of ['hi', 'ta'] as const) {
    assert.deepEqual(
      [...keys].filter((k) => !TRANSLATIONS[lang][k]),
      [],
      `${lang} missing`,
    );
    // Placeholders survive translation.
    for (const k of keys) {
      const ph = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join(',');
      if (TRANSLATIONS[lang][k]) assert.equal(ph(TRANSLATIONS[lang][k]), ph(k), `${lang}: ${k}`);
    }
  }
});
