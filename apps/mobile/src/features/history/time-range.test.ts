import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampDayRange, dayRange } from './time-range.ts';

test('custom range keeps any span up to 7 days as chosen', () => {
  assert.deepEqual(clampDayRange('2026-11-10', '2026-11-16', 'to'), { from: '2026-11-10', to: '2026-11-16' });
  assert.deepEqual(clampDayRange('2026-11-16', '2026-11-16', 'from'), { from: '2026-11-16', to: '2026-11-16' });
});

test('a longer span moves the other end so it stays 7 days', () => {
  // New "to" 10 days after "from": "from" follows to 6 days before.
  assert.deepEqual(clampDayRange('2026-11-01', '2026-11-11', 'to'), { from: '2026-11-05', to: '2026-11-11' });
  // New "from" far before "to": "to" follows to 6 days after.
  assert.deepEqual(clampDayRange('2026-10-20', '2026-11-11', 'from'), { from: '2026-10-20', to: '2026-10-26' });
  // Across a month end.
  assert.deepEqual(clampDayRange('2026-10-29', '2026-11-20', 'from'), { from: '2026-10-29', to: '2026-11-04' });
});

test('an end before the start becomes a single day', () => {
  assert.deepEqual(clampDayRange('2026-11-15', '2026-11-12', 'to'), { from: '2026-11-12', to: '2026-11-12' });
  assert.deepEqual(clampDayRange('2026-11-15', '2026-11-12', 'from'), { from: '2026-11-15', to: '2026-11-15' });
});

test('dayRange spans from the start of the first day to the end of the last', () => {
  const r = dayRange('2026-11-10', '2026-11-12');
  assert.equal(r.from.getHours(), 0);
  assert.equal(r.from.getDate(), 10);
  assert.equal(r.to.getDate(), 12);
  assert.equal(r.to.getHours(), 23);
  assert.equal(r.to.getMinutes(), 59);
});
