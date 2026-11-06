import assert from 'node:assert/strict';
import { test } from 'node:test';
import { haloState, markerBadge, shortAge } from './marker-motion.ts';

test('shortAge rounds to minutes, hours, then days', () => {
  assert.equal(shortAge(20_000), '1m');
  assert.equal(shortAge(18 * 60_000), '18m');
  assert.equal(shortAge(5 * 3_600_000 + 10 * 60_000), '5h');
  assert.equal(shortAge(3 * 86_400_000), '3d');
});

test('markerBadge: speed when overspeeding, durations for idle and offline, nothing otherwise', () => {
  const now = Date.parse('2026-11-06T10:00:00Z');
  assert.equal(markerBadge('OVERSPEED', 91.6, null, now), '92');
  assert.equal(markerBadge('IDLE', 0, '2026-11-06T09:42:00Z', now), '18m');
  assert.equal(markerBadge('OFFLINE', 0, '2026-11-06T08:00:00Z', now), '2h');
  assert.equal(markerBadge('RUNNING', 54, '2026-11-06T09:00:00Z', now), '');
  assert.equal(markerBadge('OFF', 0, '2026-11-06T09:00:00Z', now), '');
  assert.equal(markerBadge('IDLE', 0, null, now), '');
  assert.equal(markerBadge('IDLE', 0, 'not a date', now), '');
});

test('haloState pulses outward and fades, and is fixed when still', () => {
  const start = haloState(0, false);
  const mid = haloState(1000, false);
  assert.equal(start.scale.RUNNING, 1);
  assert.ok(mid.scale.RUNNING > start.scale.RUNNING);
  assert.ok(mid.opacity.RUNNING < start.opacity.RUNNING);
  assert.deepEqual(haloState(0, true), haloState(12345, true));
});
