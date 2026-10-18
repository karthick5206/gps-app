import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration, relativeTime, timeInStatus } from './format.ts';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

test('formatDuration picks compact units', () => {
  assert.equal(formatDuration(42), '42 s');
  assert.equal(formatDuration(12 * 60 + 5), '12 min');
  assert.equal(formatDuration(3 * 3600), '3 h');
  assert.equal(formatDuration(3 * 3600 + 5 * 60), '3 h 5 min');
  assert.equal(formatDuration(2 * 86400 + 4 * 3600), '2 d 4 h');
  assert.equal(formatDuration(-5), '0 s');
});

test('timeInStatus renders "Idle 12 min" style labels', () => {
  assert.equal(timeInStatus('Idle', ago(12 * 60), NOW), 'Idle 12 min');
  assert.equal(timeInStatus('Running', null, NOW), null);
  assert.equal(timeInStatus('Off', 'not-a-date', NOW), null);
});

test('relativeTime is coarse and human friendly', () => {
  assert.equal(relativeTime(ago(2), NOW), 'just now');
  assert.equal(relativeTime(ago(-3), NOW), 'just now');
  assert.equal(relativeTime(ago(30), NOW), '30 s ago');
  assert.equal(relativeTime(ago(3 * 60), NOW), '3 min ago');
  assert.equal(relativeTime(ago(2 * 3600 + 600), NOW), '2 h ago');
  assert.equal(relativeTime(ago(4 * 86400 + 3600), NOW), '4 d ago');
  assert.equal(relativeTime(null, NOW), '—');
});
