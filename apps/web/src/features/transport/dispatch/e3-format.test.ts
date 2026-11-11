import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  approvableIds,
  candidateReason,
  cutoffLabel,
  e3ErrorText,
  ETA_ESTIMATE_NOTE,
  etaView,
  isEditableTrip,
  newUuid,
  occupancy,
  occupancyLabel,
  passengerOutcomeView,
  shiftTimesLabel,
  straightLineLabel,
  unresolvedCount,
} from './e3-format.ts';

test('occupancy: levels, clamped ratio, seats not set', () => {
  assert.deepEqual(occupancy(3, 6), { used: 3, capacity: 6, free: 3, ratio: 0.5, level: 'available' });
  assert.equal(occupancy(0, 4).level, 'empty');
  assert.equal(occupancy(4, 4).level, 'full');
  const over = occupancy(5, 4);
  assert.equal(over.level, 'over');
  assert.equal(over.ratio, 1);
  assert.equal(over.free, 0);
  assert.deepEqual(occupancy(2, null), { used: 2, capacity: null, free: null, ratio: 0, level: 'unknown' });
  assert.equal(occupancy(-1, 0).level, 'unknown');
  assert.equal(occupancyLabel(occupancy(3, 6)), '3 / 6 seats');
  assert.equal(occupancyLabel(occupancy(2, null)), '2 seats used · seats not set');
});

test('passenger outcome labels: GPS-reached stop without an outcome is "Outcome not recorded"', () => {
  assert.deepEqual(passengerOutcomeView({ status: 'PENDING', outcomeMissing: true, outcomeSource: null }), { label: 'Outcome not recorded', tone: 'warning', source: null });
  assert.equal(passengerOutcomeView({ status: 'PENDING', outcomeMissing: false, outcomeSource: null }).label, 'Waiting');
  assert.deepEqual(passengerOutcomeView({ status: 'BOARDED', outcomeMissing: false, outcomeSource: 'WEB' }), { label: 'Boarded', tone: 'success', source: 'Recorded by the dispatcher' });
  assert.equal(passengerOutcomeView({ status: 'NO_SHOW', outcomeMissing: false, outcomeSource: 'DRIVER_APP' }).source, 'Recorded in the driver app');
  assert.equal(passengerOutcomeView({ status: 'NO_SHOW', outcomeMissing: false, outcomeSource: 'WEB' }).tone, 'destructive');
  assert.equal(passengerOutcomeView({ status: 'CANCELLED', outcomeMissing: false, outcomeSource: null }).label, 'Removed');
  // A BOARDED passenger is never shown as missing, even when the flag is (wrongly) set.
  assert.equal(passengerOutcomeView({ status: 'BOARDED', outcomeMissing: true, outcomeSource: 'WEB' }).label, 'Boarded');
  assert.equal(unresolvedCount([{ status: 'PENDING' }, { status: 'BOARDED' }, { status: 'PENDING' }, { status: 'CANCELLED' }]), 2);
});

test('ETA: road estimate labelled, degraded gives a reason and never a time', () => {
  assert.deepEqual(etaView({ at: '2026-11-10T03:30:00Z', model: 'ROAD', durationSec: 600 }), { at: '2026-11-10T03:30:00Z', note: ETA_ESTIMATE_NOTE, degraded: false });
  assert.equal(ETA_ESTIMATE_NOTE, 'estimate · no live traffic');
  assert.equal(etaView({ at: '2026-11-10T03:30:00Z', model: 'TRACKER' }).note, 'from the vehicle tracker');
  assert.deepEqual(etaView({ at: null, model: null, degraded: 'ROUTING_UNAVAILABLE' }), { at: null, note: 'Routing unavailable: no ETA', degraded: true });
  assert.equal(etaView({ at: null, model: null, degraded: 'NO_FIX' }).at, null);
  assert.equal(etaView({ at: null, model: null, degraded: 'NO_ROUTE' }).note, 'No road route found: no ETA');
  // A time without a model is not trusted.
  assert.equal(etaView({ at: '2026-11-10T03:30:00Z', model: null }).at, null);
  assert.equal(etaView(null).note, 'No ETA');
  assert.equal(straightLineLabel(850), '850 m straight line');
  assert.equal(straightLineLabel(2345), '2.3 km straight line');
  assert.equal(straightLineLabel(12_600), '13 km straight line');
  assert.equal(straightLineLabel(null), null);
});

test('bookings: cut-off label, approvable selection', () => {
  const now = Date.parse('2026-11-10T03:00:00Z');
  assert.equal(cutoffLabel('2026-11-10T03:25:00Z', 'PENDING_ASSIGNMENT', now), 'Cut-off in 25 min');
  assert.equal(cutoffLabel('2026-11-10T06:00:00Z', 'REQUESTED', now), 'Cut-off in 3 h');
  assert.equal(cutoffLabel('2026-11-10T02:00:00Z', 'ASSIGNED', now), 'After cut-off');
  assert.equal(cutoffLabel('2026-11-10T02:00:00Z', 'CANCELLED', now), null);
  assert.equal(cutoffLabel(null, 'REQUESTED', now), null);
  const rows = [
    { id: 'a', status: 'REQUESTED' as const },
    { id: 'b', status: 'PENDING_ASSIGNMENT' as const },
    { id: 'c', status: 'WAITLISTED' as const },
    { id: 'd', status: 'REQUESTED' as const },
  ];
  assert.deepEqual(approvableIds(rows, new Set(['a', 'b', 'c'])), ['a', 'c']);
});

test('errors, reasons, trip editability, shift times, uuid', () => {
  assert.match(e3ErrorText('VERSION_CONFLICT')!, /changed this meanwhile/);
  assert.match(e3ErrorText('CAPACITY_EXCEEDED')!, /free seats/);
  assert.match(e3ErrorText('CONSENT_REQUIRED')!, /consented/);
  assert.equal(e3ErrorText('SOMETHING_ELSE'), null);
  assert.equal(e3ErrorText(null), null);
  assert.equal(candidateReason('CAPACITY'), 'Not enough free seats');
  assert.equal(candidateReason('NEW_CODE'), 'NEW_CODE');
  assert.equal(isEditableTrip('PUBLISHED'), true);
  assert.equal(isEditableTrip('EN_ROUTE'), false);
  assert.equal(shiftTimesLabel(540, 1080), '09:00 – 18:00');
  assert.equal(shiftTimesLabel(1320, 360), '22:00 – 06:00 (next day)');
  assert.match(newUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
