import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interpolatePose, lerpBearing, normalizeBearing } from './geo.ts';

test('normalizeBearing wraps into [0, 360)', () => {
  assert.equal(normalizeBearing(370), 10);
  assert.equal(normalizeBearing(-10), 350);
  assert.equal(normalizeBearing(360), 0);
});

test('lerpBearing takes the shortest arc across north', () => {
  assert.equal(lerpBearing(350, 10, 0.5), 0);
  assert.equal(lerpBearing(10, 350, 0.5), 0);
  assert.equal(lerpBearing(90, 270, 0), 90);
  assert.equal(lerpBearing(0, 90, 1), 90);
  assert.equal(lerpBearing(0, 90, 0.5), 45);
});

test('interpolatePose clamps t and eases between endpoints', () => {
  const from = { lng: 80, lat: 13, bearing: 350 };
  const to = { lng: 81, lat: 14, bearing: 10 };
  assert.deepEqual(interpolatePose(from, to, 0), from);
  assert.deepEqual(interpolatePose(from, to, 2), { lng: 81, lat: 14, bearing: 10 });
  const mid = interpolatePose(from, to, 0.5);
  assert.equal(mid.lng, 80.5);
  assert.equal(mid.lat, 13.5);
  assert.equal(mid.bearing, 0);
});
