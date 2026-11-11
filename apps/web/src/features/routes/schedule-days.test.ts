import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanDays, formatDays, minutesToTime, timeToMinutes, toggleDay, WEEK_DISPLAY_ORDER, weekdayNames } from './schedule-days.ts';

const words = { names: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], everyDay: 'Every day', weekdays: 'Weekdays', weekends: 'Weekends' };

test('display order is Monday first, values stay Sunday = 0', () => {
  assert.deepEqual([...WEEK_DISPLAY_ORDER], [1, 2, 3, 4, 5, 6, 0]);
});

test('formatDays special cases', () => {
  assert.equal(formatDays([], words), '—');
  assert.equal(formatDays([0, 1, 2, 3, 4, 5, 6], words), 'Every day');
  assert.equal(formatDays([5, 1, 2, 3, 4], words), 'Weekdays');
  assert.equal(formatDays([0, 6], words), 'Weekends');
});

test('formatDays runs and lists in Monday-first order', () => {
  assert.equal(formatDays([1, 2, 3], words), 'Mon–Wed');
  assert.equal(formatDays([1, 3, 5], words), 'Mon, Wed, Fri');
  assert.equal(formatDays([0, 1], words), 'Mon, Sun');
  assert.equal(formatDays([4, 5, 6, 0], words), 'Thu–Sun');
  assert.equal(formatDays([1, 2, 4, 5, 6], words), 'Mon, Tue, Thu–Sat');
  assert.equal(formatDays([1, 1, 2, 9], words), 'Mon, Tue');
});

test('toggleDay and cleanDays', () => {
  assert.deepEqual(toggleDay([1, 3], 2), [1, 2, 3]);
  assert.deepEqual(toggleDay([1, 3], 3), [1]);
  assert.deepEqual(cleanDays([6, 0, 6, 7, -1, 2.5]), [0, 6]);
});

test('minutesToTime / timeToMinutes', () => {
  assert.equal(minutesToTime(0), '00:00');
  assert.equal(minutesToTime(540), '09:00');
  assert.equal(minutesToTime(1439), '23:59');
  assert.equal(timeToMinutes('09:05'), 545);
  assert.equal(timeToMinutes('7:30'), 450);
  assert.equal(timeToMinutes('24:00'), null);
  assert.equal(timeToMinutes('12:60'), null);
  assert.equal(timeToMinutes(''), null);
});

test('weekdayNames starts on Sunday', () => {
  const en = weekdayNames('en');
  assert.equal(en.length, 7);
  assert.equal(en[0], 'Sun');
  assert.equal(en[1], 'Mon');
});
