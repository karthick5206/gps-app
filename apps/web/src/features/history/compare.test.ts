import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TrackPoint } from '@veetracer/shared';
import { MAX_COMPARE, compareColor, compareFeatures, noDataSeconds, parseCompareIds, unionBounds } from './compare.ts';
import { GAP_MS, buildTrackIndex } from './playback-core.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 3, 6, 0, 0);

const pt = (minute: number, lat: number, lng: number): TrackPoint => [T0 + minute * MIN, lat, lng, 30, 0, 1, 0];

function track(minutes: number[]) {
  return buildTrackIndex(minutes.map((m, i) => pt(m, 12.9 + i * 0.001, 80.2 + i * 0.001)), { skipStops: false });
}

test('parseCompareIds drops blanks, repeats and the selected vehicle, and caps the list', () => {
  assert.deepEqual(parseCompareIds(null, 'a'), []);
  assert.deepEqual(parseCompareIds('', 'a'), []);
  assert.deepEqual(parseCompareIds('b, a,,b,c', 'a'), ['b', 'c']);
  assert.equal(parseCompareIds('1,2,3,4,5,6,7', null).length, MAX_COMPARE);
});

test('every vehicle that can be shown has its own colour, in both themes', () => {
  for (const theme of ['light', 'dark'] as const) {
    const colors = Array.from({ length: MAX_COMPARE + 1 }, (_, i) => compareColor(theme, i));
    assert.equal(new Set(colors).size, MAX_COMPARE + 1);
  }
});

test('compareFeatures draws recorded stretches solid and a data gap dashed, in the given colour', () => {
  const idx = track([0, 1, 2, 2 + GAP_MS / MIN + 1, 2 + GAP_MS / MIN + 2]);
  const f = compareFeatures(idx, '#123456', 0);
  assert.deepEqual(f.map((x) => x.properties?.gap), [false, true, false]);
  assert.deepEqual(f.map((x) => x.geometry.coordinates.length), [3, 2, 2]);
  assert.ok(f.every((x) => x.properties?.color === '#123456'));
  // The dashed line joins the last point before the gap to the first one after it.
  assert.deepEqual(f[1].geometry.coordinates[0], f[0].geometry.coordinates[2]);
  assert.deepEqual(f[1].geometry.coordinates[1], f[2].geometry.coordinates[0]);
});

test('later vehicles get narrower lines so overlapping paths stay visible', () => {
  const idx = track([0, 1]);
  const widths = [0, 1, 2, 3].map((o) => compareFeatures(idx, '#000', o)[0].properties?.w as number);
  for (let i = 1; i < widths.length; i++) assert.ok(widths[i] < widths[i - 1]);
});

test('compareFeatures has nothing to draw for an empty or single-point track', () => {
  assert.deepEqual(compareFeatures(track([]), '#000', 0), []);
  assert.deepEqual(compareFeatures(track([0]), '#000', 0), []);
});

test('noDataSeconds adds up only the gaps longer than the gap limit', () => {
  assert.equal(noDataSeconds(track([0, 1, 2])), 0);
  const gapMin = GAP_MS / MIN + 5;
  assert.equal(noDataSeconds(track([0, 1, 1 + gapMin, 2 + gapMin])), gapMin * 60);
});

test('unionBounds covers every track and ignores missing ones', () => {
  const a = track([0, 1]);
  const b = buildTrackIndex([pt(0, 13.5, 79.5)], { skipStops: false });
  assert.equal(unionBounds([null, undefined, track([])]), null);
  assert.deepEqual(unionBounds([a, null, b]), [[79.5, a.lat[0]], [a.lng[1], 13.5]]);
});
