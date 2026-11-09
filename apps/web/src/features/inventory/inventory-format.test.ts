import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chartMax, daysLeft, formatRupees, parseImeiList, percent, renewalText, rupeesToPaise, shortDay } from './inventory-format.ts';

test('formatRupees', () => {
  assert.equal(formatRupees(null), '—');
  assert.equal(formatRupees(149900), '₹1,499.00');
  assert.equal(formatRupees(0), '₹0.00');
  assert.equal(formatRupees(12_345_678_900, { compact: true }), '₹12.35 Cr');
  assert.equal(formatRupees(25_000_000, { compact: true }), '₹2.50 L');
  assert.equal(formatRupees(149900, { compact: true }), '₹1,499.00');
});

test('rupeesToPaise', () => {
  assert.equal(rupeesToPaise(''), null);
  assert.equal(rupeesToPaise('1,499.5'), 149950);
  assert.equal(rupeesToPaise('₹ 2499'), 249900);
  assert.ok(Number.isNaN(rupeesToPaise('12.345')));
  assert.ok(Number.isNaN(rupeesToPaise('abc')));
});

test('parseImeiList', () => {
  const r = parseImeiList('864000000000001\n864000000000002, 864000000000001;bad id\t86400000000000X');
  assert.deepEqual(r.imeis, ['864000000000001', '864000000000002', '86400000000000X']);
  assert.deepEqual(r.duplicates, ['864000000000001']);
  assert.deepEqual(r.invalid, ['bad', 'id']);
  assert.deepEqual(parseImeiList('a!b 12').invalid, ['a!b', '12']);
  assert.deepEqual(parseImeiList('   ').imeis, []);
});

test('chartMax', () => {
  assert.equal(chartMax([]), 1);
  assert.equal(chartMax([0, 1]), 1);
  assert.equal(chartMax([3]), 5);
  assert.equal(chartMax([12]), 20);
  assert.equal(chartMax([100]), 100);
  assert.equal(chartMax([730]), 1000);
});

test('shortDay / percent', () => {
  assert.equal(shortDay('2026-11-09'), '9 Nov');
  assert.equal(shortDay('nope'), 'nope');
  assert.equal(percent(1, 3), '33%');
  assert.equal(percent(1, 0), '0%');
});

test('daysLeft / renewalText', () => {
  const now = new Date('2026-11-09T22:00:00Z');
  assert.equal(daysLeft('2026-11-14', now), 5);
  assert.equal(daysLeft('2026-11-09', now), 0);
  assert.equal(daysLeft(null, now), null);
  assert.equal(renewalText(5), 'in 5 days');
  assert.equal(renewalText(1), 'in 1 day');
  assert.equal(renewalText(0), 'today');
  assert.equal(renewalText(-3), '3 days overdue');
  assert.equal(renewalText(null), '—');
});
