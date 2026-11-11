/**
 * Contract tests (E4 QA round, B1 / B2): the planner's real HTTP client (`createHttpPlannerClient`) and flow
 * (`planner-flow.ts`) are run over a recording transport, and every request is checked against the API's own DTO
 * classes, read from the API source: the body has every required field (`name!:`), no field the API does not
 * whitelist (forbidNonWhitelisted), and the keyed endpoints get an `Idempotency-Key` header, reused on retry.
 * A DTO change on the API side fails this test instead of a dispatcher's click.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createKeyStore, publishPlan, reoptimise, startOptimise } from './planner-flow.ts';
import { createHttpPlannerClient, type PlannerTransport } from './planner-http-client.ts';

const API = join(dirname(fileURLToPath(import.meta.url)), '../../../../../api/src');
const src = (p: string) => readFileSync(join(API, p), 'utf8');

/** Fields of `export class Name … {}` in a DTO file (inherits `extends Base` from the same file). */
function dto(file: string, name: string): { required: string[]; optional: string[] } {
  const text = src(file);
  const m = new RegExp(`class ${name}(?: extends (\\w+))?(?: implements [\\w<>, ]+)? \\{([\\s\\S]*?)\\n\\}`).exec(text);
  assert.ok(m, `DTO ${name} not found in ${file}`);
  const own = { required: [] as string[], optional: [] as string[] };
  for (const f of m[2].matchAll(/(\w+)([!?]):/g)) (f[2] === '!' ? own.required : own.optional).push(f[1]);
  if (m[1]) {
    const base = dto(file, m[1]);
    return { required: [...base.required, ...own.required], optional: [...base.optional, ...own.optional] };
  }
  return own;
}

function assertBody(body: unknown, d: { required: string[]; optional: string[] }, what: string) {
  const keys = Object.keys(body as object);
  for (const k of d.required) assert.ok(keys.includes(k), `${what}: required field "${k}" missing`);
  const allowed = new Set([...d.required, ...d.optional]);
  for (const k of keys) assert.ok(allowed.has(k), `${what}: field "${k}" is not in the API DTO (forbidNonWhitelisted)`);
}

/** The controller reads the Idempotency-Key header on this route. */
function readsKey(file: string, decorator: string) {
  const text = src(file);
  const i = text.indexOf(decorator);
  assert.ok(i >= 0, `${decorator} not found in ${file}`);
  assert.match(text.slice(i, i + 600), /@Headers\('idempotency-key'\)/, `${decorator} must take Idempotency-Key`);
}

interface Call {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function recorder(respond: (c: Call) => unknown) {
  const calls: Call[] = [];
  const tx: PlannerTransport = {
    get: async <T>(path: string) => {
      const c = { method: 'GET', path };
      calls.push(c);
      return respond(c) as T;
    },
    send: async <T>(method: 'POST' | 'PUT' | 'PATCH', path: string, body: unknown, headers?: Record<string, string>) => {
      const c = { method, path, body: JSON.parse(JSON.stringify(body)), headers };
      calls.push(c);
      const r = respond(c);
      if (r instanceof Error) throw r;
      return r as T;
    },
  };
  return { calls, client: createHttpPlannerClient(tx) };
}

const PLAN = { id: '11111111-1111-4111-8111-111111111111', version: 1 };
const JOB = { jobId: 'j1', state: 'queued', planId: PLAN.id };
const W = { vehicle: 7200, distance: 0, time: 1, routeDuration: 60 };
const SEED = { name: 'Day', shiftId: '22222222-2222-4222-8222-222222222222', sitePoiId: '33333333-3333-4333-8333-333333333333', planStartAt: '2026-11-12T01:30:00.000Z' };
const INPUT = { planDate: '2026-11-12', direction: 'IN' as const, seeds: [SEED], objectIds: ['44444444-4444-4444-8444-444444444444'], weights: W, timeLimitS: 30 };

test('the DTO reader sees the API fields (guards against a vacuous pass)', () => {
  assert.deepEqual(dto('routing-jobs/routing-jobs.controller.ts', 'SolverWeightsDto').required.sort(), ['distance', 'routeDuration', 'time', 'vehicle']);
  assert.ok(dto('routing-jobs/routing-jobs.controller.ts', 'OptimizeJobDto').required.includes('weights'));
  assert.ok(dto('routing-jobs/routing-jobs.controller.ts', 'OptimizeJobDto').required.includes('planId'));
  assert.deepEqual(dto('etms/planning/plan-create.ts', 'CreateRoutePlanDto').required.sort(), ['direction', 'name', 'objectIds', 'planDate', 'sitePoiId']);
});

test('B1: plan creation sends Idempotency-Key and a CreateRoutePlanDto body', async () => {
  const { calls, client } = recorder((c) => (c.path.endsWith('/optimize') ? JOB : PLAN));
  const keys = createKeyStore(() => `key-${Math.random()}`);
  const r = await startOptimise(client, INPUT, keys.keyFor);
  assert.equal(r[0].error, null);
  const create = calls.find((c) => c.method === 'POST' && c.path === '/transport/route-plans');
  assert.ok(create);
  assert.ok(create.headers?.['Idempotency-Key'], 'Idempotency-Key header');
  assertBody(create.body, dto('etms/planning/plan-create.ts', 'CreateRoutePlanDto'), 'create');
  readsKey('etms/planning/plan-create.ts', "@Post() @HttpCode(201)");
});

test('B2: optimise sends weights {vehicle, distance, time, routeDuration}, expectedVersion and Idempotency-Key (OptimizeJobDto)', async () => {
  const { calls, client } = recorder((c) => (c.path.endsWith('/optimize') ? JOB : PLAN));
  await startOptimise(client, INPUT, createKeyStore(() => `k${calls.length}`).keyFor);
  const opt = calls.find((c) => c.path === '/routing/jobs/optimize');
  assert.ok(opt);
  assert.ok(opt.headers?.['Idempotency-Key']);
  assertBody(opt.body, dto('routing-jobs/routing-jobs.controller.ts', 'OptimizeJobDto'), 'optimize');
  assertBody((opt.body as { weights: unknown }).weights, dto('routing-jobs/routing-jobs.controller.ts', 'SolverWeightsDto'), 'weights');
  assert.deepEqual((opt.body as { weights: unknown }).weights, W, 'the user\'s weights, unchanged');
  assert.equal((opt.body as { expectedVersion: number }).expectedVersion, PLAN.version);
  readsKey('routing-jobs/routing-jobs.controller.ts', "@Post('optimize')");
});

test('re-optimise uses the alias POST /transport/route-plans/:id/optimize with OptimizeOptionsDto (no planId)', async () => {
  const { calls, client } = recorder(() => JOB);
  await reoptimise(client, { id: PLAN.id, version: 5 }, { weights: W, timeLimitS: 30 }, createKeyStore(() => 'rk').keyFor);
  const c = calls[0];
  assert.equal(c.path, `/transport/route-plans/${PLAN.id}/optimize`);
  assert.equal(c.headers?.['Idempotency-Key'], 'rk');
  assertBody(c.body, dto('routing-jobs/routing-jobs.controller.ts', 'OptimizeOptionsDto'), 're-optimise');
  assert.equal((c.body as { expectedVersion: number }).expectedVersion, 5);
  readsKey('etms/planning/plan-create.ts', "@Post(':id/optimize')");
});

test('a retry of the same action reuses the key; a new action or another body gets a new one', async () => {
  let n = 0;
  let fail = true;
  const { calls, client } = recorder((c) => {
    if (c.path === '/transport/route-plans' && fail) return Object.assign(new Error('network'), { status: 0 });
    return c.path.endsWith('/optimize') ? JOB : PLAN;
  });
  const keys = createKeyStore(() => `k${++n}`);
  const first = await startOptimise(client, INPUT, keys.keyFor);
  assert.ok(first[0].error, 'lost answer');
  fail = false;
  await startOptimise(client, INPUT, keys.keyFor);
  const creates = calls.filter((c) => c.path === '/transport/route-plans');
  assert.equal(creates[0].headers?.['Idempotency-Key'], creates[1].headers?.['Idempotency-Key'], 'retry replays');
  await startOptimise(client, { ...INPUT, objectIds: ['55555555-5555-4555-8555-555555555555'] }, keys.keyFor);
  assert.notEqual(calls.filter((c) => c.path === '/transport/route-plans')[2].headers?.['Idempotency-Key'], creates[0].headers?.['Idempotency-Key'], 'another body → new key');
  keys.clear();
  await startOptimise(client, INPUT, keys.keyFor);
  assert.notEqual(calls.filter((c) => c.path === '/transport/route-plans')[3].headers?.['Idempotency-Key'], creates[0].headers?.['Idempotency-Key'], 'a new action → new key');
});

test('a shift without a site is refused in the browser (sitePoiId is required), not sent', async () => {
  const { calls, client } = recorder(() => PLAN);
  const r = await startOptimise(client, { ...INPUT, seeds: [{ ...SEED, sitePoiId: null }] }, createKeyStore(() => 'k').keyFor);
  assert.equal((r[0].error as { code?: string }).code, 'SITE_REQUIRED');
  assert.equal(calls.length, 0);
});

test('publish sends { expectedVersion } with Idempotency-Key (PublishDto); edits send expectedVersion (plans DTOs)', async () => {
  const { calls, client } = recorder(() => ({ plan: PLAN, violations: [], degraded: null }));
  await publishPlan(client, { id: PLAN.id, version: 3 }, createKeyStore(() => 'pk').keyFor);
  assert.equal(calls[0].headers?.['Idempotency-Key'], 'pk');
  assertBody(calls[0].body, dto('etms/planning/plans.dto.ts', 'PublishDto'), 'publish');
  readsKey('etms/planning/plans.controller.ts', "@Post(':id/publish')");
  await client.movePassenger(PLAN.id, { expectedVersion: 3, bookingId: 'b', toAssignmentId: null });
  await client.resequence(PLAN.id, { expectedVersion: 3, assignments: [{ assignmentId: 'a', stopIds: ['s'] }] });
  await client.updateAssignment(PLAN.id, 'a', { expectedVersion: 3, locked: true });
  await client.updateStop(PLAN.id, 's', { expectedVersion: 3, pinned: true });
  await client.discard(PLAN.id, { expectedVersion: 3 });
  const [, move, seq, asg, stop, discard] = calls;
  assertBody(move.body, dto('etms/planning/plans.dto.ts', 'MovePassengerDto'), 'move');
  assert.equal(move.path, `/transport/route-plans/${PLAN.id}/move-passenger`);
  assertBody(seq.body, dto('etms/planning/plans.dto.ts', 'ResequenceDto'), 'sequence');
  assert.equal(seq.method, 'PUT');
  assertBody(asg.body, dto('etms/planning/plans.dto.ts', 'AssignmentUpdateDto'), 'assignment');
  assert.equal(asg.method, 'PATCH');
  assertBody(stop.body, dto('etms/planning/plans.dto.ts', 'StopUpdateDto'), 'stop');
  assertBody(discard.body, dto('etms/planning/plans.dto.ts', 'DiscardDto'), 'discard');
  assert.equal(discard.path, `/transport/route-plans/${PLAN.id}/discard`);
  for (const c of [move, seq, asg, stop, discard]) assert.equal(typeof (c.body as { expectedVersion?: unknown }).expectedVersion, 'number');
});

test('capabilities come from GET /routing/capabilities (no fallback guessing)', async () => {
  const { calls, client } = recorder(() => ({ enabled: true }));
  await client.capabilities();
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['GET /routing/capabilities']);
});
