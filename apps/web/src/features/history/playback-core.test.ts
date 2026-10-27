import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TrackPoint } from '@veetracer/shared';
import {
  buildRuns,
  buildTrackIndex,
  findRun,
  findSegment,
  gapSegments,
  realToVirtual,
  sampleAt,
  speedBand,
  virtualToReal,
} from './playback-core.ts';

const T0 = Date.parse('2026-10-18T00:00:00Z');
const pt = (s: number, lat: number, lng: number, speed = 30, course = 0, status = 0): TrackPoint => [T0 + s * 1000, lat, lng, speed, course, 1, status];

test('findSegment returns arr[i] <= x < arr[i+1], clamped', () => {
  const a = [0, 10, 20, 30, 40];
  assert.equal(findSegment(a, -5), 0);
  assert.equal(findSegment(a, 0), 0);
  assert.equal(findSegment(a, 9.99), 0);
  assert.equal(findSegment(a, 10), 1);
  assert.equal(findSegment(a, 25), 2);
  assert.equal(findSegment(a, 39), 3);
  assert.equal(findSegment(a, 40), 3);
  assert.equal(findSegment(a, 99), 3);
  assert.equal(findSegment([5], 7), 0);
  assert.equal(findSegment([], 7), 0);
});

test('findSegment agrees with linear scan on a large array, with and without hints', () => {
  const n = 17_000;
  const a = new Float64Array(n);
  for (let i = 1; i < n; i++) a[i] = a[i - 1] + 1 + (i % 7);
  let hint = -1;
  for (let k = 0; k < 2000; k++) {
    const x = (a[n - 1] * k) / 1999;
    let expected = 0;
    while (expected < n - 2 && a[expected + 1] <= x) expected++;
    assert.equal(findSegment(a, x), expected);
    hint = findSegment(a, x, hint);
    assert.equal(hint, expected);
  }
  // A wrong hint must not change the result.
  assert.equal(findSegment(a, a[500] + 0.5, 12), 500);
});

test('sampleAt interpolates position, speed and distance inside a segment', () => {
  const idx = buildTrackIndex([pt(0, 13, 80, 0), pt(10, 13.001, 80, 40), pt(20, 13.002, 80, 60)], { skipStops: false });
  const s = sampleAt(idx, T0 + 5000);
  assert.equal(s.i, 0);
  assert.ok(Math.abs(s.f - 0.5) < 1e-9);
  assert.ok(Math.abs(s.lat - 13.0005) < 1e-9);
  assert.equal(s.lng, 80);
  assert.ok(Math.abs(s.speed - 20) < 1e-6);
  assert.ok(Math.abs(s.distKm - idx.dist[1] / 2) < 1e-9);
  // heading north
  assert.ok(s.bearing < 1 || s.bearing > 359);
  // clamped ends
  assert.equal(sampleAt(idx, T0 - 1000).lat, 13);
  assert.equal(sampleAt(idx, T0 + 99_000).lat, 13.002);
});

test('bearing follows geometry and turns along the shortest arc', () => {
  // north then east
  const idx = buildTrackIndex([pt(0, 13, 80), pt(10, 13.001, 80), pt(20, 13.001, 80.001)], { skipStops: false });
  assert.ok(Math.abs(idx.heading[1] - 90) < 0.5);
  const mid = sampleAt(idx, T0 + 10_000 + 1000); // 10 % into the eastbound segment → half-way through the turn
  assert.ok(mid.bearing > 30 && mid.bearing < 60, `bearing ${mid.bearing}`);
});

test('stationary heading is carried over instead of jumping to course 0', () => {
  const idx = buildTrackIndex([pt(0, 13, 80, 30, 90), pt(10, 13, 80.001, 30, 90), pt(20, 13, 80.001, 0, 0), pt(30, 13, 80.001, 0, 0)], { skipStops: false });
  assert.ok(Math.abs(idx.heading[2] - 90) < 0.5);
});

test('virtual time compresses stops when skipStops is on and round-trips with real time', () => {
  const pts = [pt(0, 13, 80, 30), pt(60, 13.005, 80, 30), pt(3660, 13.005, 80, 0), pt(3720, 13.01, 80, 30)];
  const full = buildTrackIndex(pts, { skipStops: false });
  assert.equal(full.duration, 3720_000);
  const skip = buildTrackIndex(pts, { skipStops: true });
  // the 1-hour stop (speed 0 at its end, but segment from moving point) - segment 1→2 moves 0 m with speed 30→0
  assert.ok(skip.duration < full.duration);
  for (const t of [0, 30_000, 60_000, 1_000_000, 3_660_000, 3_700_000]) {
    const v = realToVirtual(skip, T0 + t);
    assert.ok(Math.abs(virtualToReal(skip, v) - (T0 + t)) < 1e-6, `round trip at ${t}`);
  }
});

test('a whole stationary stretch is squeezed to 10 s with skipStops, proportionally', () => {
  const pts = [pt(0, 13, 80, 0)];
  for (let s = 5; s <= 3600; s += 5) pts.push(pt(s, 13, 80, 0)); // 1 h parked, 5 s sampling
  pts.push(pt(3610, 13.001, 80, 30));
  const idx = buildTrackIndex(pts, { skipStops: true });
  const stopEnd = idx.n - 2;
  assert.ok(Math.abs(idx.v[stopEnd] - 10_000) < 1e-6, `stop plays ${idx.v[stopEnd]} ms`);
  assert.ok(Math.abs(idx.v[1] - 10_000 / 720) < 1e-6);
  assert.ok(Math.abs(idx.v[idx.n - 1] - 20_000) < 1e-6); // moving segment keeps real time
});

test('duplicate / out-of-order timestamps are dropped', () => {
  const idx = buildTrackIndex([pt(0, 13, 80), pt(0, 13.1, 80), pt(10, 13.001, 80), pt(5, 13.2, 80)]);
  assert.equal(idx.n, 2);
});

test('runs share boundary points and split on status, band, gaps and size', () => {
  const pts: TrackPoint[] = [];
  for (let i = 0; i < 10; i++) pts.push(pt(i * 10, 13 + i * 0.001, 80, 30, 0, i < 5 ? 0 : 3));
  pts.push(pt(10_000, 13.02, 80, 30, 0, 3)); // 16+ minute gap
  const idx = buildTrackIndex(pts, { skipStops: false });
  const runs = buildRuns(idx, 256);
  assert.deepEqual(runs.map((r) => [r.a, r.b, r.status, r.gap]), [
    [0, 5, 0, false],
    [5, 9, 3, false],
    [9, 10, 3, true],
  ]);
  for (let k = 1; k < runs.length; k++) assert.equal(runs[k].a, runs[k - 1].b);
  assert.equal(findRun(runs, 0), 0);
  assert.equal(findRun(runs, 4), 0);
  assert.equal(findRun(runs, 5), 1);
  assert.equal(findRun(runs, 9), 2);
  const small = buildRuns(idx, 2);
  assert.ok(small.every((r) => r.b - r.a <= 2));
});

test('speed bands', () => {
  assert.equal(speedBand(0), 0);
  assert.equal(speedBand(19.9), 0);
  assert.equal(speedBand(20), 1);
  assert.equal(speedBand(79), 3);
  assert.equal(speedBand(120), 4);
});

test('sampling a 17k-point track 10k times is fast', () => {
  const pts: TrackPoint[] = [];
  for (let i = 0; i < 17_000; i++) pts.push(pt(i * 5, 13 + i * 1e-5, 80 + Math.sin(i / 50) * 1e-3, 30));
  const idx = buildTrackIndex(pts);
  const t0 = performance.now();
  let hint = -1;
  for (let k = 0; k < 10_000; k++) {
    const v = (idx.duration * k) / 10_000;
    const t = virtualToReal(idx, v, hint);
    hint = sampleAt(idx, t, hint).i;
  }
  assert.ok(performance.now() - t0 < 200);
});

test('gapSegments picks points ≥ 2 min and ≥ 500 m apart, longest first', () => {
  const idx = buildTrackIndex([
    pt(0, 13.0, 80.0),
    pt(10, 13.0005, 80.0), // normal 10 s step
    pt(400, 13.01, 80.0), // ~1 km after 6.5 min: gap
    pt(410, 13.0105, 80.0),
    pt(2000, 13.0108, 80.0), // 26 min but ~33 m: parked, not a gap to route
    pt(2200, 13.05, 80.0), // ~4.4 km after 3.3 min: gap
  ]);
  const segs = gapSegments(idx, 30);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].toLat, 13.05); // longest first
  assert.equal(segs[0].seconds, 200);
  assert.equal(segs[1].fromLat, 13.0005);
  assert.equal(gapSegments(idx, 1).length, 1);
});
