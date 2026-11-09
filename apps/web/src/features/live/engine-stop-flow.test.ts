import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EngineStopPrepareResponse } from '@veetracer/shared';
import { ageSec, canConfirm, secondsLeft, shouldPoll, waitLeft } from './engine-stop-flow.ts';

const NOW = Date.parse('2026-11-09T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const prep = (over: Partial<EngineStopPrepareResponse> = {}): EngineStopPrepareResponse => ({
  requestId: 'r1',
  status: 'ready',
  requestedAt: iso(NOW - 5000),
  message: null,
  blockReason: null,
  freshPosition: { lat: 13, lng: 80, speedKph: 0, status: 'OFF', ignition: false, satellites: 9, fixTime: iso(NOW - 3000), serverTime: iso(NOW - 2000) },
  confirmBy: iso(NOW + 58_000),
  ...over,
});

test('confirm only for a ready preparation still inside the engine-stop window', () => {
  assert.equal(canConfirm(prep(), NOW), true);
  assert.equal(canConfirm(prep({ confirmBy: iso(NOW - 1) }), NOW), false);
  assert.equal(canConfirm(prep({ status: 'blocked', blockReason: 'moving' }), NOW), false);
  assert.equal(canConfirm(prep({ status: 'waiting', freshPosition: null }), NOW), false);
  assert.equal(canConfirm(prep({ requestId: null }), NOW), false);
  assert.equal(canConfirm(null, NOW), false);
});

test('polls only while waiting', () => {
  assert.equal(shouldPoll(prep({ status: 'waiting' })), true);
  for (const status of ['ready', 'blocked', 'timeout', 'not_connected'] as const) assert.equal(shouldPoll(prep({ status })), false);
  assert.equal(shouldPoll(prep({ status: 'waiting', requestId: null })), false);
});

test('countdowns', () => {
  assert.equal(secondsLeft(iso(NOW + 12_500), NOW), 12);
  assert.equal(secondsLeft(null, NOW), 0);
  assert.equal(ageSec(iso(NOW - 7_900), NOW), 7);
  assert.equal(waitLeft(iso(NOW - 10_000), NOW), 35);
  assert.equal(waitLeft(iso(NOW - 100_000), NOW), 0);
});
