import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeLine } from './change-set-format.ts';
import { etaView } from './e3-format.ts';

const P = { id: 'p', displayName: 'Asha', employeeCode: 'E1' };

test('saved draft details: one readable line per change', () => {
  assert.equal(changeLine({ op: 'CREATE_TRIP', tempId: 'n', objectId: 'o', vehicleName: 'Van 2', driverId: null, driverName: null, plannedStart: '2026-12-01T02:00:00Z', routeId: null, name: null, stops: [{ seq: 0, label: 'Gate', point: null, plannedArrival: '2026-12-01T02:00:00Z' }] }), 'New trip on Van 2, 1 stop(s)');
  assert.equal(changeLine({ op: 'ADD_STOP', tripId: 't', tripLabel: 'Van 1 · Login', bookingId: 'b', passenger: P, end: 'PICKUP', afterSeq: 0, plannedArrival: null }), 'New pickup stop for Asha (E1) on Van 1 · Login, after stop 1');
  assert.equal(changeLine({ op: 'ADD_PASSENGER', tripId: 't', tripLabel: 'Van 1', bookingId: 'b', passenger: P, bookingStatus: 'PENDING_ASSIGNMENT', pickupSeq: 1, dropSeq: 2 }), 'Seat Asha (E1) on Van 1 (stops 2 → 3)');
  assert.equal(changeLine({ op: 'REASSIGN_DRIVER', tripId: 't', tripLabel: 'Van 1', driverId: null, driverName: null }), 'Remove the driver of Van 1');
});

test('TRIP candidate ETA: a road estimate labelled "estimate · no live traffic"; no pickup → reason, no time', () => {
  assert.deepEqual(etaView({ at: '2026-12-01T02:10:00.000Z', model: 'ROAD', durationSec: 600, from: 'TRIP_STOP', fromStopSeq: 0 }), { at: '2026-12-01T02:10:00.000Z', note: 'estimate · no live traffic', degraded: false });
  assert.deepEqual(etaView({ at: null, model: null, degraded: 'NO_PICKUP' }), { at: null, note: 'No pickup point to route to: no ETA', degraded: true });
});
