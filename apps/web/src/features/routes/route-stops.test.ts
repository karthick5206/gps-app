import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moveItem, positionsKey, stopNameFromPlace, suggestOffsets, validateStops, type RouteLimits, type StopDraft } from './route-stops.ts';

const LIMITS: RouteLimits = {
  minStops: 2,
  maxStops: 100,
  corridorMinM: 50,
  corridorMaxM: 2000,
  corridorDefaultM: 200,
  radiusMinM: 20,
  radiusMaxM: 2000,
  radiusDefaultM: 100,
  maxOffsetMin: 10_080,
  maxWaitMin: 1_440,
};

const stop = (over: Partial<StopDraft> = {}): StopDraft => ({ key: 'k', name: 'Stop', lat: 13.08, lng: 80.27, radiusM: 100, offsetMin: 0, waitMin: 0, ...over });

test('suggestOffsets matches the API formula', () => {
  assert.deepEqual(suggestOffsets([], []), [0]);
  // 600 s → 10 min, 61 s → 2 min (rounded up); waits are added before each leg.
  assert.deepEqual(suggestOffsets([600, 61], [5, 3, 0]), [0, 15, 20]);
  // Negative legs count as 0, missing waits as 0.
  assert.deepEqual(suggestOffsets([-30, 120], []), [0, 0, 2]);
});

test('validateStops accepts a valid route', () => {
  assert.deepEqual(validateStops([stop(), stop({ offsetMin: 10, waitMin: 2 }), stop({ offsetMin: 10 })], LIMITS), []);
});

test('validateStops needs at least two stops', () => {
  const issues = validateStops([stop()], LIMITS);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].index, null);
  assert.deepEqual(issues[0].vars, { n: 2 });
});

test('validateStops flags each bad field on its row', () => {
  const issues = validateStops(
    [stop({ offsetMin: 5 }), stop({ name: ' ', radiusM: 10, offsetMin: 20 }), stop({ offsetMin: 15, waitMin: 2000 }), stop({ lat: 95, offsetMin: Number.NaN })],
    LIMITS,
  );
  const fields = issues.map((i) => `${i.index}:${i.field}`);
  assert.deepEqual(fields, ['0:offsetMin', '1:name', '1:radiusM', '2:offsetMin', '2:waitMin', '3:position', '3:offsetMin']);
});

test('validateStops: offsets must not decrease, equal is fine', () => {
  assert.equal(validateStops([stop(), stop({ offsetMin: 30 }), stop({ offsetMin: 30 })], LIMITS).length, 0);
  const issues = validateStops([stop(), stop({ offsetMin: 30 }), stop({ offsetMin: 29 })], LIMITS);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].index, 2);
});

test('validateStops rejects fractional numbers like the API', () => {
  const issues = validateStops([stop(), stop({ radiusM: 100.5, offsetMin: 1.5 })], LIMITS);
  assert.deepEqual(
    issues.map((i) => i.field),
    ['radiusM', 'offsetMin'],
  );
});

test('moveItem moves up / down and ignores out-of-range moves', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c'], 1, -1), ['b', 'a', 'c']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 1, 1), ['a', 'c', 'b']);
  const same = ['a', 'b'];
  assert.equal(moveItem(same, 0, -1), same);
  assert.equal(moveItem(same, 1, 1), same);
});

test('positionsKey depends on positions only', () => {
  assert.equal(positionsKey([stop(), stop({ name: 'Other' })]), positionsKey([stop(), stop()]));
  assert.notEqual(positionsKey([stop(), stop()]), positionsKey([stop(), stop({ lat: 13.09 })]));
});

test('stopNameFromPlace keeps the first part of a label', () => {
  assert.equal(stopNameFromPlace('Chennai Central, Park Town, Chennai'), 'Chennai Central');
  assert.equal(stopNameFromPlace('  ,x'), ',x');
  assert.equal(stopNameFromPlace('a'.repeat(150)).length, 100);
});
