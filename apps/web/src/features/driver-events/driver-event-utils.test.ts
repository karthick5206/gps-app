import assert from 'node:assert/strict';
import { test } from 'node:test';
import { driverEventsPath, neighbours, scoreTone } from './driver-event-utils.ts';

test('scoreTone bands', () => {
  assert.deepEqual([100, 80, 79, 60, 59, 0].map(scoreTone), ['good', 'good', 'fair', 'fair', 'poor', 'poor']);
});

test('neighbours for prev / next navigation', () => {
  assert.deepEqual(neighbours(['a', 'b', 'c'], 'b'), { prev: 'a', next: 'c' });
  assert.deepEqual(neighbours(['a', 'b', 'c'], 'a'), { prev: null, next: 'b' });
  assert.deepEqual(neighbours(['a', 'b', 'c'], 'x'), { prev: null, next: null });
});

test('driverEventsPath', () => {
  assert.equal(driverEventsPath(), '/driver-events');
  assert.equal(driverEventsPath({ event: 'e1', objectId: 'o1' }), '/driver-events?objectId=o1&event=e1');
});
