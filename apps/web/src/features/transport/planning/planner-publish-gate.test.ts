/**
 * Owner decision 5 (publishing), web side: the publish dialog follows the server's classification (plan.publishCheck):
 * hard violations block Publish (only an authorised user may override, with a reason), soft warnings need the
 * acknowledgement, and the request carries the acknowledged warning fingerprint / the override (PublishDto fields).
 * Pure helpers plus source guards (no DOM harness).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TRANSLATIONS, type RoutePlanPublishCheck } from '@veetracer/shared';
import { createKeyStore, publishPlan } from './planner-flow.ts';
import { createMockPlannerClient } from './planner-mock.ts';
import { plannerErrorKind, plannerErrorText, publishGate, publishGateState, type PlannerPlan } from './planner-format.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(HERE, p), 'utf8');

const late = { assignmentId: 'a1', vehicleLabel: 'Van 1', stopId: 's1', ref: 'd-1', kind: 'late' as const, etaS: 5460, window: [0, 5400] as [number, number], overridable: true };
const early = { assignmentId: 'a1', vehicleLabel: 'Van 1', stopId: 's2', ref: 'd-2', kind: 'early_wait' as const, etaS: 2400, window: [3000, 5400] as [number, number] };
const check = (o: Partial<RoutePlanPublishCheck>): RoutePlanPublishCheck => ({ hard: [], soft: [], fingerprint: null, canOverride: false, ...o });
const plan = (publishCheck: RoutePlanPublishCheck | null, violations: PlannerPlan['violations'] = []) => ({ publishCheck, violations }) as Pick<PlannerPlan, 'publishCheck' | 'violations'>;

test('a hard arrival-window violation blocks Publish; an unauthorised user gets no override', () => {
  const g = publishGate(plan(check({ hard: [late] })));
  assert.equal(g.hard.length, 1);
  assert.equal(g.canOverride, false);
  const s = publishGateState(g, { acknowledged: true, overrideOn: true, reason: 'Site gate opens late today' });
  assert.equal(s.allowed, false, 'blocked without the override right');
  assert.equal(s.body.override, undefined);
});

test('an authorised user may override with a meaningful reason; a trivial reason keeps Publish disabled', () => {
  const g = publishGate(plan(check({ hard: [late], canOverride: true })));
  assert.equal(publishGateState(g, { acknowledged: false, overrideOn: false, reason: '' }).allowed, false);
  assert.equal(publishGateState(g, { acknowledged: false, overrideOn: true, reason: '  ok  ' }).allowed, false);
  const s = publishGateState(g, { acknowledged: false, overrideOn: true, reason: '  Site gate opens   late today ' });
  assert.equal(s.allowed, true);
  assert.deepEqual(s.body, { override: { reason: 'Site gate opens late today' } });
});

test('a non-overridable hard issue (seats / untimed) blocks even an authorised override', () => {
  const g = publishGate(plan(check({ hard: [{ ...late, kind: 'over_capacity', overridable: false }], canOverride: true })));
  assert.equal(g.blocking.length, 1);
  assert.equal(publishGateState(g, { acknowledged: true, overrideOn: true, reason: 'Site gate opens late today' }).allowed, false);
});

test('soft warnings need the acknowledgement; the request carries the server fingerprint', () => {
  const g = publishGate(plan(check({ soft: [early], fingerprint: 'w1-0badf00d' })));
  assert.equal(publishGateState(g, { acknowledged: false, overrideOn: false, reason: '' }).allowed, false);
  const s = publishGateState(g, { acknowledged: true, overrideOn: false, reason: '' });
  assert.equal(s.allowed, true);
  assert.deepEqual(s.body, { acknowledgedWarnings: 'w1-0badf00d' });
  // No issue at all: plain publish body.
  assert.deepEqual(publishGateState(publishGate(plan(check({}))), { acknowledged: false, overrideOn: false, reason: '' }), { allowed: true, body: {} });
});

test('without a server publishCheck (older server) the plan violations are classified the same way', () => {
  const g = publishGate(plan(null, [{ stopId: 's1', ref: 'd-1', kind: 'late', etaS: 5460, window: [0, 5400] }, { stopId: 's2', ref: 'd-2', kind: 'early_wait', etaS: 2400, window: [3000, 5400] }]));
  assert.deepEqual(g.hard.map((i) => i.kind), ['late']);
  assert.deepEqual(g.soft.map((i) => i.kind), ['early_wait']);
  assert.match(g.fingerprint ?? '', /^w1-[0-9a-f]{8}$/);
  assert.equal(g.canOverride, false);
});

test('publishPlan sends the acknowledgement / override with the body, and a new body gets a new key', async () => {
  const calls: { body: unknown; key: string }[] = [];
  const client = { publish: async (_id: string, body: unknown, key: string) => (calls.push({ body, key }), {}) } as never;
  let n = 0;
  const keys = createKeyStore(() => `k${++n}`);
  await publishPlan(client, { id: 'p', version: 2 }, keys.keyFor, { acknowledgedWarnings: 'w1-0badf00d' });
  await publishPlan(client, { id: 'p', version: 2 }, keys.keyFor, { override: { reason: 'Site gate opens late today' } });
  assert.deepEqual(calls[0].body, { expectedVersion: 2, acknowledgedWarnings: 'w1-0badf00d' });
  assert.deepEqual(calls[1].body, { expectedVersion: 2, override: { reason: 'Site gate opens late today' } });
  assert.notEqual(calls[0].key, calls[1].key);
});

test('the mock accepts the new PublishDto fields (forbidNonWhitelisted)', async () => {
  const c = createMockPlannerClient();
  await assert.rejects(c.publish('nope', { expectedVersion: 1, acknowledgedWarnings: 'w1-0', override: { reason: 'x' } } as never, 'k'), (e: { code?: string }) => e.code !== 'VALIDATION_FAILED');
});

test('the new error codes have text and a kind; the strings exist in hi / ta', () => {
  for (const code of ['PLAN_HAS_HARD_VIOLATIONS', 'PLAN_WARNINGS_NOT_ACKNOWLEDGED', 'PUBLISH_OVERRIDE_FORBIDDEN', 'PUBLISH_OVERRIDE_REASON_REQUIRED']) {
    const text = plannerErrorText(code);
    assert.ok(text, `${code} text`);
    for (const lang of ['hi', 'ta'] as const) assert.ok(TRANSLATIONS[lang][text as string], `${lang}: ${code}`);
  }
  assert.equal(plannerErrorKind('PLAN_HAS_HARD_VIOLATIONS', 409), 'invalid');
  assert.equal(plannerErrorKind('PLAN_WARNINGS_NOT_ACKNOWLEDGED', 409), 'invalid');
  assert.equal(plannerErrorKind('PUBLISH_OVERRIDE_FORBIDDEN', 403), 'forbidden');
});

test('the publish dialog: blocking list, acknowledgement checkbox, override only for authorised users, decision sent; strings translated', () => {
  const page = read('PlanReviewPage.tsx');
  assert.match(page, /publishGate\(/);
  assert.match(page, /publishGateState\(/);
  assert.match(page, /gate\.canOverride/);
  assert.match(page, /publish\.mutate\(gateState\.body/);
  assert.match(page, /<Textarea[\s\S]{0,300}id="publish-override-reason"/);
  assert.match(page, /publishDecision\?\.override/);
  const strings = [
    'These must be fixed before publishing. Edit the routes (move or reorder stops) or re-optimise the plan.',
    'I have checked these {{n}} warning(s) and want to publish.',
    'Override the arrival-window violations (authorised)',
    'Reason for the override (recorded in the audit log)',
    'At least {{n}} characters, in words.',
    'Published with an authorised override',
    '{{n}} arrival-window violation(s) overridden.',
    'Hard violations (block publishing)',
    'Warnings',
    'arrives {{eta}}, window {{from}}–{{to}}',
  ];
  for (const s of strings) {
    assert.ok(page.includes(`'${s}'`), `page uses: ${s}`);
    for (const lang of ['hi', 'ta'] as const) assert.ok(TRANSLATIONS[lang][s], `${lang}: ${s}`);
  }
});
