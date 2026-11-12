/**
 * Owner decisions on the E4 route-optimisation patch (2026-11-11), web side. Pure helpers and request shapes:
 * - Decision 1: company max-ride policy (transport settings) and an authorised per-plan override with a mandatory
 *   reason in the optimise / re-optimise dialogs (shown only when capabilities say the caller may override); the plan
 *   detail says which max ride the last optimisation used and where it came from.
 * - Decision 2: at most 75 bookings per plan; the limit comes from GET /routing/capabilities (limits.planBookings).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TRANSLATIONS, type RoutingCapabilities, type RoutingJobDto } from '@veetracer/shared';
import * as maxRide from './max-ride.ts';
import { optimizeOptions, reoptimise, startOptimise } from './planner-flow.ts';
import type { PlannerClient } from './planner-api.ts';
import { overrideReasonValid, plannerErrorText } from './planner-format.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(HERE, p), 'utf8');
const W = { vehicle: 7_200, distance: 0, time: 1, routeDuration: 0 };
const english = (k: string, o?: Record<string, unknown>) => k.replace(/\{\{(\w+)\}\}/g, (_m, n: string) => String(o?.[n] ?? ''));

test('D1: minutes ↔ seconds within the policy bounds (15 min – 4 h); empty = no limit', () => {
  assert.deepEqual(maxRide.parseMaxRideMinutes('90'), { ok: true, seconds: 5_400 });
  assert.deepEqual(maxRide.parseMaxRideMinutes(' 15 '), { ok: true, seconds: 900 });
  assert.deepEqual(maxRide.parseMaxRideMinutes(''), { ok: true, seconds: null });
  for (const bad of ['10', '241', '90.5', 'abc', '-30']) assert.equal(maxRide.parseMaxRideMinutes(bad).ok, false, bad);
  assert.equal(maxRide.minutesText(5_400), '90');
  assert.equal(maxRide.minutesText(null), '');
});

test('D1: override request: nothing sent unless changed; reason mandatory; turning it off clears an existing override', () => {
  const current = { maxRideS: 5_400, reason: 'Flood diversion', setById: 'u1', setAt: '2026-11-11T10:00:00Z' };
  assert.deepEqual(maxRide.overrideRequest({ enabled: false, minutes: '', reason: '' }, null), { ok: true, value: undefined });
  assert.deepEqual(maxRide.overrideRequest({ enabled: false, minutes: '90', reason: 'x' }, current), { ok: true, value: null });
  assert.deepEqual(maxRide.overrideRequest({ enabled: true, minutes: '90', reason: ' Flood diversion ' }, current), { ok: true, value: undefined });
  assert.deepEqual(maxRide.overrideRequest({ enabled: true, minutes: '120', reason: ' Flood diversion ' }, current), { ok: true, value: { maxRideS: 7_200, reason: 'Flood diversion' } });
  assert.deepEqual(maxRide.overrideRequest({ enabled: true, minutes: '120', reason: '  ' }, null), { ok: false, errors: ['Give a reason for the override: at least 15 characters, in words.'] });
  assert.deepEqual(maxRide.overrideRequest({ enabled: true, minutes: '', reason: 'Long loop for the night shift' }, null), { ok: false, errors: ['Enter the maximum ride time in minutes (15–240).'] });
  // The dialog starts from the plan's own override.
  assert.deepEqual(maxRide.overrideDraftOf({ maxRide: { appliedS: 5_400, appliedSource: 'override', policyS: 3_600, override: current } }), { enabled: true, minutes: '90', reason: 'Flood diversion' });
  assert.deepEqual(maxRide.overrideDraftOf({}), { enabled: false, minutes: '', reason: '' });
});

test('D1: only callers the capabilities authorise see the override; the policy is shown to everyone who plans', () => {
  const caps = (access: Record<string, unknown>) => ({ access: { scope: 'COMPANY', ...access }, limits: { planBookings: 75 } }) as unknown as RoutingCapabilities;
  assert.equal(maxRide.canOverrideMaxRide(caps({ canOverrideMaxRide: true })), true);
  assert.equal(maxRide.canOverrideMaxRide(caps({ canOverrideMaxRide: false })), false);
  assert.equal(maxRide.canOverrideMaxRide(undefined), false);
  assert.equal(maxRide.policyLabel(caps({ maxRidePolicyS: 3_600 }), english), 'Company maximum ride time: 1 h 00 min');
  assert.equal(maxRide.policyLabel(caps({ maxRidePolicyS: null }), english), 'Company maximum ride time: no limit');
});

test('D1: the plan detail says which max ride the last optimisation used and why', () => {
  const o = { maxRideS: 5_400, reason: 'Flood diversion', setById: 'u1', setAt: '2026-11-11T10:00:00Z' };
  assert.equal(maxRide.maxRideSummary({ appliedS: 5_400, appliedSource: 'override', policyS: 3_600, override: o }, english), '1 h 30 min · override: Flood diversion');
  assert.equal(maxRide.maxRideSummary({ appliedS: 3_600, appliedSource: 'policy', policyS: 3_600, override: null }, english), '1 h 00 min · company policy');
  assert.equal(maxRide.maxRideSummary({ appliedS: null, appliedSource: 'none', policyS: null, override: null }, english), 'No limit');
  assert.equal(maxRide.maxRideSummary({ appliedS: null, appliedSource: null, policyS: 3_600, override: null }, english), 'Not optimised yet');
  assert.equal(maxRide.maxRideSummary({ appliedS: null, appliedSource: null, policyS: 3_600, override: o }, english), 'Not optimised yet · override set: 1 h 30 min');
  assert.equal(maxRide.maxRideSummary(undefined, english), 'Not optimised yet');
});

test('D1: optimise and re-optimise send the override only when there is one (OptimizeOptionsDto.maxRideOverride)', async () => {
  assert.deepEqual(optimizeOptions({ version: 2 }, { weights: W, timeLimitS: 30 }), { expectedVersion: 2, timeLimitS: 30, objective: 'duration', weights: W });
  const sent: unknown[] = [];
  const c = {
    createPlan: async () => ({ id: 'plan-1', version: 1, emptyReason: null }),
    optimize: async (b: unknown) => (sent.push(b), { jobId: 'j1' } as RoutingJobDto),
    optimizePlan: async (_id: string, b: unknown) => (sent.push(b), { jobId: 'j2' } as RoutingJobDto),
  } as unknown as PlannerClient;
  const override = { maxRideS: 5_400, reason: 'Flood diversion' };
  await startOptimise(c, { planDate: '2026-12-04', direction: 'IN', seeds: [{ shiftId: 's1', name: 'A', sitePoiId: 'site-1' } as never], objectIds: ['v1'], weights: W, timeLimitS: 30, maxRideOverride: override } as never, () => 'k');
  await reoptimise(c, { id: 'plan-1', version: 3 }, { weights: W, timeLimitS: 30, maxRideOverride: null } as never, () => 'k');
  await reoptimise(c, { id: 'plan-1', version: 4 }, { weights: W, timeLimitS: 30 }, () => 'k');
  assert.deepEqual(sent[0], { planId: 'plan-1', expectedVersion: 1, timeLimitS: 30, objective: 'duration', weights: W, maxRideOverride: override });
  assert.deepEqual(sent[1], { expectedVersion: 3, timeLimitS: 30, objective: 'duration', weights: W, maxRideOverride: null });
  assert.equal('maxRideOverride' in (sent[2] as object), false);
});

test('D1: the screens wire it (settings field, both optimise dialogs, plan detail) and every new string has hi / ta', () => {
  assert.match(readFileSync(join(HERE, '../TransportSettingsPage.tsx'), 'utf8'), /MaxRidePolicy/);
  assert.match(read('OptimisePanel.tsx'), /MaxRideOverrideFields/);
  assert.match(read('PlanReviewPage.tsx'), /MaxRideOverrideFields/);
  assert.match(read('PlanReviewPage.tsx'), /maxRideSummary\(/);
  const missing = (lang: 'hi' | 'ta') => maxRide.MAX_RIDE_STRINGS.filter((k) => !TRANSLATIONS[lang][k]);
  assert.deepEqual(missing('hi'), []);
  assert.deepEqual(missing('ta'), []);
  assert.ok(maxRide.MAX_RIDE_STRINGS.length >= 10);
});

test('D2: the plan size limit comes from capabilities (75) and LIMIT_EXCEEDED speaks of bookings', () => {
  assert.equal(maxRide.planBookingsLimit({ limits: { planBookings: 75 } } as unknown as RoutingCapabilities), 75);
  assert.equal(maxRide.planBookingsLimit(undefined), 75);
  assert.match(plannerErrorText('LIMIT_EXCEEDED') ?? '', /bookings/);
  assert.match(read('OptimisePanel.tsx'), /planBookingsLimit\(/);
  for (const lang of ['hi', 'ta'] as const) assert.ok(TRANSLATIONS[lang][plannerErrorText('LIMIT_EXCEEDED')!], `${lang} LIMIT_EXCEEDED`);
});

test('E4 decisions D-L4: the max-ride override reason follows the publish override rule (one shared validator)', () => {
  const msg = 'Give a reason for the override: at least 15 characters, in words.';
  for (const reason of ['abc', 'Short one', 'aaaaaaaaaaaaaaaaaaaa', '1234567890 1234567890']) {
    assert.deepEqual(maxRide.overrideRequest({ enabled: true, minutes: '90', reason }, null), { ok: false, errors: [msg] }, reason);
  }
  for (const reason of ['Flood diversion', 'शिफ्ट देर से शुरू होगी आज', 'மழை காரணமாக மாற்றுப் பாதை']) {
    assert.equal(maxRide.overrideRequest({ enabled: true, minutes: '90', reason }, null).ok, true, reason);
  }
  for (const r of ['abc', 'Short one', 'Flood diversion', 'शिफ्ट देर से शुरू होगी आज']) assert.equal(maxRide.maxRideReasonValid(r), overrideReasonValid(r), r);
  for (const lang of ['hi', 'ta'] as const) assert.ok(TRANSLATIONS[lang][msg], `${lang}: ${msg}`);
  assert.doesNotMatch(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'MaxRideFields.tsx'), 'utf8'), /reason\.trim\(\)\.length < 3/);
});
