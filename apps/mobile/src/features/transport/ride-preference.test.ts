/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TransportSharingPolicyDto } from '@veetracer/shared';
import { defaultPreference, limitLines, needsAcceptance, poolingErrorText, poolingFields, preferenceChoices, servedText } from './ride-preference.ts';

const limits = { maxWaitS: 900, maxDetour: { ratio: 1.8, extraS: 900 }, maxRideS: null };
const policy: TransportSharingPolicyDto = { version: 2, effectiveFrom: null, text: 'Be ready at the pickup.', allowFlexible: true, limits: { SHARED: limits, FLEXIBLE: limits }, companyMaxRideS: 3600, priority: { PRIVATE: 3, FLEXIBLE: 1.5, SHARED: 1 } };

test('defaults and choices follow the policy (P3)', () => {
  assert.equal(defaultPreference('COMMUTE'), 'SHARED');
  assert.equal(defaultPreference('POINT_TO_POINT'), 'PRIVATE');
  assert.deepEqual(preferenceChoices({ allowFlexible: false }), ['SHARED', 'PRIVATE']);
  assert.equal(needsAcceptance('FLEXIBLE', 'POINT_TO_POINT'), true);
  assert.equal(needsAcceptance('SHARED', 'COMMUTE'), false);
});

test('explicit acceptance sends the policy version', () => {
  assert.equal(poolingFields('SHARED', false, policy, 'POINT_TO_POINT').ok, false);
  assert.deepEqual(poolingFields('SHARED', true, policy, 'POINT_TO_POINT'), { ok: true, value: { ridePreference: 'SHARED', acceptedPolicyVersion: 2 } });
  assert.deepEqual(poolingFields('PRIVATE', true, policy, 'POINT_TO_POINT'), { ok: true, value: { ridePreference: 'PRIVATE' } });
  assert.deepEqual(poolingFields(null, false, policy, 'COMMUTE'), { ok: true, value: { ridePreference: 'SHARED' } });
  assert.deepEqual(poolingFields('SHARED', true, null, 'POINT_TO_POINT'), { ok: true, value: {} });
  assert.equal(poolingFields('FLEXIBLE', true, { ...policy, allowFlexible: false }, 'POINT_TO_POINT').ok, false);
});

test('limit lines use the company max ride when the policy has none', () => {
  assert.deepEqual(limitLines(limits, 3600).map((l) => l.vars.n), [15, 15, 60]);
  assert.equal(limitLines(limits, null).length, 2);
  assert.deepEqual(limitLines(null, 3600), []);
});

test('error and served texts', () => {
  assert.match(poolingErrorText('POLICY_VERSION_STALE') ?? '', /changed/);
  assert.equal(poolingErrorText('OTHER'), null);
  assert.equal(servedText('PRIVATE'), 'Private ride');
  assert.equal(servedText(null), null);
});
