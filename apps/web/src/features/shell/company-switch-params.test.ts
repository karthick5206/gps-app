import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withoutCompanyRecords } from './company-switch-params.ts';

test('drops record ids and keeps the period and filters', () => {
  const input = new URLSearchParams('objectId=a&driverId=b&alertId=c&from=2026-11-01&to=2026-11-02&status=OPEN&tab=trips');
  assert.equal(withoutCompanyRecords(input).toString(), 'from=2026-11-01&to=2026-11-02&status=OPEN&tab=trips');
});

test('does not change the params it was given', () => {
  const input = new URLSearchParams('objectId=a');
  withoutCompanyRecords(input);
  assert.equal(input.get('objectId'), 'a');
});
