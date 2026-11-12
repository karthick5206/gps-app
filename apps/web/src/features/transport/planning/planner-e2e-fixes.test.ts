/**
 * Regressions for the E4 end-to-end round (T1 / T2 reports, 2026-11-11), web side. Pure helpers plus source guards
 * for wording promises (the web has no DOM harness; focus behaviour is checked by the T2 Playwright journey).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MENUS, TRANSLATIONS, type EtaModel, type RoutingJobDto } from '@veetracer/shared';
import {
  canShiftStop,
  jobOutcome,
  mapControlLocale,
  MAP_CONTROL_STRINGS,
  planBranchChoice,
  planMetrics,
  plannerErrorText,
  reoptimiseDefaults,
  routeDriveSummary,
  steadyProgress,
  timeLimitOptions,
  type PlannerPlan,
} from './planner-format.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(HERE, p), 'utf8');
const ENGINE: EtaModel = { source: 'engine_free_flow', liveTraffic: false, calibrated: false } as unknown as EtaModel;

// ── T2-D5: branch picker ──

test('T2-D5: branch choice: whole company needs none; one branch is fixed; several are picked; none is a blocker', () => {
  assert.deepEqual(planBranchChoice({ scope: 'COMPANY', branches: [] }), { mode: 'none' });
  assert.deepEqual(planBranchChoice({ scope: 'ASSIGNED', branches: [{ id: 'n', name: 'North' }] }), { mode: 'fixed', branch: { id: 'n', name: 'North' } });
  assert.deepEqual(planBranchChoice({ scope: 'ASSIGNED', branches: [{ id: 'n', name: 'North' }, { id: 's', name: 'South' }] }), { mode: 'pick', branches: [{ id: 'n', name: 'North' }, { id: 's', name: 'South' }] });
  assert.deepEqual(planBranchChoice({ scope: 'ASSIGNED', branches: [] }), { mode: 'missing' });
  assert.deepEqual(planBranchChoice({ scope: 'ASSIGNED' }), { mode: 'missing' });
});

test('T2-D5: the optimise panel offers the branch picker and sends the branch', () => {
  const panel = read('OptimisePanel.tsx');
  assert.match(panel, /planBranchChoice\(/);
  assert.match(panel, /branchId/);
});

// ── T2-D6: pins keep their vehicle (the solver has no position constraint) ──

test('T2-D6: no screen or contract promises that a pinned stop keeps its position', () => {
  const page = read('PlanReviewPage.tsx');
  assert.doesNotMatch(page, /route and position/);
  assert.match(page, /pinned to this vehicle/);
  const shared = readFileSync(join(HERE, '../../../../../../packages/shared/src/routing-plans.ts'), 'utf8');
  assert.doesNotMatch(shared, /at its position/);
  const svc = readFileSync(join(HERE, '../../../../../api/src/etms/planning/plans.service.ts'), 'utf8');
  assert.doesNotMatch(svc, /on its route at its position/);
  for (const lang of ['hi', 'ta'] as const) {
    assert.ok(TRANSLATIONS[lang]['{{name}} pinned to this vehicle. Re-optimising keeps it on this vehicle; its place in the order may change.'], `${lang} pin toast`);
    assert.ok(TRANSLATIONS[lang]['Pinned stops stay on their vehicle and locked routes keep their stops and order; everything else may change. A new version is saved.'], `${lang} re-optimise text`);
  }
});

// ── T1-D5: duplicate driver ──

test('T1-D5: DRIVER_DUPLICATE has its own text', () => {
  assert.equal(plannerErrorText('DRIVER_DUPLICATE'), 'This driver already drives another route of this plan.');
});

// ── T2-L1: engine down after an edit ──

test('T2-L1: a route with an engine ETA model but no distance / time (edited while the engine was down) says "No engine distance or time yet"', () => {
  assert.deepEqual(routeDriveSummary({ eta: ENGINE, distanceM: null, durationS: null, adjustedDurationS: null }, 3), { kind: 'pending' });
  assert.deepEqual(routeDriveSummary({ eta: ENGINE, distanceM: 1200, durationS: null, adjustedDurationS: null }, 3), { kind: 'pending' });
  assert.deepEqual(routeDriveSummary({ eta: ENGINE, distanceM: 1200, durationS: 600, adjustedDurationS: 660 }, 3), { kind: 'engine', distanceM: 1200, durationS: 660 });
  assert.deepEqual(routeDriveSummary({ eta: null, distanceM: 1200, durationS: 600, adjustedDurationS: null }, 3), { kind: 'pending' });
  assert.deepEqual(routeDriveSummary({ eta: null, distanceM: null, durationS: null, adjustedDurationS: null }, 0), { kind: 'empty' });
});

test('T2-L1: plan metrics with no route in use show no distance / time ("—"), not 0 m / 0 min', () => {
  const plan = { direction: 'IN', violations: [], assignments: [{ id: 'a', eta: ENGINE, distanceM: null, durationS: null, adjustedDurationS: null, capacity: 4, startS: null, endS: null }], stops: [{ id: 's', assignmentId: null, sequence: null, stopKind: 'PICKUP', demand: 1, etaS: null }] } as unknown as PlannerPlan;
  const m = planMetrics(plan);
  assert.equal(m.distanceM, null);
  assert.equal(m.driveS, null);
});

// ── T2-L2: infeasible job ──

const job = (over: Partial<RoutingJobDto>): RoutingJobDto => ({ jobId: 'j', kind: 'optimize', state: 'succeeded', phase: 'done', progress: 100, attempts: 1, maxAttempts: 3, cancelRequested: false, planId: 'p', createdAt: '', startedAt: '', finishedAt: '', graphVersion: null, attribution: '', ...over }) as RoutingJobDto;
const result = (routes: number[], unassigned: number) => ({ status: 'FEASIBLE', provenOptimal: false, routes: routes.map((n, i) => ({ vehicleId: `v${i}`, startS: 0, endS: 0, durationS: 0, distanceM: 0, stops: Array.from({ length: n }, (_, k) => ({ stopId: `s${i}-${k}` })), eta: ENGINE })), unassigned: Array.from({ length: unassigned }, (_, k) => ({ stopId: `u${k}`, reason: 'no_route' })) });

test('T2-L2: a job that seated nobody is a warning that says so, not a green "Done"', () => {
  const o = jobOutcome(job({ result: result([0, 0], 30) as never }));
  assert.equal(o.tone, 'warning');
  assert.equal(o.label, 'Done · nobody seated');
  assert.match(o.detail ?? '', /No passenger could be seated/);
});

test('T2-L2: some unassigned → warning with the passenger count from the plan when known; all seated → Done', () => {
  const plan = { direction: 'IN', stops: [{ assignmentId: null, stopKind: 'PICKUP' }, { assignmentId: null, stopKind: 'DROP' }, { assignmentId: 'a', stopKind: 'PICKUP' }, { assignmentId: 'a', stopKind: 'DROP' }] } as unknown as PlannerPlan;
  const o = jobOutcome(job({ result: result([2], 2) as never }), plan);
  assert.equal(o.tone, 'warning');
  assert.equal(o.label, 'Done · some unassigned');
  assert.deepEqual(o.vars, { n: 1, total: 2 });
  assert.deepEqual(jobOutcome(job({ result: result([4], 0) as never })), { tone: 'success', label: 'Done', detail: null, vars: {} });
  assert.equal(jobOutcome(job({ state: 'failed' })).tone, 'destructive');
});

// ── T2-L3: up / down next to a pinned stop ──

test('T2-L3: up / down are not offered when they would move a pinned neighbour (the API would refuse STOP_PINNED)', () => {
  const stops = [{ pinned: false }, { pinned: true }, { pinned: false }];
  assert.equal(canShiftStop(stops, 0, 1), false, 'down onto the pinned stop');
  assert.equal(canShiftStop(stops, 2, -1), false, 'up onto the pinned stop');
  assert.equal(canShiftStop(stops, 1, 1), false, 'the pinned stop itself');
  assert.equal(canShiftStop(stops, 0, -1), false, 'first stop up');
  assert.equal(canShiftStop([{ pinned: false }, { pinned: false }], 0, 1), true);
});

test('T2-L3 follow-up: up / down never swap a passenger’s pickup with its own drop (the API answers 400 "drop must come after the pickup")', () => {
  const one = [{ pinned: false, bookingId: 'b1', stopKind: 'PICKUP' as const }, { pinned: false, bookingId: 'b1', stopKind: 'DROP' as const }];
  assert.equal(canShiftStop(one, 0, 1), false);
  assert.equal(canShiftStop(one, 1, -1), false);
  const two = [{ pinned: false, bookingId: 'b1', stopKind: 'PICKUP' as const }, { pinned: false, bookingId: 'b2', stopKind: 'PICKUP' as const }, { pinned: false, bookingId: 'b1', stopKind: 'DROP' as const }];
  assert.equal(canShiftStop(two, 0, 1), true);
  assert.equal(canShiftStop(two, 1, 1), true);
});

// ── T2-L4: re-optimise prefill and time limit ──

test('T2-L4: re-optimise prefills the stored weights; the time limit is a choice within the API range', () => {
  assert.deepEqual(reoptimiseDefaults({ weights: { vehicle: 7200, distance: 0, time: 1, routeDuration: 60 } }).weights, { vehicle: 7200, distance: 0, time: 1, routeDuration: 60 });
  assert.deepEqual(reoptimiseDefaults({ weights: null }).weights, { vehicle: null, distance: null, time: null, routeDuration: null });
  assert.equal(reoptimiseDefaults({ weights: null }).timeLimitS, 30);
  assert.deepEqual(timeLimitOptions(60), [10, 30, 60]);
  assert.deepEqual(timeLimitOptions(20), [10, 20]);
  assert.deepEqual(timeLimitOptions(undefined), [10, 30, 60]);
  assert.doesNotMatch(read('PlanReviewPage.tsx'), /timeLimitS: 30/, 'no fixed 30 s in the re-optimise dialog');
});

// ── T2-O1: progress never goes backwards on a retry ──

test('T2-O1: shown progress is monotonic per job; a retry is labelled but the bar does not jump back', () => {
  let s = steadyProgress(null, job({ jobId: 'j', state: 'running', progress: 40, attempts: 1 }));
  assert.equal(s.value, 40);
  s = steadyProgress(s, job({ jobId: 'j', state: 'running', progress: 17, attempts: 2 }));
  assert.equal(s.value, 40);
  assert.equal(s.retrying, true);
  s = steadyProgress(s, job({ jobId: 'j', state: 'running', progress: 55, attempts: 2 }));
  assert.equal(s.value, 55);
  // Another job starts from its own value.
  assert.equal(steadyProgress(s, job({ jobId: 'k', state: 'running', progress: 5, attempts: 1 })).value, 5);
});

// ── T2-L5: translations of the shell, toaster and map controls ──

test('T2-L5: ETMS sidebar items, the toaster label and the MapLibre control labels have hi and ta strings', () => {
  const keys = [...MENUS.filter((m) => m.group === 'transport').map((m) => m.label), 'Notifications', ...Object.values(MAP_CONTROL_STRINGS)];
  for (const lang of ['hi', 'ta'] as const) {
    const missing = keys.filter((k) => !TRANSLATIONS[lang][k]);
    assert.deepEqual(missing, [], `${lang} missing`);
  }
  const loc = mapControlLocale((k) => `T:${k}`);
  assert.equal(loc['NavigationControl.ZoomIn'], 'T:Zoom in');
  assert.equal(loc['Map.Title'], 'T:Map');
  assert.match(read('PlanMap.tsx'), /mapControlLocale\(/);
  assert.match(readFileSync(join(HERE, '../../../app/App.tsx'), 'utf8'), /containerAriaLabel=/);
});
