import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressSearchView, isRateLimited, moveActive, roundHit, searchTerm } from './address-search.ts';

test('searchTerm trims, collapses spaces and needs 3 characters', () => {
  assert.equal(searchTerm('  ab '), null);
  assert.equal(searchTerm(' abc '), 'abc');
  assert.equal(searchTerm('Anna   Nagar  2nd'), 'Anna Nagar 2nd');
  assert.equal(searchTerm('ab', 2), 'ab');
});

test('moveActive wraps and starts from the ends', () => {
  assert.equal(moveActive(-1, 0, 1), -1);
  assert.equal(moveActive(-1, 3, 1), 0);
  assert.equal(moveActive(-1, 3, -1), 2);
  assert.equal(moveActive(2, 3, 1), 0);
  assert.equal(moveActive(0, 3, -1), 2);
  assert.equal(moveActive(5, 3, 1), 0);
});

test('isRateLimited only for HTTP 429', () => {
  assert.equal(isRateLimited({ status: 429 }), true);
  assert.equal(isRateLimited({ status: 500 }), false);
  assert.equal(isRateLimited(null), false);
});

test('addressSearchView: typing, results, empty, errors', () => {
  const base = { typed: 'anna', settled: 'anna', fetching: false, error: null, hits: 0 };
  assert.equal(addressSearchView({ ...base, typed: null }), 'idle');
  assert.equal(addressSearchView({ ...base, settled: 'ann' }), 'loading');
  assert.equal(addressSearchView({ ...base, fetching: true }), 'loading');
  assert.equal(addressSearchView({ ...base, hits: 2 }), 'results');
  assert.equal(addressSearchView({ ...base, hits: 2, fetching: true }), 'results');
  assert.equal(addressSearchView(base), 'empty');
  assert.equal(addressSearchView({ ...base, error: { status: 429 } }), 'rate-limited');
  assert.equal(addressSearchView({ ...base, error: { status: 502 } }), 'error');
  // an error of the previous term is not shown while the new one is pending
  assert.equal(addressSearchView({ ...base, settled: 'ann', error: { status: 429 } }), 'loading');
});

test('roundHit keeps 6 decimals', () => {
  assert.deepEqual(roundHit({ label: 'x', lat: 13.123456789, lng: 80.987654321 }), { label: 'x', lat: 13.123457, lng: 80.987654 });
});
