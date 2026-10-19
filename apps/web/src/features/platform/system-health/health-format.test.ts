import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactNumber, formatBytes, fraction, niceMax, overallLabel, statusVariant } from './health-format.ts';

test('formatBytes', () => {
  assert.equal(formatBytes(null), '—');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(410_044_576), '391 MB');
  assert.equal(formatBytes(245_107_195_904), '228 GB');
});

test('compactNumber and niceMax', () => {
  assert.equal(compactNumber(950), '950');
  assert.equal(compactNumber(1500), '1.5k');
  assert.equal(compactNumber(12_345), '12k');
  assert.equal(compactNumber(2_000_000), '2M');
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(37), 50);
  assert.equal(niceMax(1200), 2000);
});

test('fraction, status variants and labels', () => {
  assert.equal(fraction(5, 10), 0.5);
  assert.equal(fraction(20, 10), 1);
  assert.equal(fraction(5, 0), null);
  assert.equal(statusVariant('WARN'), 'warning');
  assert.equal(statusVariant('CRITICAL'), 'destructive');
  assert.equal(overallLabel('OK'), 'Healthy');
  assert.equal(overallLabel('WARN'), 'Degraded');
});
