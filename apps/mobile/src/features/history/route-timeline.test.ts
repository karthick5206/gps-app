import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TrackIndex } from './playback-core.ts';
import { collapseSameAddress, routeCheckpoints, ROUTE_MAX_ROWS } from './route-timeline.ts';

/** Straight track: one point a minute, `kmPerPoint` apart. */
function track(points: number, kmPerPoint: number): TrackIndex {
  const n = points;
  const idx = { n, t: new Float64Array(n), lat: new Float64Array(n), lng: new Float64Array(n), dist: new Float64Array(n) } as unknown as TrackIndex;
  for (let i = 0; i < n; i++) {
    idx.t[i] = 1_000_000 + i * 60_000;
    idx.lat[i] = 13 + i * 0.001;
    idx.lng[i] = 80;
    idx.dist[i] = i * kmPerPoint;
  }
  return idx;
}

test('start, a row about every 0.75 km, and the end, with the GPS times', () => {
  const idx = track(31, 0.25); // 7.5 km
  const rows = routeCheckpoints(idx, idx.t[0], idx.t[30]);
  assert.equal(rows[0].t, idx.t[0]);
  assert.equal(rows[rows.length - 1].t, idx.t[30]);
  assert.equal(rows[1].km, 0.75);
  assert.equal(rows.length, 11);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].t > rows[i - 1].t);
});

test('only points inside the trip window', () => {
  const idx = track(31, 0.25);
  const rows = routeCheckpoints(idx, idx.t[10], idx.t[20]);
  assert.equal(rows[0].t, idx.t[10]);
  assert.equal(rows[0].km, 0);
  assert.equal(rows[rows.length - 1].t, idx.t[20]);
});

test('long trips stay within the row limit', () => {
  const idx = track(2001, 0.1); // 200 km
  const rows = routeCheckpoints(idx, idx.t[0], idx.t[2000]);
  assert.ok(rows.length <= ROUTE_MAX_ROWS + 1, String(rows.length));
  assert.equal(rows[rows.length - 1].t, idx.t[2000]);
});

test('no points in the window → nothing', () => {
  const idx = track(5, 1);
  assert.deepEqual(routeCheckpoints(idx, 0, 1), []);
});

test('same street in a row collapses to its first time; the end always shows', () => {
  const rows = [
    { t: 1, address: 'A' },
    { t: 2, address: 'A' },
    { t: 3, address: 'B' },
    { t: 4, address: 'B' },
  ];
  assert.deepEqual(collapseSameAddress(rows).map((r) => r.t), [1, 3, 4]);
});
