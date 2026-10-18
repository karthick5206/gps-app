import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectPreset, fromLocalInput, presetRange, rangeFromParams, toLocalInput, validateRange } from './time-range.ts';

const NOW = new Date(2026, 9, 18, 14, 30); // local time

test('presets', () => {
  const today = presetRange('today', NOW);
  assert.equal(toLocalInput(today.from), '2026-10-18T00:00');
  assert.equal(toLocalInput(today.to), '2026-10-18T23:59');
  const y = presetRange('yesterday', NOW);
  assert.equal(toLocalInput(y.from), '2026-10-17T00:00');
  const w = presetRange('last7', NOW);
  assert.equal(toLocalInput(w.from), '2026-10-12T00:00');
  assert.equal(detectPreset(w, NOW), 'last7');
  assert.equal(detectPreset({ from: NOW, to: new Date(NOW.getTime() + 3600_000) }, NOW), 'custom');
});

test('local input round trip and validation', () => {
  const d = fromLocalInput('2026-10-18T08:05');
  assert.ok(d);
  assert.equal(toLocalInput(d!), '2026-10-18T08:05');
  assert.equal(fromLocalInput('nope'), null);
  assert.equal(validateRange({ from: NOW, to: NOW }), 'End must be after start');
  assert.match(validateRange({ from: new Date(2026, 0, 1), to: new Date(2026, 2, 1) }) ?? '', /31 days/);
  assert.equal(validateRange(presetRange('today', NOW)), null);
});

test('deep-link params fall back to today', () => {
  const ok = rangeFromParams(new URLSearchParams('from=2026-10-17T00:00:00.000Z&to=2026-10-17T12:00:00.000Z'), NOW);
  assert.equal(ok.from.toISOString(), '2026-10-17T00:00:00.000Z');
  const bad = rangeFromParams(new URLSearchParams('from=x'), NOW);
  assert.equal(detectPreset(bad, NOW), 'today');
});
