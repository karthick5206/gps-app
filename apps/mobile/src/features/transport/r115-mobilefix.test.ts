/// <reference types="node" />
/**
 * v1.15.0 QA fixes on the phone (r115-qa): B2 trip headers for point-to-point trips. Synthetic data only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POINT_TO_POINT_LABEL, tripKindLabel } from './labels.ts';

test('B2: a point-to-point trip (stored as IN) is headed "Point-to-point", not "To site (login)"', () => {
  assert.equal(tripKindLabel({ direction: 'IN', journey: 'POINT_TO_POINT' }), POINT_TO_POINT_LABEL);
  assert.equal(tripKindLabel({ direction: 'OUT', journey: 'POINT_TO_POINT' }), POINT_TO_POINT_LABEL);
});

test('B2: a commute trip, an older server without journey, or an unknown journey keeps the direction wording', () => {
  assert.equal(tripKindLabel({ direction: 'IN', journey: 'COMMUTE' }), 'To site (login)');
  assert.equal(tripKindLabel({ direction: 'OUT', journey: 'COMMUTE' }), 'From site (logout)');
  assert.equal(tripKindLabel({ direction: 'IN' }), 'To site (login)');
  assert.equal(tripKindLabel({ direction: 'OUT', journey: 'SOMETHING_NEW' }), 'From site (logout)');
});
