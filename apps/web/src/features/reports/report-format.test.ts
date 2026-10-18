import assert from 'node:assert/strict';
import { test } from 'node:test';
import { daySpan, formatHm, isEmail, isoWeekMonday, periodLabel, periodShortLabel, splitRecipients } from './report-format.ts';

test('formatHm renders hh:mm with hours beyond 24', () => {
  assert.equal(formatHm(0), '00:00');
  assert.equal(formatHm(59), '00:01');
  assert.equal(formatHm(29), '00:00');
  assert.equal(formatHm(3600 + 5 * 60), '01:05');
  assert.equal(formatHm(49 * 3600 + 5 * 60), '49:05');
  assert.equal(formatHm(-10), '00:00');
  assert.equal(formatHm(null), '—');
  assert.equal(formatHm(Number.NaN), '—');
});

test('ISO week Monday', () => {
  assert.equal(isoWeekMonday(2026, 1).toISOString().slice(0, 10), '2025-12-29');
  assert.equal(isoWeekMonday(2026, 42).toISOString().slice(0, 10), '2026-10-12');
  assert.equal(isoWeekMonday(2021, 1).toISOString().slice(0, 10), '2021-01-04');
});

test('period labels', () => {
  assert.equal(periodLabel('2026-10-18'), '18 Oct 2026');
  assert.equal(periodLabel('2026-W42'), 'Week 42 · 12–18 Oct 2026');
  assert.equal(periodLabel('2026-W01'), 'Week 1 · 29 Dec – 4 Jan 2026');
  assert.equal(periodLabel('2026-10'), 'Oct 2026');
  assert.equal(periodLabel('whatever'), 'whatever');
  assert.equal(periodShortLabel('2026-10-18'), '18 Oct');
  assert.equal(periodShortLabel('2026-W42'), 'W42');
  assert.equal(periodShortLabel('2026-10'), 'Oct 26');
});

test('day span', () => {
  assert.equal(daySpan('2026-10-01', '2026-10-31'), 31);
  assert.equal(daySpan('2026-10-18', '2026-10-18'), 1);
});

test('recipient parsing validates and de-duplicates', () => {
  assert.ok(isEmail('a.b@example.com'));
  assert.ok(!isEmail('a@b'));
  assert.ok(!isEmail('no spaces@x.com'));
  const r = splitRecipients('Ops@Example.com, bad; x@y.in ops@example.com', ['x@y.in']);
  assert.deepEqual(r.added, ['ops@example.com']);
  assert.deepEqual(r.invalid, ['bad']);
});
