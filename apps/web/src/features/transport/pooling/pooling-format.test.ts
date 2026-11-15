import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_RIDE_PRIORITY, DEFAULT_SHARING_LIMITS, type TransportSharingPolicyDto } from '@veetracer/shared';
import {
  availabilityInputOf,
  canHold,
  canRelease,
  defaultPreference,
  driverHoursDraftOf,
  driverHoursInputOf,
  emptyPreferenceDraft,
  holdInput,
  limitsLines,
  liveSwitch,
  needsAcceptance,
  policyDraftOf,
  policyInputOf,
  poolingInput,
  preferenceChoices,
} from './pooling-format.ts';

const policy = (over: Partial<TransportSharingPolicyDto> = {}): TransportSharingPolicyDto => ({
  version: 3,
  effectiveFrom: '2026-11-01T00:00:00.000Z',
  text: 'Shared rides may pick up others on the way.',
  allowFlexible: true,
  limits: { SHARED: { ...DEFAULT_SHARING_LIMITS }, FLEXIBLE: { ...DEFAULT_SHARING_LIMITS, maxRideS: 3600 } },
  companyMaxRideS: 5400,
  priority: { ...DEFAULT_RIDE_PRIORITY },
  ...over,
});

test('P3 defaults and the FLEXIBLE switch', () => {
  assert.equal(defaultPreference('COMMUTE'), 'SHARED');
  assert.equal(defaultPreference('POINT_TO_POINT'), 'PRIVATE');
  assert.deepEqual(preferenceChoices(policy({ allowFlexible: false })), ['SHARED', 'PRIVATE']);
  assert.deepEqual(preferenceChoices(null), ['SHARED', 'PRIVATE', 'FLEXIBLE']);
  assert.equal(needsAcceptance('SHARED', 'POINT_TO_POINT'), true);
  assert.equal(needsAcceptance('SHARED', 'COMMUTE'), false);
  assert.equal(needsAcceptance('PRIVATE', 'POINT_TO_POINT'), false);
});

test('limits lines fall back to the company max ride', () => {
  assert.deepEqual(limitsLines(DEFAULT_SHARING_LIMITS, 5400), ['Max wait 15 min', 'Max detour 1.8× or +15 min', 'Max ride 90 min']);
  assert.equal(limitsLines(DEFAULT_SHARING_LIMITS, null)[2], 'No maximum ride time');
  assert.deepEqual(limitsLines(null, 5400), []);
});

test('poolingInput: nothing sent without a policy or a choice (server default)', () => {
  assert.deepEqual(poolingInput({ ...emptyPreferenceDraft(), preference: 'SHARED' }, null, 'POINT_TO_POINT'), { ok: true, value: {} });
  assert.deepEqual(poolingInput(emptyPreferenceDraft(), policy(), 'POINT_TO_POINT'), { ok: true, value: {} });
});

test('poolingInput: acceptance required for P2P shared, version sent', () => {
  const d = { ...emptyPreferenceDraft(), preference: 'SHARED' as const };
  const refused = poolingInput(d, policy(), 'POINT_TO_POINT');
  assert.equal(refused.ok, false);
  assert.deepEqual(poolingInput({ ...d, accepted: true }, policy(), 'POINT_TO_POINT'), { ok: true, value: { ridePreference: 'SHARED', acceptedPolicyVersion: 3 } });
  // Commute shared without acceptance is fine (no version sent).
  assert.deepEqual(poolingInput(d, policy(), 'COMMUTE'), { ok: true, value: { ridePreference: 'SHARED' } });
  assert.deepEqual(poolingInput({ ...d, preference: 'PRIVATE', accepted: true }, policy(), 'POINT_TO_POINT'), { ok: true, value: { ridePreference: 'PRIVATE' } });
});

test('poolingInput: tighter limits only, within bounds', () => {
  const d = { ...emptyPreferenceDraft(), preference: 'FLEXIBLE' as const, accepted: true };
  assert.deepEqual(poolingInput({ ...d, maxWaitMin: '10', maxRideMin: '45' }, policy(), 'POINT_TO_POINT'), { ok: true, value: { ridePreference: 'FLEXIBLE', acceptedPolicyVersion: 3, limits: { maxWaitS: 600, maxRideS: 2700 } } });
  assert.equal(poolingInput({ ...d, maxWaitMin: '20' }, policy(), 'POINT_TO_POINT').ok, false);
  assert.equal(poolingInput({ ...d, maxRideMin: '61' }, policy(), 'POINT_TO_POINT').ok, false);
  assert.equal(poolingInput({ ...d, maxRideMin: '4' }, policy(), 'POINT_TO_POINT').ok, false);
  assert.equal(poolingInput({ ...d, maxWaitMin: '1.5' }, policy(), 'POINT_TO_POINT').ok, false);
  assert.equal(poolingInput(d, policy({ allowFlexible: false }), 'POINT_TO_POINT').ok, false);
});

test('hold: only unseated bookings, reason required to hold', () => {
  assert.equal(canHold({ status: 'PENDING_ASSIGNMENT', holdFromPlanning: false }), true);
  assert.equal(canHold({ status: 'ASSIGNED', holdFromPlanning: false }), false);
  assert.equal(canHold({ status: 'PENDING_ASSIGNMENT', holdFromPlanning: true }), false);
  assert.equal(canRelease({ holdFromPlanning: true }), true);
  assert.equal(holdInput({ version: 4 }, true, '  ').ok, false);
  assert.deepEqual(holdInput({ version: 4 }, true, ' VIP later '), { ok: true, value: { hold: true, reason: 'VIP later', expectedVersion: 4 } });
  assert.deepEqual(holdInput({ version: 5 }, false), { ok: true, value: { hold: false, expectedVersion: 5 } });
});

test('sharing policy draft round-trips and validates', () => {
  const draft = policyDraftOf(policy());
  assert.equal(draft.SHARED.maxRideMin, '');
  assert.equal(draft.FLEXIBLE.maxRideMin, '60');
  const r = policyInputOf(draft);
  assert.ok(r.ok);
  assert.deepEqual(r.value.limits.FLEXIBLE, { maxWaitS: 900, maxDetour: { ratio: 1.8, extraS: 900 }, maxRideS: 3600 });
  assert.deepEqual(r.value.priority, { PRIVATE: 3, FLEXIBLE: 1.5, SHARED: 1 });
  const bad = policyInputOf({ ...draft, text: ' ', SHARED: { ...draft.SHARED, ratio: '4' } });
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.errors.length, 2);
});

test('driver hours: empty = no policy (P7), break pair enforced', () => {
  assert.deepEqual(driverHoursInputOf(driverHoursDraftOf(null)), { ok: true, value: null });
  const d = { ...driverHoursDraftOf(null), maxDutyS: '10', breakAfterS: '4.5', breakS: '30' };
  assert.deepEqual(driverHoursInputOf(d), { ok: true, value: { maxDutyS: 36000, maxDrivingS: null, breakAfterS: 16200, breakS: 1800, minRestS: null } });
  assert.equal(driverHoursInputOf({ ...d, breakS: '' }).ok, false);
  assert.equal(driverHoursDraftOf({ maxDutyS: 36000, maxDrivingS: null, breakAfterS: 16200, breakS: 1800, minRestS: null }).breakAfterS, '4.5');
});

test('live switch: server kill switch wins', () => {
  assert.equal(liveSwitch({ liveDispatch: true, killSwitch: true }), 'off-server');
  assert.equal(liveSwitch({ liveDispatch: false, killSwitch: false }), 'off');
  assert.equal(liveSwitch({ liveDispatch: true, killSwitch: false }), 'on');
  assert.equal(liveSwitch(undefined), 'off');
});

test('availability rows map to the PUT body', () => {
  const fromWall = (w: string) => Date.parse(`${w}:00Z`);
  const ok = availabilityInputOf({ turnaroundMin: '5', rows: [{ key: 'a', kind: 'DOWNTIME', start: '2026-11-20T08:00', end: '2026-11-20T12:00', reason: ' service ' }] }, fromWall, '2026-11-15T00:00:00.000Z');
  assert.deepEqual(ok, { ok: true, value: { turnaroundS: 300, from: '2026-11-15T00:00:00.000Z', windows: [{ kind: 'DOWNTIME', startsAt: '2026-11-20T08:00:00.000Z', endsAt: '2026-11-20T12:00:00.000Z', reason: 'service' }] } });
  const bad = availabilityInputOf({ turnaroundMin: '', rows: [{ key: 'a', kind: 'OPERATING', start: '2026-11-20T12:00', end: '2026-11-20T08:00', reason: '' }] }, fromWall, '2026-11-15T00:00:00.000Z');
  assert.equal(bad.ok, false);
});

test('pooling strings have hi and ta with the same placeholders', async () => {
  const { TRANSLATIONS } = await import('@veetracer/shared');
  const keys = ['Ride preference', 'Max wait {{n}} min', 'Publishes as {{n}} trips', 'Live dispatch', 'Driver has not acknowledged the last route update', 'The route was just updated: times may change.'];
  const ph = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join(',');
  for (const k of keys) for (const lang of ['hi', 'ta'] as const) {
    assert.ok(TRANSLATIONS[lang][k], `${lang} ${k}`);
    assert.equal(ph(TRANSLATIONS[lang][k]), ph(k));
  }
});
