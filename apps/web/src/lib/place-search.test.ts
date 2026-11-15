import assert from 'node:assert/strict';
import { test } from 'node:test';
import { biasPoint, coordinateHit, placeSearchReady, withCoordinateHit } from './place-search.ts';

test('coordinateHit: decimal, hemispheres and DMS become a point; addresses do not', () => {
  assert.deepEqual(coordinateHit(' 12.97, 77.59 '), { label: '12.970000, 77.590000', lat: 12.97, lng: 77.59, coordinates: true });
  assert.deepEqual(coordinateHit('40.7128N 74.006W'), { label: '40.712800, -74.006000', lat: 40.7128, lng: -74.006, coordinates: true });
  assert.equal(coordinateHit(`12°58'17"N 77°35'40"E`)?.lat, 12.971389);
  assert.equal(coordinateHit('Anna Salai'), null);
  assert.equal(coordinateHit('95.5, 200.1'), null);
});

test('withCoordinateHit puts the coordinates first, with the address the API found for that point', () => {
  const api = [
    { label: 'MG Road, Bengaluru', lat: 12.97, lng: 77.59, confidence: 1 },
    { label: 'Elsewhere', lat: 12.98, lng: 77.6 },
  ];
  assert.deepEqual(withCoordinateHit('12.97, 77.59', api), [
    { label: 'MG Road, Bengaluru', lat: 12.97, lng: 77.59, coordinates: true },
    { label: 'Elsewhere', lat: 12.98, lng: 77.6 },
  ]);
  // Before the API answers: the formatted coordinates.
  assert.deepEqual(withCoordinateHit('12.97, 77.59', undefined), [{ label: '12.970000, 77.590000', lat: 12.97, lng: 77.59, coordinates: true }]);
  // Not coordinates: the API hits as they are (extra fields dropped), capped.
  assert.deepEqual(withCoordinateHit('Bengaluru', api, 1), [{ label: 'MG Road, Bengaluru', lat: 12.97, lng: 77.59 }]);
});

test('placeSearchReady: 3+ characters or coordinates', () => {
  assert.equal(placeSearchReady('ab'), false);
  assert.equal(placeSearchReady('abc'), true);
  assert.equal(placeSearchReady('1,2'), true);
  assert.equal(placeSearchReady('  '), false);
});

test('biasPoint wraps the longitude and rounds', () => {
  assert.deepEqual(biasPoint({ lat: 13.061234, lng: 80.249876 }), { lat: 13.0612, lng: 80.2499 });
  assert.deepEqual(biasPoint({ lat: 40.7, lng: -74 - 360 }), { lat: 40.7, lng: -74 });
  assert.deepEqual(biasPoint({ lat: 21.3, lng: 202.15 }), { lat: 21.3, lng: -157.85 });
  assert.equal(biasPoint(null), null);
  assert.equal(biasPoint({ lat: Number.NaN, lng: 1 }), null);
});
