import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  alertWindow,
  formatBytes,
  frameFileName,
  gridColumns,
  isAlarmRecording,
  playbackRange,
  recordingAt,
  shiftWindow,
  timelineSpans,
  videoPagePath,
} from './video-utils.ts';

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

test('frameFileName keeps safe characters and the clock', () => {
  assert.equal(frameFileName('TN 01 AB 1234', '2026-11-24T08:05:30.000Z'), 'TN_01_AB_1234_2026-11-24_08-05-30.png');
  assert.equal(frameFileName(' / ', '2026-11-24T08:05:30.000Z'), 'video_2026-11-24_08-05-30.png');
});

test('shiftWindow moves the playback window by whole minutes', () => {
  assert.deepEqual(shiftWindow('2026-11-24T08:00:00.000Z', 1), { start: '2026-11-24T08:01:00.000Z', end: '2026-11-24T08:06:00.000Z' });
  assert.deepEqual(shiftWindow('2026-11-24T08:00:00.000Z', -1, 2), { start: '2026-11-24T07:59:00.000Z', end: '2026-11-24T08:01:00.000Z' });
});

test('timelineSpans merges back-to-back files per camera and clips to the window', () => {
  const from = new Date('2026-11-24T08:00:00Z');
  const to = new Date('2026-11-24T09:00:00Z');
  const recs = [
    { channel: 1, start: '2026-11-24T08:00:00Z', end: '2026-11-24T08:01:00Z', alarmFlags: '0' },
    { channel: 1, start: '2026-11-24T08:01:02Z', end: '2026-11-24T08:02:00Z', alarmFlags: '0' },
    { channel: 1, start: '2026-11-24T08:30:00Z', end: '2026-11-24T08:31:00Z', alarmFlags: '0' },
    { channel: 2, start: '2026-11-24T07:59:00Z', end: '2026-11-24T08:06:00Z', alarmFlags: '0' },
  ];
  const spans = timelineSpans(recs, from, to);
  assert.equal(spans.length, 3);
  assert.deepEqual(
    spans.map((s) => [s.channel, Math.round(s.left * 60), Math.round(s.width * 60)]),
    [
      [1, 0, 2],
      [1, 30, 1],
      [2, 0, 6],
    ],
  );
});

test('recordingAt picks the covering file, else the next one', () => {
  const recs = [
    { channel: 1, start: '2026-11-24T08:00:00Z', end: '2026-11-24T08:01:00Z' },
    { channel: 1, start: '2026-11-24T08:05:00Z', end: '2026-11-24T08:06:00Z' },
    { channel: 2, start: '2026-11-24T08:00:30Z', end: '2026-11-24T08:01:30Z' },
  ];
  assert.equal(recordingAt(recs, 1, Date.parse('2026-11-24T08:00:40Z'))?.start, '2026-11-24T08:00:00Z');
  assert.equal(recordingAt(recs, 1, Date.parse('2026-11-24T08:02:00Z'))?.start, '2026-11-24T08:05:00Z');
  assert.equal(recordingAt(recs, 2, Date.parse('2026-11-24T08:02:00Z')), null);
});
