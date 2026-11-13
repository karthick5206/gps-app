/// <reference types="node" />
/**
 * WP 3.9 wave 2 on the phone: the passenger "Request a ride" form (D-A7) — state, validation, body shape, consent;
 * error mapping (NOT_ELIGIBLE reasons, AFTER_CUTOFF, BOOKING_DUPLICATE, BOOKING_OVERLAP, CONSENT_REQUIRED); approval
 * status labels (D-A5); BOOKING_APPROVED / BOOKING_REJECTED routing; the D-A9 profile / home helpers; hi / ta strings.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TRANSLATIONS, TRANSPORT_ADHOC_LIMITS, TRANSPORT_INELIGIBLE_REASONS, TRANSPORT_SELF_LIMITS } from '@veetracer/shared';
import {
  adhocRequest,
  CONSENT_EXPLANATION,
  defaultCommuteEnds,
  endKindAvailability,
  endKindsFor,
  INELIGIBLE_TEXT,
  isPersonalEnd,
  NOT_ELIGIBLE_FALLBACK,
  parseClock,
  passengerStatusLine,
  passengerStatusMeta,
  REQUEST_FORM_ERRORS,
  REQUEST_LIMITS,
  REQUEST_STATUS_STRINGS,
  REQUESTED_DESK_ASSIGNS,
  requestDays,
  requestErrorStrings,
  requestErrorText,
  requestResultText,
  WAITING_FOR_APPROVAL,
  zonedIso,
  type RequestForm,
} from './adhoc-request.ts';
import { CONTACT_ERRORS, contactsInput, HOME_FORM_ERRORS, homeInput, keptBookingsText, parseLatLng, profileErrorStrings, profileErrorText } from './my-profile.ts';
import { BOOKING_KINDS, inboxTarget, transportPushTarget } from './push-target.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const B = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const N = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a7d';
const PASSENGER = { passenger: true, driver: false };
const DRIVER = { passenger: false, driver: true };
const CTX = { routingConsent: true, timeZone: 'Asia/Kolkata' };

const form = (over: Partial<RequestForm> = {}): RequestForm => ({
  journey: 'POINT_TO_POINT',
  serviceDate: '2026-11-14',
  direction: 'IN',
  shiftId: null,
  pickup: { kind: 'PLACE', poiId: 'p1' },
  destination: { kind: 'MAP', lat: 12.97, lng: 77.59, label: ' Client office ' },
  windowStart: '09:30',
  windowEnd: '10:00',
  purpose: '',
  note: '',
  ...over,
});

// ───────────── Request form ─────────────

test('limits mirror the shared contract', () => {
  assert.equal(REQUEST_LIMITS.purposeMax, TRANSPORT_ADHOC_LIMITS.purposeMax);
  assert.equal(REQUEST_LIMITS.noteMax, TRANSPORT_SELF_LIMITS.bookingNoteMax);
  assert.equal(REQUEST_LIMITS.mapLabelMax, TRANSPORT_SELF_LIMITS.placeLabelMax);
  assert.equal(REQUEST_LIMITS.maxDaysAhead, TRANSPORT_SELF_LIMITS.maxDaysAhead);
});

test('end kinds: shift site only on a commute; personal ends need consent; shift site needs a shift', () => {
  assert.deepEqual(endKindsFor('POINT_TO_POINT'), ['HOME', 'SAVED', 'PLACE', 'MAP']);
  assert.ok(endKindsFor('COMMUTE').includes('SHIFT_SITE'));
  for (const k of ['HOME', 'SAVED', 'MAP'] as const) {
    assert.equal(isPersonalEnd({ kind: k }), true);
    assert.deepEqual(endKindAvailability(k, { routingConsent: false, journey: 'COMMUTE', shiftId: 's1' }), { ok: false, reason: CONSENT_EXPLANATION });
    assert.deepEqual(endKindAvailability(k, { routingConsent: true, journey: 'COMMUTE', shiftId: null }), { ok: true });
  }
  assert.equal(isPersonalEnd({ kind: 'PLACE' }), false);
  assert.deepEqual(endKindAvailability('PLACE', { routingConsent: false, journey: 'POINT_TO_POINT', shiftId: null }), { ok: true });
  assert.equal(endKindAvailability('SHIFT_SITE', { routingConsent: true, journey: 'COMMUTE', shiftId: null }).ok, false);
  assert.equal(endKindAvailability('SHIFT_SITE', { routingConsent: true, journey: 'POINT_TO_POINT', shiftId: 's1' }).ok, false);
  assert.equal(endKindAvailability('SHIFT_SITE', { routingConsent: true, journey: 'COMMUTE', shiftId: 's1' }).ok, true);
});

test('commute defaults: home → site to log in, site → home to log out; no home without consent', () => {
  assert.deepEqual(defaultCommuteEnds('IN', true), { pickup: { kind: 'HOME' }, destination: { kind: 'SHIFT_SITE' } });
  assert.deepEqual(defaultCommuteEnds('OUT', true), { pickup: { kind: 'SHIFT_SITE' }, destination: { kind: 'HOME' } });
  assert.deepEqual(defaultCommuteEnds('IN', false), { pickup: null, destination: { kind: 'SHIFT_SITE' } });
});

test('days: today … today + maxDaysAhead; a commute shift limits to its weekdays', () => {
  const all = requestDays('2026-11-12', 14);
  assert.equal(all.length, 15);
  assert.equal(all[0], '2026-11-12');
  assert.equal(all.at(-1), '2026-11-26');
  assert.equal(requestDays('2026-11-12', 3).length, 4);
  const weekdays = requestDays('2026-11-12', 14, [1, 2, 3, 4, 5]);
  assert.ok(weekdays.every((d) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())));
  assert.equal(weekdays.length, 11);
});

test('clock and zone: HH:MM parsing, wall clock in the zone to an ISO instant', () => {
  assert.equal(parseClock('09:30'), 570);
  assert.equal(parseClock('9:05'), 545);
  assert.equal(parseClock('24:00'), null);
  assert.equal(parseClock('0930'), null);
  assert.equal(zonedIso('2026-11-14', 570, 'Asia/Kolkata'), '2026-11-14T04:00:00.000Z');
  assert.equal(zonedIso('2026-11-14', 570, 'UTC'), '2026-11-14T09:30:00.000Z');
  assert.equal(zonedIso('nope', 570, 'UTC'), null);
});

test('point-to-point request: body shape (no direction), window in the zone, map label trimmed, purpose / note capped', () => {
  const r = adhocRequest(form({ purpose: `  Client visit ${'x'.repeat(200)}`, note: '  gate 2  ' }), CTX);
  assert.ok(r.ok);
  assert.equal(r.body.journey, 'POINT_TO_POINT');
  assert.equal('direction' in r.body, false);
  assert.equal('shiftId' in r.body, false);
  assert.equal(r.body.windowStart, '2026-11-14T04:00:00.000Z');
  assert.equal(r.body.windowEnd, '2026-11-14T04:30:00.000Z');
  assert.deepEqual(r.body.destination, { kind: 'MAP', lat: 12.97, lng: 77.59, label: 'Client office' });
  assert.equal(r.body.purpose!.length, REQUEST_LIMITS.purposeMax);
  assert.equal(r.body.note, 'gate 2');
  // One seat, own profile: the server takes the passenger from the session.
  assert.ok(!('passengerId' in r.body) && !('passengerCount' in r.body));
});

test('commute request: direction kept, shift without a window is enough, shift site allowed', () => {
  const r = adhocRequest(form({ journey: 'COMMUTE', direction: 'OUT', shiftId: 's1', pickup: { kind: 'SHIFT_SITE' }, destination: { kind: 'HOME' }, windowStart: '', windowEnd: '' }), CTX);
  assert.ok(r.ok);
  assert.deepEqual(r.body, { serviceDate: '2026-11-14', journey: 'COMMUTE', direction: 'OUT', shiftId: 's1', pickup: { kind: 'SHIFT_SITE' }, destination: { kind: 'HOME' } });
});

test('request validation: each missing / wrong piece gives its own reason', () => {
  const err = (f: RequestForm, ctx = CTX) => {
    const r = adhocRequest(f, ctx);
    return r.ok ? null : r.error;
  };
  assert.equal(err(form({ serviceDate: null })), 'Choose a day.');
  assert.equal(err(form({ pickup: null })), 'Choose where you are picked up.');
  assert.equal(err(form({ destination: null })), 'Choose where you are going.');
  assert.equal(err(form({ pickup: { kind: 'HOME' } }), { ...CTX, routingConsent: false }), CONSENT_EXPLANATION);
  assert.equal(err(form({ destination: { kind: 'MAP', lat: 12, lng: 77 } }), { ...CTX, routingConsent: false }), CONSENT_EXPLANATION);
  assert.equal(err(form({ pickup: { kind: 'SAVED', placeId: '' } })), 'Choose a saved place.');
  assert.equal(err(form({ pickup: { kind: 'PLACE', poiId: '' } })), 'Choose a company place.');
  assert.equal(err(form({ destination: { kind: 'MAP', lat: 120, lng: 77 } })), 'Choose a point on the map.');
  assert.equal(err(form({ destination: { kind: 'SHIFT_SITE' } })), 'The shift site is only for a commute.');
  assert.equal(err(form({ journey: 'COMMUTE', destination: { kind: 'SHIFT_SITE' } })), 'Choose a shift first.');
  assert.equal(err(form({ destination: { kind: 'PLACE', poiId: 'p1' } })), 'Pickup and destination must be different.');
  assert.equal(err(form({ windowEnd: '' })), 'Enter both the start and the end of the time window.');
  assert.equal(err(form({ windowStart: '9.30' })), 'Enter times as HH:MM, for example 09:30.');
  assert.equal(err(form({ windowStart: '10:00', windowEnd: '09:30' })), 'The time window must end after it starts.');
  assert.equal(err(form({ windowStart: '', windowEnd: '' })), 'A point-to-point ride needs a time window.');
  assert.equal(err(form({ journey: 'COMMUTE', pickup: { kind: 'HOME' }, destination: { kind: 'PLACE', poiId: 'p1' }, windowStart: '', windowEnd: '' })), 'A commute needs a shift or a time window.');
  // A company place never needs consent.
  assert.equal(err(form({ destination: { kind: 'PLACE', poiId: 'p2' } }), { ...CTX, routingConsent: false }), null);
});

// ───────────── Answer and errors ─────────────

test('after submit: "Waiting for approval" for REQUESTED / needsApproval, else the desk assigns a cab', () => {
  assert.equal(requestResultText({ status: 'REQUESTED' }), WAITING_FOR_APPROVAL);
  assert.equal(requestResultText({ status: 'PENDING_ASSIGNMENT', needsApproval: true }), WAITING_FOR_APPROVAL);
  assert.equal(requestResultText({ status: 'PENDING_ASSIGNMENT', needsApproval: false }), REQUESTED_DESK_ASSIGNS);
  assert.equal(requestResultText({ status: 'PENDING_ASSIGNMENT' }), REQUESTED_DESK_ASSIGNS);
  assert.equal(REQUESTED_DESK_ASSIGNS, 'Requested — the transport desk will assign a cab');
});

test('error mapping: every NOT_ELIGIBLE reason, cut-off, duplicate, overlap, consent; unknown → server message', () => {
  for (const r of TRANSPORT_INELIGIBLE_REASONS) assert.equal(requestErrorText('NOT_ELIGIBLE', r), INELIGIBLE_TEXT[r], r);
  assert.equal(requestErrorText('NOT_ELIGIBLE', 'SOMETHING_NEW'), NOT_ELIGIBLE_FALLBACK);
  assert.equal(requestErrorText('NOT_ELIGIBLE'), NOT_ELIGIBLE_FALLBACK);
  assert.match(requestErrorText('AFTER_CUTOFF')!, /cut-off/);
  assert.match(requestErrorText('BOOKING_DUPLICATE')!, /already have a booking/);
  assert.match(requestErrorText('BOOKING_OVERLAP')!, /already have a ride at this time/);
  assert.equal(requestErrorText('CONSENT_REQUIRED'), CONSENT_EXPLANATION);
  assert.match(requestErrorText('SELF_BOOKING_DISABLED')!, /not switched on/);
  assert.equal(requestErrorText('WHATEVER'), null);
  assert.equal(requestErrorText(null), null);
});

// ───────────── Approval status (D-A5) ─────────────

const FALLBACK = { PENDING_ASSIGNMENT: { label: 'Waiting for a seat', tone: 'info' as const }, ASSIGNED: { label: 'Assigned', tone: 'success' as const } };

test('status chips: Requested, Approved (own ad-hoc request), Rejected with the reason; others unchanged', () => {
  assert.deepEqual(passengerStatusMeta({ status: 'REQUESTED' }, FALLBACK), { label: 'Requested', tone: 'warning' });
  assert.deepEqual(passengerStatusMeta({ status: 'PENDING_ASSIGNMENT', source: 'ADHOC', arrangedByDesk: false, approval: 'APPROVED' }, FALLBACK), { label: 'Approved', tone: 'info' });
  // The desk's booking or the regular schedule was never "approved" by anyone: keep the seat wording.
  assert.deepEqual(passengerStatusMeta({ status: 'PENDING_ASSIGNMENT', source: 'ADHOC', arrangedByDesk: true }, FALLBACK), FALLBACK.PENDING_ASSIGNMENT);
  assert.deepEqual(passengerStatusMeta({ status: 'PENDING_ASSIGNMENT', source: 'SCHEDULE', arrangedByDesk: false }, FALLBACK), FALLBACK.PENDING_ASSIGNMENT);
  assert.deepEqual(passengerStatusMeta({ status: 'PENDING_ASSIGNMENT', source: 'ADHOC' }, FALLBACK), FALLBACK.PENDING_ASSIGNMENT); // older server
  assert.deepEqual(passengerStatusMeta({ status: 'REJECTED' }, FALLBACK), { label: 'Rejected', tone: 'destructive' });
  assert.deepEqual(passengerStatusMeta({ status: 'ASSIGNED' }, FALLBACK), FALLBACK.ASSIGNED);
  assert.deepEqual(passengerStatusMeta({ status: 'NEW_THING' }, FALLBACK), { label: 'NEW_THING', tone: 'neutral' });

  assert.deepEqual(passengerStatusLine({ status: 'REQUESTED' }), { text: WAITING_FOR_APPROVAL, reason: null });
  assert.deepEqual(passengerStatusLine({ status: 'REJECTED', statusReason: '  No cab on Sunday ' }), { text: 'Not approved: {{reason}}', reason: 'No cab on Sunday' });
  assert.deepEqual(passengerStatusLine({ status: 'REJECTED' }), { text: 'Not approved.', reason: null });
  assert.equal(passengerStatusLine({ status: 'ASSIGNED' }), null);
});

// ───────────── Notifications ─────────────

test('BOOKING_APPROVED / BOOKING_REJECTED: push and inbox open the booking (tripId null), never a trip; drivers get nothing', () => {
  for (const kind of ['BOOKING_APPROVED', 'BOOKING_REJECTED']) {
    assert.ok(BOOKING_KINDS.includes(kind));
    const data = { kind, bookingId: B, notificationId: N, tripId: null };
    assert.equal(transportPushTarget(data, PASSENGER), `/commute/bookings?bookingId=${B}`);
    assert.equal(transportPushTarget(data, DRIVER), null);
    assert.equal(transportPushTarget({ kind, bookingId: 'not-a-uuid', notificationId: N }, PASSENGER), '/commute/bookings');
    assert.equal(inboxTarget({ kind, tripId: null, bookingId: B }, 'passenger'), `/commute/bookings?bookingId=${B}`);
    assert.equal(inboxTarget({ kind, tripId: null, bookingId: null }, 'passenger'), '/commute/bookings');
    assert.equal(inboxTarget({ kind, tripId: null, bookingId: B }, 'driver'), null);
  }
});

// ───────────── D-A9 profile / home ─────────────

test('home: typed position parsed and range-checked; search → PHOTON, pin → PIN, typed → TYPED; address capped', () => {
  assert.deepEqual(parseLatLng('12.9716, 77.5946'), { lat: 12.9716, lng: 77.5946 });
  assert.deepEqual(parseLatLng('12.9716 77.5946'), { lat: 12.9716, lng: 77.5946 });
  assert.equal(parseLatLng('95, 77'), null);
  assert.equal(parseLatLng('Main road'), null);
  assert.deepEqual(homeInput({ kind: 'SEARCH', label: 'Tech Park Road', lat: 12.9, lng: 77.6 }), { ok: true, body: { lat: 12.9, lng: 77.6, address: 'Tech Park Road', source: 'PHOTON' } });
  assert.deepEqual(homeInput({ kind: 'PIN', lat: 12.9, lng: 77.6, address: '  ' }), { ok: true, body: { lat: 12.9, lng: 77.6, address: null, source: 'PIN' } });
  const typed = homeInput({ kind: 'TYPED', text: '12.9, 77.6', address: 'x'.repeat(300) });
  assert.ok(typed.ok && typed.body.source === 'TYPED' && typed.body.address!.length === 200);
  assert.deepEqual(homeInput({ kind: 'TYPED', text: 'abc', address: '' }), { ok: false, error: HOME_FORM_ERRORS[0] });
  assert.deepEqual(homeInput(null), { ok: false, error: 'Search an address or place first.' });
});

test('home: "N existing bookings keep their earlier location" from openBookingsKept', () => {
  assert.equal(keptBookingsText(0), null);
  assert.equal(keptBookingsText(undefined), null);
  assert.deepEqual(keptBookingsText(1), { text: '1 existing booking keeps its earlier location.', count: 1 });
  assert.deepEqual(keptBookingsText(4), { text: '{{count}} existing bookings keep their earlier location.', count: 4 });
});

test('emergency contacts: blank rows dropped, at most 3, name and phone required, phone shape checked', () => {
  const row = (name: string, phone: string, relation = '') => ({ name, phone, relation });
  assert.deepEqual(contactsInput([row('Asha', '+91 90000 00001', 'Sister'), row('', '')]), { ok: true, contacts: [{ name: 'Asha', phone: '+91 90000 00001', relation: 'Sister' }] });
  assert.deepEqual(contactsInput([row('', '')]), { ok: true, contacts: [] });
  assert.deepEqual(contactsInput([row('A', '900000001'), row('B', '900000002'), row('C', '900000003'), row('D', '900000004')]), { ok: false, error: CONTACT_ERRORS[0] });
  assert.deepEqual(contactsInput([row('A', '')]), { ok: false, error: CONTACT_ERRORS[1] });
  assert.deepEqual(contactsInput([row('A', 'call me')]), { ok: false, error: CONTACT_ERRORS[2] });
  assert.deepEqual(contactsInput([row('A', '900000001', '')]), { ok: true, contacts: [{ name: 'A', phone: '900000001', relation: null }] });
});

test('profile errors: consent, geocoder guard, unknown → server message', () => {
  assert.match(profileErrorText('CONSENT_REQUIRED')!, /consent/);
  assert.match(profileErrorText('GEOCODER_NOT_PRIVATE')!, /not available/);
  assert.equal(profileErrorText('OTHER'), null);
});

// ───────────── i18n ─────────────

test('i18n: every wave-2 mobile string has hi and ta, placeholders kept', () => {
  const files = [
    'passenger/RequestRideScreen.tsx',
    'passenger/MyProfileScreen.tsx',
    'passenger/PointPicker.tsx',
    'passenger/BookingsScreen.tsx',
    'passenger/CommuteHome.tsx',
    'passenger/PushPreferences.tsx',
    'TransportInbox.tsx',
    '../../app/_layout.tsx',
    '../../app/(passenger)/my-account.tsx',
  ];
  const keys = new Set<string>([
    ...REQUEST_FORM_ERRORS,
    ...REQUEST_STATUS_STRINGS,
    ...requestErrorStrings(),
    ...HOME_FORM_ERRORS,
    ...CONTACT_ERRORS,
    ...profileErrorStrings(),
    '1 existing booking keeps its earlier location.',
    '{{count}} existing bookings keep their earlier location.',
    'Home',
    'Saved place',
    'Company place',
    'Map point',
    'Shift site',
    'Ride request approved',
    'Ride request rejected',
  ]);
  const re = /\bt\(\s*'((?:[^'\\]|\\.)*)'/g;
  for (const f of files) {
    const src = readFileSync(join(HERE, f), 'utf8');
    for (let m = re.exec(src); m; m = re.exec(src)) keys.add(m[1].replace(/\\'/g, "'"));
  }
  for (const lang of ['hi', 'ta'] as const) {
    assert.deepEqual(
      [...keys].filter((k) => !TRANSLATIONS[lang][k]),
      [],
      `${lang} missing`,
    );
    const ph = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join(',');
    for (const k of keys) assert.equal(ph(TRANSLATIONS[lang][k]), ph(k), `${lang}: ${k}`);
  }
});
