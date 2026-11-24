/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { occurrenceMapUrl, occurrencePlace, scoreBand, TRIP_SAFETY_HEADERS, violationBreakdown } from './trip-safety.ts';

test('place: address first, else coordinates, else null', () => {
  assert.equal(occurrencePlace({ address: 'OMR, Chennai', lat: 12.9, lng: 80.2 }), 'OMR, Chennai');
  assert.equal(occurrencePlace({ address: null, lat: 12.912345678, lng: 80.2 }), '12.91235, 80.20000');
  assert.equal(occurrencePlace({ address: null, lat: null, lng: null }), null);
});

test('maps link only with coordinates', () => {
  assert.equal(occurrenceMapUrl({ lat: 12.9, lng: 80.2 }), 'https://www.google.com/maps?q=12.9,80.2');
  assert.equal(occurrenceMapUrl({ lat: null, lng: 80.2 }), null);
});

test('breakdown keeps column order and skips zeros', () => {
  assert.deepEqual(violationBreakdown({ OVERSPEED: 1, SEATBELT_OFF: 2, DRIVER_PHONE: 0 }), [
    ['SEATBELT_OFF', 2],
    ['OVERSPEED', 1],
  ]);
  assert.deepEqual(violationBreakdown(undefined), []);
  assert.equal(Object.keys(TRIP_SAFETY_HEADERS).length, 15);
});

test('score bands match the web thresholds', () => {
  assert.equal(scoreBand(100), 'good');
  assert.equal(scoreBand(90), 'good');
  assert.equal(scoreBand(89), 'fair');
  assert.equal(scoreBand(70), 'fair');
  assert.equal(scoreBand(69), 'poor');
});
