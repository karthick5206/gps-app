/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  countdown,
  currentStop,
  NO_SHOW_WAIT_MS,
  noShowAvailableAt,
  offerTripAction,
  passengerActionState,
  passengerButtons,
  passengerPending,
  pickupUnlocked,
  stopActionState,
  tripActionState,
} from './driver-projection.ts';

const P = 'p1';

test('stop ARRIVED: pending locally until the server stop status says ARRIVED', () => {
  const stop = { seq: 2, status: 'PENDING' as const };
  assert.deepEqual(stopActionState(stop, 'ARRIVED', []), { display: 'NONE', code: null });
  const local = [{ type: 'ARRIVED', state: 'PENDING' as const, stopSeq: 2, code: null }];
  assert.equal(stopActionState(stop, 'ARRIVED', local).display, 'PENDING');
  assert.equal(stopActionState({ seq: 2, status: 'ARRIVED' }, 'ARRIVED', local).display, 'CONFIRMED');
  assert.equal(stopActionState({ seq: 3, status: 'PENDING' }, 'ARRIVED', local).display, 'NONE', 'other stop');
  const rejected = [{ type: 'ARRIVED', state: 'REJECTED' as const, stopSeq: 2, code: 'NOT_AT_STOP' }];
  assert.deepEqual(stopActionState(stop, 'ARRIVED', rejected), { display: 'REJECTED', code: 'NOT_AT_STOP' });
});

test('passenger outcome: server status confirms; a pending one is shown as pending, never as done', () => {
  const p = { passengerTripId: P, status: 'PENDING' as const, allowedEvents: ['BOARDED', 'NO_SHOW'] as ('BOARDED' | 'NO_SHOW' | 'DROPPED')[] };
  const boarded = [{ type: 'BOARDED', state: 'PENDING' as const, passengerTripId: P, code: null }];
  assert.equal(passengerActionState(p, 'BOARDED', boarded).display, 'PENDING');
  assert.deepEqual(passengerPending(p, boarded)?.type, 'BOARDED');
  assert.equal(passengerPending({ ...p, status: 'BOARDED' }, boarded), null);
  assert.equal(passengerActionState({ ...p, status: 'DROPPED' }, 'BOARDED', []).display, 'CONFIRMED');
});

test('passenger buttons: server allowedEvents per stop, then only DROPPED (at the drop stop) after a pending BOARDED', () => {
  const p = { passengerTripId: P, status: 'PENDING' as const, pickupSeq: 1, dropSeq: 3, allowedEvents: ['BOARDED', 'NO_SHOW'] as ('BOARDED' | 'NO_SHOW' | 'DROPPED')[] };
  assert.deepEqual(passengerButtons(p, [], 1), ['BOARDED', 'NO_SHOW']);
  assert.deepEqual(passengerButtons(p, [], 3), [], 'no pickup outcomes at the drop stop');
  const boarded = [{ type: 'BOARDED', state: 'PENDING' as const, passengerTripId: P, code: null }];
  assert.deepEqual(passengerButtons(p, boarded, 1), [], 'drop only at the drop stop');
  assert.deepEqual(passengerButtons(p, boarded, 3), ['DROPPED']);
  assert.deepEqual(passengerButtons(p, [{ type: 'NO_SHOW', state: 'PENDING', passengerTripId: P, code: null }], 1), []);
  // A rejected event does not block: the server's allowed events apply again.
  assert.deepEqual(passengerButtons(p, [{ type: 'BOARDED', state: 'REJECTED', passengerTripId: P, code: 'STOP_NOT_ARRIVED' }], 1), ['BOARDED', 'NO_SHOW']);
});

test('event order: pickup outcomes only once the stop is arrived (GPS / server, or a queued ARRIVED)', () => {
  assert.equal(pickupUnlocked({ seq: 1, status: 'PENDING' }, []), false);
  assert.equal(pickupUnlocked({ seq: 1, status: 'ARRIVED' }, []), true, 'GPS-arrived');
  assert.equal(pickupUnlocked({ seq: 1, status: 'PENDING' }, [{ type: 'ARRIVED', state: 'PENDING', stopSeq: 1, code: null }]), true);
  assert.equal(pickupUnlocked({ seq: 1, status: 'PENDING' }, [{ type: 'ARRIVED', state: 'REJECTED', stopSeq: 1, code: 'NOT_AT_STOP' }]), false);
});

test('no-show only 5 min after the arrival, with a countdown', () => {
  const t0 = Date.parse('2026-11-11T08:00:00Z');
  assert.equal(noShowAvailableAt({ seq: 1, status: 'ARRIVED', actualArrival: '2026-11-11T08:00:00Z' }, []), t0 + NO_SHOW_WAIT_MS);
  const queued = [{ type: 'ARRIVED', state: 'PENDING' as const, stopSeq: 1, code: null, occurredAt: '2026-11-11T08:00:00Z' }];
  assert.equal(noShowAvailableAt({ seq: 1, status: 'PENDING', actualArrival: null }, queued), t0 + NO_SHOW_WAIT_MS);
  assert.equal(noShowAvailableAt({ seq: 1, status: 'PENDING', actualArrival: null }, []), null);
  assert.equal(noShowAvailableAt({ seq: 1, status: 'ARRIVED', actualArrival: null }, []), 0);
  assert.equal(countdown(t0 + NO_SHOW_WAIT_MS, t0 + 55_000), '4:05');
  assert.equal(countdown(t0, t0 + 1), null);
});

test('current stop: first not departed / skipped; a pending local DEPARTED moves on', () => {
  const stops = [
    { seq: 3, status: 'PENDING' as const },
    { seq: 1, status: 'DEPARTED' as const },
    { seq: 2, status: 'ARRIVED' as const },
  ];
  assert.equal(currentStop(stops, [])?.seq, 2);
  assert.equal(currentStop(stops, [{ type: 'DEPARTED', state: 'PENDING', stopSeq: 2, code: null }])?.seq, 3);
  assert.equal(currentStop(stops, [{ type: 'DEPARTED', state: 'REJECTED', stopSeq: 2, code: 'UNRESOLVED_PASSENGERS' }])?.seq, 2);
  assert.equal(currentStop([{ seq: 1, status: 'SKIPPED' as const }], []), null);
});

test('trip actions: acknowledge / complete stay pending until the server trip shows them', () => {
  const trip = { acknowledgedAt: null, plannedTripStatus: 'IN_PROGRESS' as const };
  const local = [{ type: 'COMPLETE_TRIP', state: 'PENDING' as const, code: null }];
  const s = tripActionState(trip, 'COMPLETE_TRIP', local);
  assert.equal(s.display, 'PENDING');
  assert.equal(offerTripAction(true, s), false);
  assert.equal(tripActionState({ ...trip, plannedTripStatus: 'COMPLETED' }, 'COMPLETE_TRIP', local).display, 'CONFIRMED');
  assert.equal(tripActionState({ ...trip, acknowledgedAt: '2026-11-11T08:00:00Z' }, 'ACKNOWLEDGE', []).display, 'CONFIRMED');
  assert.equal(offerTripAction(true, tripActionState(trip, 'ACKNOWLEDGE', [])), true);
  assert.equal(offerTripAction(false, tripActionState(trip, 'ACKNOWLEDGE', [])), false);
});
