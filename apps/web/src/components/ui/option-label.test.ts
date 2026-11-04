import assert from 'node:assert/strict';
import { test } from 'node:test';
import { optionLabel } from './option-label.ts';

const ID = 'e8f2e5dc-0226-4a87-bdae-70dd00f07e7f';

test('uses the known label', () => {
  assert.equal(optionLabel('TN 01 AB 1234', ID, 'Selected item'), 'TN 01 AB 1234');
});

test('never shows a raw id', () => {
  assert.equal(optionLabel(undefined, ID, 'Selected item'), 'Selected item');
  assert.equal(optionLabel(undefined, ID.toUpperCase(), 'Selected item'), 'Selected item');
});

test('keeps values that are readable text', () => {
  assert.equal(optionLabel(undefined, 'OVERSPEED', 'Selected item'), 'OVERSPEED');
});
