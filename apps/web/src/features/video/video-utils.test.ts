import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alertWindow, formatBytes, gridColumns, isAlarmRecording, playbackRange, videoPagePath } from './video-utils.ts';

test('alertWindow spans ±2 minutes', () => {
  const w = alertWindow('2026-10-19T05:00:00Z');
  assert.equal(w.from.toISOString(), '2026-10-19T04:58:00.000Z');
  assert.equal(w.to.toISOString(), '2026-10-19T05:02:00.000Z');
});

test('gridColumns', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 8, 9, 12].map(gridColumns), [1, 2, 2, 2, 3, 3, 3, 4]);
});

test('formatBytes and alarm flags', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(isAlarmRecording('0000000000000000'), false);
  assert.equal(isAlarmRecording('0000000000000004'), true);
});

test('playbackRange clamps to the alert window', () => {
  const rec = { start: '2026-10-19T04:50:00Z', end: '2026-10-19T05:10:00Z' };
  assert.deepEqual(playbackRange(rec, alertWindow('2026-10-19T05:00:00Z')), { start: '2026-10-19T04:58:00.000Z', end: '2026-10-19T05:02:00.000Z' });
  assert.deepEqual(playbackRange(rec), { start: '2026-10-19T04:50:00.000Z', end: '2026-10-19T05:10:00.000Z' });
  assert.equal(playbackRange({ start: null, end: null }), null);
  assert.equal(playbackRange(rec, alertWindow('2026-10-19T06:00:00Z')), null);
});

test('videoPagePath', () => {
  assert.equal(videoPagePath('abc', { channel: 2, at: '2026-10-19T05:00:00Z' }), '/video?objectId=abc&channel=2&at=2026-10-19T05%3A00%3A00Z');
});
