import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deskExceptions } from './exceptions.ts';

const NOW = Date.parse('2026-11-16T04:00:00.000Z');
const trip = (over: Record<string, unknown> = {}) =>
  ({
    id: 't1',
    name: 'Trip',
    vehicleName: 'Van 2',
    objectId: 'van',
    driverId: 'd1',
    derivedState: 'PUBLISHED',
    plannedTripStatus: 'SCHEDULED',
    publishedAt: '2026-11-15T10:00:00.000Z',
    plannedStart: '2026-11-16T03:30:00.000Z',
    cancelledAt: null,
    delaySec: null,
    passengerCounts: { pending: 0, boarded: 0, noShow: 0, dropped: 0, cancelled: 0 },
    ...over,
  }) as never;
const booking = (over: Record<string, unknown> = {}) =>
  ({ id: 'b1', status: 'PENDING_ASSIGNMENT', windowStart: '2026-11-16T04:30:00.000Z', windowEnd: '2026-11-16T05:30:00.000Z', needsLocation: false, pointsHidden: null, passenger: { displayName: 'Asha' }, ...over }) as never;

test('not started, late, no driver, non-compliant and outcomes missing', () => {
  const ex = deskExceptions(
    {
      trips: [trip(), trip({ id: 't2', derivedState: 'EN_ROUTE', plannedTripStatus: 'STARTED', delaySec: 900 }), trip({ id: 't3', driverId: null, plannedStart: '2026-11-16T09:00:00.000Z' }), trip({ id: 't4', derivedState: 'COMPLETED', plannedTripStatus: 'COMPLETED', passengerCounts: { pending: 2, boarded: 1, noShow: 0, dropped: 0, cancelled: 0 } })],
      queue: [],
      vehicles: [{ objectId: 'van', compliance: [{ type: 'INSURANCE', label: 'Insurance', state: 'EXPIRED', expiresOn: '2026-10-01' }] }] as never,
      complianceMode: 'WARN',
    },
    NOW,
    1,
  );
  const kinds = ex.map((e) => e.kind);
  assert.deepEqual(kinds.slice(0, 2).sort(), ['NOT_STARTED', 'SOS']);
  assert.ok(kinds.includes('LATE'));
  assert.ok(kinds.includes('NO_DRIVER'));
  assert.ok(kinds.includes('NOT_COMPLIANT'));
  assert.ok(kinds.includes('OUTCOME_MISSING'));
  assert.deepEqual(ex.find((e) => e.kind === 'LATE')?.names, ['Van 2 (+15 min)']);
});

test('riders waiting soon, needing approval or a point', () => {
  const ex = deskExceptions({ trips: [], queue: [booking(), booking({ id: 'b2', status: 'REQUESTED', windowStart: '2026-11-16T09:00:00.000Z', windowEnd: '2026-11-16T10:00:00.000Z' }), booking({ id: 'b3', needsLocation: true, windowStart: '2026-11-16T12:00:00.000Z', windowEnd: '2026-11-16T13:00:00.000Z' })], vehicles: [], complianceMode: 'OFF' }, NOW);
  assert.deepEqual(ex.find((e) => e.kind === 'WAITING_SOON')?.bookingIds, ['b1']);
  assert.deepEqual(ex.find((e) => e.kind === 'TO_APPROVE')?.bookingIds, ['b2']);
  assert.deepEqual(ex.find((e) => e.kind === 'NO_LOCATION')?.bookingIds, ['b3']);
});
