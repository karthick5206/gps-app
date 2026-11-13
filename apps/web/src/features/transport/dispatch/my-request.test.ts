import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HI } from '../../../../../../packages/shared/src/i18n/hi.ts';
import { TA } from '../../../../../../packages/shared/src/i18n/ta.ts';
import { ADDRESS_SEARCH, addressQuery, nextActive } from './address-search.ts';
import {
  approvalMeta,
  buildRequest,
  cancelBody,
  cancelErrorText,
  cancelState,
  canRequestRide,
  CONSENT_EXPLANATION,
  defaultCommuteEnds,
  endKindAvailability,
  endKindsFor,
  minutesText,
  myRequestStrings,
  myRouteText,
  NOT_ELIGIBLE_FALLBACK,
  REQUESTED_DESK_ASSIGNS,
  requestDays,
  requestErrorField,
  requestErrorText,
  requestResultText,
  requestTimeZone,
  todayKeyIn,
  WAITING_FOR_APPROVAL,
  type RequestForm,
} from './my-request.ts';

const ctx = { routingConsent: true, timeZone: 'Asia/Kolkata' };
const form = (over: Partial<RequestForm> = {}): RequestForm => ({
  journey: 'COMMUTE',
  serviceDate: '2026-11-13',
  direction: 'IN',
  shiftId: 'shift-1',
  pickup: { kind: 'HOME' },
  destination: { kind: 'SHIFT_SITE' },
  windowStart: '',
  windowEnd: '',
  purpose: '',
  note: '',
  ...over,
});

test('the action shows only when self-booking and ad-hoc requests are on', () => {
  assert.equal(canRequestRide({ selfBooking: true, adhocRequests: true }), true);
  assert.equal(canRequestRide({ selfBooking: false, adhocRequests: true }), false);
  assert.equal(canRequestRide({ selfBooking: true, adhocRequests: false }), false);
  assert.equal(canRequestRide({ selfBooking: true }), false, 'older server without adhocRequests');
  assert.equal(canRequestRide(undefined), false);
});

test('commute body with a shift: direction and shiftId, no window, empty texts left out', () => {
  const r = buildRequest(form(), ctx);
  assert.ok(r.ok);
  assert.deepEqual(r.body, { serviceDate: '2026-11-13', journey: 'COMMUTE', direction: 'IN', shiftId: 'shift-1', pickup: { kind: 'HOME' }, destination: { kind: 'SHIFT_SITE' } });
});

test('point-to-point body: window in the company zone, no direction, purpose / note trimmed and capped, map label capped', () => {
  const r = buildRequest(
    form({ journey: 'POINT_TO_POINT', shiftId: null, pickup: { kind: 'PLACE', poiId: 'poi-1' }, destination: { kind: 'MAP', lat: 13.05, lng: 80.25, label: `  ${'x'.repeat(80)} ` }, windowStart: '09:30', windowEnd: '10:00', purpose: `  Client visit${' '.repeat(3)}`, note: 'n'.repeat(250) }),
    ctx,
  );
  assert.ok(r.ok);
  assert.equal(r.body.direction, undefined);
  assert.equal(r.body.shiftId, undefined);
  assert.equal(r.body.windowStart, '2026-11-13T04:00:00.000Z');
  assert.equal(r.body.windowEnd, '2026-11-13T04:30:00.000Z');
  assert.equal(r.body.purpose, 'Client visit');
  assert.equal(r.body.note?.length, 200);
  assert.deepEqual(r.body.destination, { kind: 'MAP', lat: 13.05, lng: 80.25, label: 'x'.repeat(60) });
  const blank = buildRequest(form({ destination: { kind: 'MAP', lat: 1, lng: 2, label: '  ' } }), ctx);
  assert.ok(blank.ok);
  assert.deepEqual(blank.body.destination, { kind: 'MAP', lat: 1, lng: 2 });
});

test('validation: day, ends, consent, same point, window rules', () => {
  const err = (f: Partial<RequestForm>, c = ctx) => {
    const r = buildRequest(form(f), c);
    return r.ok ? null : [r.error, r.field];
  };
  assert.deepEqual(err({ serviceDate: null }), ['Choose a day.', 'serviceDate']);
  assert.deepEqual(err({ pickup: null }), ['Choose where you are picked up.', 'pickup']);
  assert.deepEqual(err({ destination: null }), ['Choose where you are going.', 'destination']);
  assert.deepEqual(err({}, { ...ctx, routingConsent: false }), [CONSENT_EXPLANATION, 'pickup']);
  assert.deepEqual(err({ pickup: { kind: 'PLACE', poiId: 'p' }, destination: { kind: 'MAP', lat: 1, lng: 1 } }, { ...ctx, routingConsent: false }), [CONSENT_EXPLANATION, 'destination']);
  assert.deepEqual(err({ pickup: { kind: 'PLACE', poiId: 'p' }, destination: { kind: 'PLACE', poiId: 'p' } }), ['Pickup and destination must be different.', 'destination']);
  assert.deepEqual(err({ shiftId: null }), ['Choose a shift first.', 'destination']);
  assert.deepEqual(err({ journey: 'POINT_TO_POINT', destination: { kind: 'SHIFT_SITE' } }), ['The shift site is only for a commute.', 'destination']);
  assert.deepEqual(err({ journey: 'POINT_TO_POINT', destination: { kind: 'PLACE', poiId: 'p' } }), ['A point-to-point ride needs a time window.', 'window']);
  assert.deepEqual(err({ shiftId: null, destination: { kind: 'PLACE', poiId: 'p' } }), ['A commute needs a shift or a time window.', 'window']);
  assert.deepEqual(err({ windowStart: '09:00' }), ['Enter both the start and the end of the time window.', 'window']);
  assert.deepEqual(err({ windowStart: '9h', windowEnd: '10:00' }), ['Enter times as HH:MM, for example 09:30.', 'window']);
  assert.deepEqual(err({ windowStart: '10:00', windowEnd: '09:00' }), ['The time window must end after it starts.', 'window']);
  assert.deepEqual(err({ windowStart: '10:00', windowEnd: '10:05' }), ['The time window must be at least 10 minutes long.', 'window']);
  assert.deepEqual(err({ pickup: { kind: 'MAP', lat: 95, lng: 0 } }), ['Choose a point on the map.', 'pickup']);
});

test('end kinds: shift site only on a commute and after a shift; personal ends need consent', () => {
  assert.deepEqual(endKindsFor('POINT_TO_POINT'), ['HOME', 'SAVED', 'PLACE', 'MAP']);
  assert.ok(endKindsFor('COMMUTE').includes('SHIFT_SITE'));
  assert.deepEqual(endKindAvailability('HOME', { routingConsent: false, journey: 'COMMUTE', shiftId: 's' }), { ok: false, reason: CONSENT_EXPLANATION });
  assert.deepEqual(endKindAvailability('PLACE', { routingConsent: false, journey: 'COMMUTE', shiftId: null }), { ok: true });
  assert.deepEqual(endKindAvailability('SHIFT_SITE', { routingConsent: true, journey: 'COMMUTE', shiftId: null }), { ok: false, reason: 'Choose a shift first.' });
  assert.deepEqual(defaultCommuteEnds('IN', true), { pickup: { kind: 'HOME' }, destination: { kind: 'SHIFT_SITE' } });
  assert.deepEqual(defaultCommuteEnds('OUT', false), { pickup: { kind: 'SHIFT_SITE' }, destination: null });
});

test('days, zone and clock helpers', () => {
  assert.equal(requestDays('2026-11-12', 14).length, 15);
  // 2026-11-12 is a Thursday (4): Mon / Wed only within 7 days.
  assert.deepEqual(requestDays('2026-11-12', 7, [1, 3]), ['2026-11-16', '2026-11-18']);
  assert.equal(requestTimeZone({ timeZone: 'Asia/Kolkata', shifts: [{ id: 's', timeZone: 'Europe/London' }] }, 's', 'UTC'), 'Asia/Kolkata');
  assert.equal(requestTimeZone({ timeZone: '', shifts: [{ id: 's', timeZone: 'Europe/London' }] }, 's', 'UTC'), 'Europe/London');
  assert.equal(requestTimeZone(undefined, null, 'UTC'), 'UTC');
  assert.equal(todayKeyIn('Asia/Kolkata', Date.parse('2026-11-12T20:00:00Z')), '2026-11-13');
  assert.equal(minutesText(1530), '01:30');
});

test('result text: waiting for approval vs desk assigns', () => {
  assert.equal(requestResultText({ status: 'REQUESTED' }), WAITING_FOR_APPROVAL);
  assert.equal(requestResultText({ status: 'PENDING_ASSIGNMENT', approval: 'PENDING' }), WAITING_FOR_APPROVAL);
  assert.equal(requestResultText({ status: 'PENDING_ASSIGNMENT', needsApproval: false, approval: 'NOT_REQUIRED' }), REQUESTED_DESK_ASSIGNS);
});

test('error mapping: NOT_ELIGIBLE reasons, consent, cut-off, duplicate, overlap, open requests, validation', () => {
  assert.equal(requestErrorText({ code: 'NOT_ELIGIBLE', body: { reason: 'SHIFT_NOT_RUNNING' } }), 'This shift does not run on the chosen day.');
  assert.equal(requestErrorText({ code: 'NOT_ELIGIBLE', body: { reason: 'WHATEVER' } }), NOT_ELIGIBLE_FALLBACK);
  assert.equal(requestErrorText({ code: 'NOT_ELIGIBLE', body: null }), NOT_ELIGIBLE_FALLBACK);
  assert.equal(requestErrorText({ code: 'CONSENT_REQUIRED' }), CONSENT_EXPLANATION);
  assert.match(requestErrorText({ code: 'AFTER_CUTOFF' }) ?? '', /cut-off passed/);
  assert.match(requestErrorText({ code: 'BOOKING_DUPLICATE' }) ?? '', /already have a booking/);
  assert.match(requestErrorText({ code: 'BOOKING_OVERLAP' }) ?? '', /already have a ride at this time/);
  assert.match(requestErrorText({ code: 'TOO_MANY_OPEN_REQUESTS' }) ?? '', /10 open ride requests/);
  assert.equal(requestErrorText({ code: 'VALIDATION_FAILED', message: 'windowStart must be a date' }), 'Check the request: windowStart must be a date');
  assert.equal(requestErrorText({ code: 'VALIDATION_FAILED', message: '' }), null);
  assert.equal(requestErrorText({ code: 'SOMETHING_ELSE' }), null);
  assert.equal(requestErrorText({ code: 'BOOKING_DUPLICATE' }, (k) => `T:${k}`), 'T:You already have a booking for this day and direction.');
  assert.equal(requestErrorField('CONSENT_REQUIRED'), 'pickup');
  assert.equal(requestErrorField('AFTER_CUTOFF'), 'window');
  assert.equal(requestErrorField('NOT_ELIGIBLE'), null);
});

test('approval labels of my bookings', () => {
  assert.deepEqual(approvalMeta({ status: 'REQUESTED', approval: 'PENDING' }), { label: WAITING_FOR_APPROVAL, tone: 'warning', reason: null });
  assert.deepEqual(approvalMeta({ status: 'PENDING_ASSIGNMENT', approval: 'APPROVED' }), { label: 'Approved', tone: 'success', reason: null });
  assert.deepEqual(approvalMeta({ status: 'REJECTED', approval: 'REJECTED', statusReason: ' No cab that day ' }), { label: 'Rejected', tone: 'destructive', reason: 'No cab that day' });
  assert.deepEqual(approvalMeta({ status: 'REJECTED', approval: 'REJECTED', statusReason: null }), { label: 'Rejected', tone: 'destructive', reason: null });
  assert.equal(approvalMeta({ status: 'PENDING_ASSIGNMENT', approval: 'NOT_REQUIRED' }), null, 'never shown as approved');
  assert.equal(approvalMeta({ status: 'REQUESTED' })?.label, WAITING_FOR_APPROVAL, 'older server without approval');
  assert.equal(approvalMeta({ status: 'ASSIGNED' }), null);
  assert.equal(myRouteText({ pickupLabel: 'Home', dropLabel: 'Main office' }), 'Home → Main office');
  assert.equal(myRouteText({ pickupLabel: null, dropLabel: 'Main office' }), '— → Main office');
  assert.equal(myRouteText({ pickupLabel: null, dropLabel: ' ' }), null);
});

test('cancel: status and cut-off, body and error texts', () => {
  const now = Date.parse('2026-11-12T10:00:00Z');
  assert.equal(cancelState({ status: 'REQUESTED', cutoffAt: '2026-11-12T11:00:00Z' }, now), 'CAN_CANCEL');
  assert.equal(cancelState({ status: 'CONFIRMED', cutoffAt: null }, now), 'CAN_CANCEL');
  assert.equal(cancelState({ status: 'ASSIGNED', cutoffAt: '2026-11-12T10:00:00Z' }, now), 'AFTER_CUTOFF');
  assert.equal(cancelState({ status: 'CANCELLED', cutoffAt: null }, now), 'NONE');
  assert.equal(cancelState({ status: 'REJECTED', cutoffAt: null }, now), 'NONE');
  assert.deepEqual(cancelBody('  '), {});
  assert.equal(cancelBody('r'.repeat(300)).reason?.length, 200);
  assert.match(cancelErrorText('AFTER_CUTOFF') ?? '', /cut-off has passed/);
  assert.equal(cancelErrorText('OTHER'), null);
});

test('address search: debounce / minimum length / keyboard', () => {
  assert.equal(ADDRESS_SEARCH.debounceMs, 350);
  assert.equal(addressQuery(' ab '), null);
  assert.equal(addressQuery('  Anna   Nagar '), 'Anna Nagar');
  assert.equal(nextActive('ArrowDown', -1, 3), 0);
  assert.equal(nextActive('ArrowDown', 2, 3), 0);
  assert.equal(nextActive('ArrowUp', 0, 3), 2);
  assert.equal(nextActive('ArrowUp', 2, 3), 1);
  assert.equal(nextActive('ArrowDown', 0, 0), -1);
});

test('every passenger-web string has Hindi and Tamil', () => {
  const missing = myRequestStrings().filter((k) => !HI[k] || !TA[k]);
  assert.deepEqual(missing, []);
  for (const k of ['Request a ride', 'Cancel ride', 'Cancel this ride?', 'Your ride is cancelled.', 'Arranged by the transport desk', 'Purpose: {{purpose}}', 'Not approved: {{reason}}', 'Type an address (at least 3 letters)…', '{{n}} address matches']) {
    assert.ok(HI[k] && TA[k], k);
  }
});
