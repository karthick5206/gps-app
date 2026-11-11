import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LineString } from 'geojson';
import { etaRouteFeatures } from './share-eta.ts';

// Chennai Central → airport as the API sends it: [lng, lat] pairs (RR-14).
const ROUTE: [number, number][] = [
  [80.2757, 13.0827],
  [80.22, 13.03],
  [80.1645, 12.981],
];

test('keeps the API [lng, lat] order (no swap) so the line is drawn where the road is', () => {
  const fc = etaRouteFeatures(ROUTE);
  const coords = (fc.features[0].geometry as LineString).coordinates;
  assert.deepEqual(coords, ROUTE);
  // MapLibre positions are [lng, lat]: for India, lng (68–98) > lat (6–37) on every vertex.
  assert.ok(coords.every(([lng, lat]) => lng > 60 && lat < 40));
});

test('no line for an empty or single-point route', () => {
  assert.equal(etaRouteFeatures([]).features.length, 0);
  assert.equal(etaRouteFeatures([[80.27, 13.08]]).features.length, 0);
  assert.equal(etaRouteFeatures(null).features.length, 0);
});
