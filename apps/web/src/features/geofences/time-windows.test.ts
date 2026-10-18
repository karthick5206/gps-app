import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDays, formatWindow, formatWindows, inWindow, validateWindow } from './time-windows.ts';

test('formatDays collapses runs and names common sets', () => {
  assert.equal(formatDays([1, 2, 3, 4, 5]), 'Weekdays');
  assert.equal(formatDays([6, 7]), 'Weekends');
  assert.equal(formatDays([7, 1, 2, 3, 4, 5, 6]), 'Every day');
  assert.equal(formatDays([1, 2, 3]), 'Mon–Wed');
  assert.equal(formatDays([1, 3, 5]), 'Mon, Wed, Fri');
  assert.equal(formatDays([1, 2, 4, 5, 6]), 'Mon, Tue, Thu–Sat');
  assert.equal(formatDays([]), 'No days');
  assert.equal(formatDays([2, 2, 3]), 'Tue, Wed');
});

test('formatWindow marks overnight and all-day windows', () => {
  assert.equal(formatWindow({ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }), 'Weekdays 08:00–18:00');
  assert.equal(formatWindow({ days: [1, 2, 3, 4, 5, 6, 7], from: '22:00', to: '06:00' }), 'Every day 22:00–06:00 (overnight)');
  assert.equal(formatWindow({ days: [6], from: '00:00', to: '00:00' }), 'Sat, all day');
  assert.equal(formatWindows([]), 'Always active');
});

test('inWindow handles overnight windows belonging to the start day', () => {
  const w = { days: [1], from: '22:00', to: '06:00' }; // Monday night
  assert.equal(inWindow(w, 1, 23 * 60), true);
  assert.equal(inWindow(w, 2, 3 * 60), true);
  assert.equal(inWindow(w, 2, 7 * 60), false);
  assert.equal(inWindow(w, 1, 3 * 60), false);
  const day = { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' };
  assert.equal(inWindow(day, 3, 8 * 60), true);
  assert.equal(inWindow(day, 3, 18 * 60), false);
  assert.equal(inWindow(day, 6, 9 * 60), false);
});

test('validateWindow', () => {
  assert.equal(validateWindow({ days: [1], from: '08:00', to: '09:00' }), null);
  assert.match(validateWindow({ days: [], from: '08:00', to: '09:00' })!, /day/);
  assert.match(validateWindow({ days: [1], from: '8:00', to: '09:00' })!, /HH:mm/);
  assert.match(validateWindow({ days: [1], from: '24:00', to: '09:00' })!, /HH:mm/);
});
