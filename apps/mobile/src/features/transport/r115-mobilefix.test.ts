/// <reference types="node" />
/**
 * v1.15.0 QA fixes on the phone (r115-qa): B2 trip headers for point-to-point trips; B4 the "Approved" chip follows
 * MeBookingDto.approval; B8 the request window zone is the company zone first. Synthetic data only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { passengerStatusLine, passengerStatusMeta, requestTimeZone } from './adhoc-request.ts';
import { BOOKING_STATUS_META, POINT_TO_POINT_LABEL, tripKindLabel } from './labels.ts';

test('B2: a point-to-point trip (stored as IN) is headed "Point-to-point", not "To site (login)"', () => {
  assert.equal(tripKindLabel({ direction: 'IN', journey: 'POINT_TO_POINT' }), POINT_TO_POINT_LABEL);
  assert.equal(tripKindLabel({ direction: 'OUT', journey: 'POINT_TO_POINT' }), POINT_TO_POINT_LABEL);
});

test('B2: a commute trip, an older server without journey, or an unknown journey keeps the direction wording', () => {
  assert.equal(tripKindLabel({ direction: 'IN', journey: 'COMMUTE' }), 'To site (login)');
  assert.equal(tripKindLabel({ direction: 'OUT', journey: 'COMMUTE' }), 'From site (logout)');
  assert.equal(tripKindLabel({ direction: 'IN' }), 'To site (login)');
  assert.equal(tripKindLabel({ direction: 'OUT', journey: 'SOMETHING_NEW' }), 'From site (logout)');
});

const own = { source: 'ADHOC', arrangedByDesk: false } as const;

test('B4: "Approved" only when approval is APPROVED and the booking still waits for a seat', () => {
  assert.deepEqual(passengerStatusMeta({ ...own, status: 'PENDING_ASSIGNMENT', approval: 'APPROVED' }, BOOKING_STATUS_META), { label: 'Approved', tone: 'info' });
  // A desk booking held for approval and then approved is approved too.
  assert.deepEqual(passengerStatusMeta({ source: 'ADHOC', arrangedByDesk: true, status: 'PENDING_ASSIGNMENT', approval: 'APPROVED' }, BOOKING_STATUS_META), { label: 'Approved', tone: 'info' });
  // Once seated the normal "Assigned" wording wins.
  assert.deepEqual(passengerStatusMeta({ ...own, status: 'ASSIGNED', approval: 'APPROVED' }, BOOKING_STATUS_META), BOOKING_STATUS_META.ASSIGNED);
});

test('B4: NOT_REQUIRED (approval switched off) or no approval field keeps the normal waiting / assigned wording', () => {
  assert.deepEqual(passengerStatusMeta({ ...own, status: 'PENDING_ASSIGNMENT', approval: 'NOT_REQUIRED' }, BOOKING_STATUS_META), BOOKING_STATUS_META.PENDING_ASSIGNMENT);
  assert.deepEqual(passengerStatusMeta({ ...own, status: 'ASSIGNED', approval: 'NOT_REQUIRED' }, BOOKING_STATUS_META), BOOKING_STATUS_META.ASSIGNED);
  assert.deepEqual(passengerStatusMeta({ ...own, status: 'PENDING_ASSIGNMENT' }, BOOKING_STATUS_META), BOOKING_STATUS_META.PENDING_ASSIGNMENT);
  // The explanatory line stays true without claiming an approval.
  assert.deepEqual(passengerStatusLine({ ...own, status: 'PENDING_ASSIGNMENT', approval: 'NOT_REQUIRED' }), { text: 'The transport desk will assign a cab.', reason: null });
});

test('B4: PENDING and REJECTED map to "Requested" / "Rejected"', () => {
  assert.deepEqual(passengerStatusMeta({ ...own, status: 'REQUESTED', approval: 'PENDING' }, BOOKING_STATUS_META), { label: 'Requested', tone: 'warning' });
  assert.deepEqual(passengerStatusMeta({ ...own, status: 'REJECTED', approval: 'REJECTED' }, BOOKING_STATUS_META), { label: 'Rejected', tone: 'destructive' });
});

const shifts = [
  { id: 's1', timeZone: 'Asia/Kolkata' },
  { id: 's2', timeZone: 'Asia/Dubai' },
];

test('B8: the request window uses the company zone (policy.timeZone) first, never the phone zone', () => {
  assert.equal(requestTimeZone({ timeZone: 'America/New_York', shifts }, 's2', 'Europe/London'), 'America/New_York');
  assert.equal(requestTimeZone({ timeZone: 'America/New_York', shifts: [] }, null, 'Europe/London'), 'America/New_York');
});

test('B8: without a company zone (older server): the chosen shift, then the first shift, then the phone', () => {
  assert.equal(requestTimeZone({ shifts }, 's2', 'Europe/London'), 'Asia/Dubai');
  assert.equal(requestTimeZone({ timeZone: '', shifts }, null, 'Europe/London'), 'Asia/Kolkata');
  assert.equal(requestTimeZone({ shifts: [] }, null, 'Europe/London'), 'Europe/London');
  assert.equal(requestTimeZone(undefined, null, 'Europe/London'), 'Europe/London');
});
