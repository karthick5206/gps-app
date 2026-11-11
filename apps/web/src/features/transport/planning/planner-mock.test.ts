/**
 * Scenario tests over the synthetic plans + jobs API (the flow the screens drive, shaped like E4-F / E4-E): optimise →
 * review → explicit edits with re-validation → version conflict → compare (metrics only) → publish (→ E3 trip ids,
 * idempotent replay) → discard; locks / pins; and the engine-down path (0 ETAs from a live source).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMockPlannerClient, FIXTURE_VEHICLES } from './planner-mock.ts';
import { changedRoutes, engineEta, mapPoints, metricsFromCompare, planMetrics, routesOf, shiftStop, stopEta, weightedScores } from './planner-format.ts';

const W = { vehicles: 2, distance: 5, driveTime: 3, maxRide: 4, unassigned: 10 };
const THREE = FIXTURE_VEHICLES.slice(0, 3).map((v) => v.objectId);

async function optimised(c: ReturnType<typeof createMockPlannerClient>, objectIds = THREE, key = `k-${Math.random()}`) {
  const plan = await c.createPlan({ name: 'Login 09:00', planDate: '2026-11-12', planStartAt: '2026-11-12T01:30:00.000Z', direction: 'IN', shiftId: 'sh-1', sitePoiId: 'poi-site-1', objectIds });
  const job = await c.optimize({ planId: plan.id, expectedVersion: plan.version, timeLimitS: 10, objective: 'duration' }, key);
  const states: string[] = [job.state];
  for (let i = 0; i < 6; i++) {
    const j = await c.getJob(job.jobId);
    states.push(j.state);
    if (j.state === 'succeeded') break;
  }
  return { plan: await c.getPlan(plan.id), states, jobId: job.jobId };
}

test('optimise: job goes queued → running → succeeded with progress; plan ready to review', async () => {
  const c = createMockPlannerClient();
  const { plan, states } = await optimised(c);
  assert.deepEqual([states[0], states.at(-1)], ['queued', 'succeeded']);
  assert.ok(states.includes('running'));
  assert.equal(plan.status, 'PLANNED');
  const m = planMetrics(plan);
  assert.equal(m.unassigned, 1, 'the passenger without a consented point stays unassigned');
  assert.equal(plan.stops.find((s) => !s.assignmentId)?.unassignedReason, 'unreachable_location');
  assert.equal(mapPoints(plan, plan.precise).hidden, 1, 'and is not drawn');
  assert.ok(m.distanceM && m.distanceM > 0);
});

test('optimise is idempotent per key; cancel stops a running job and the plan goes back to draft', async () => {
  const c = createMockPlannerClient();
  const plan = await c.createPlan({ name: 'x', planDate: '2026-11-12', direction: 'IN', objectIds: ['veh-1'] });
  const job = await c.optimize({ planId: plan.id, expectedVersion: plan.version }, 'same');
  assert.equal((await c.optimize({ planId: plan.id, expectedVersion: plan.version }, 'same')).jobId, job.jobId);
  await c.getJob(job.jobId);
  await c.cancelJob(job.jobId);
  assert.equal((await c.getJob(job.jobId)).state, 'cancelled');
  assert.equal((await c.getPlan(plan.id)).status, 'DRAFT');
});

test('edits: reorder, move passenger, change vehicle, pin, lock → new version + re-validation', async () => {
  const c = createMockPlannerClient();
  const { plan } = await optimised(c);
  const routes = routesOf(plan);
  const first = routes[0].stopIds;
  const r1 = await c.resequence(plan.id, { expectedVersion: plan.version, assignments: changedRoutes(routes, shiftStop(routes, first[1], -1)) });
  assert.equal(r1.plan.version, plan.version + 1);
  assert.equal(routesOf(r1.plan)[0].stopIds[0], first[1]);
  // Move every passenger of route 1 onto the small car: over capacity comes back from the re-check.
  let p = r1.plan;
  const car = p.assignments[2].id;
  for (const id of routesOf(p)[0].stopIds) {
    const s = p.stops.find((x) => x.id === id)!;
    const r = await c.movePassenger(p.id, { expectedVersion: p.version, bookingId: s.bookingId!, toAssignmentId: car });
    p = r.plan;
    if (r.violations.some((v) => v.kind === 'over_capacity')) break;
  }
  assert.ok(p.violations.some((v) => v.kind === 'over_capacity'));
  const r3 = await c.updateAssignment(p.id, car, { expectedVersion: p.version, objectId: 'veh-9' });
  assert.ok(!r3.violations.some((v) => v.kind === 'over_capacity'), 'a bigger vehicle clears the warning');
  const pinId = r3.plan.stops.find((s) => s.assignmentId)!.id;
  const r4 = await c.updateStop(p.id, pinId, { expectedVersion: r3.plan.version, pinned: true });
  assert.equal(r4.plan.stops.find((s) => s.id === pinId)?.pinned, true);
  const pinned = r4.plan.stops.find((s) => s.id === pinId)!;
  await assert.rejects(() => c.movePassenger(p.id, { expectedVersion: r4.plan.version, bookingId: pinned.bookingId!, toAssignmentId: null }), (e: { code: string }) => e.code === 'STOP_PINNED');
  const r5 = await c.updateAssignment(p.id, car, { expectedVersion: r4.plan.version, locked: true });
  assert.equal(r5.plan.assignments.find((a) => a.id === car)?.locked, true);
  const hist = await c.history(p.id);
  assert.ok(hist.length >= 5);
  assert.ok(hist.every((h) => h.snapshot.stops.every((s) => !('lat' in s))), 'history snapshots carry no coordinates');
});

test('version conflict: an edit on a stale version is refused with PLAN_STALE', async () => {
  const c = createMockPlannerClient();
  const { plan } = await optimised(c);
  c.bumpVersion(plan.id);
  await assert.rejects(() => c.updateStop(plan.id, plan.stops[0].id, { expectedVersion: plan.version, pinned: true }), (e: { status: number; code: string }) => e.status === 409 && e.code === 'PLAN_STALE');
});

test('compare two plans on metrics, then publish one (E3 trips, replay) and discard the other', async () => {
  const c = createMockPlannerClient();
  const a = (await optimised(c)).plan;
  const b = (await optimised(c, THREE.slice(0, 2))).plan;
  const cmp = await c.compare([a.id, b.id]);
  const [ma, mb] = cmp.plans.map((d) => metricsFromCompare(d));
  assert.equal(mb.unassigned, 2, 'two vehicles leave one more passenger over');
  assert.ok(!('stops' in cmp.plans[0] && Array.isArray((cmp.plans[0] as unknown as { stops: unknown }).stops)), 'metrics only');
  assert.equal(weightedScores([ma, mb], null).winner, null, 'no winner without weights');
  assert.notEqual(weightedScores([ma, mb], { ...W, maxRide: 0 }).winner, null);
  const pub = await c.publish(a.id, { expectedVersion: a.version }, 'pub-1');
  assert.equal(pub.trips.length, planMetrics(a).vehiclesUsed);
  assert.ok(pub.trips.every((t) => t.transportTripId));
  assert.deepEqual(await c.publish(a.id, { expectedVersion: a.version }, 'pub-1'), pub, 'same key replays the same result');
  const after = await c.getPlan(a.id);
  assert.equal(after.status, 'PUBLISHED');
  assert.equal(after.editable, false);
  await assert.rejects(() => c.updateStop(a.id, after.stops[0].id, { expectedVersion: after.version, pinned: true }), (e: { code: string }) => e.code === 'PLAN_NOT_EDITABLE');
  const d = await c.discard(b.id, { expectedVersion: b.version });
  assert.equal(d.status, 'CANCELLED');
});

test('engine down: optimise refused as routing unavailable; edits degraded; 0 ETAs shown from a live source; publish refused per route', async () => {
  const c = createMockPlannerClient();
  const { plan } = await optimised(c);
  c.setMode('engine-down');
  const caps = await c.capabilities();
  assert.equal(caps.engineReachable, false);
  assert.equal(caps.liveTraffic, false);
  await assert.rejects(() => c.optimize({ planId: plan.id, expectedVersion: plan.version }, 'k'), (e: { code: string }) => e.code === 'ROUTING_UNAVAILABLE');
  const p = await c.getPlan(plan.id);
  let shown = 0;
  for (const s of p.stops) if (stopEta(s, p.assignments.find((x) => x.id === s.assignmentId), p.planStartAt, 'Asia/Kolkata').at) shown++;
  assert.equal(shown, 0, 'live_heuristic models are never shown');
  assert.ok(p.assignments.every((a) => !a.eta || !engineEta(a.eta)));
  const routes = routesOf(p);
  const r = await c.resequence(p.id, { expectedVersion: p.version, assignments: changedRoutes(routes, shiftStop(routes, routes[0].stopIds[1], -1)) });
  assert.equal(r.degraded, 'ENGINE_UNREACHABLE');
  assert.ok(r.plan.stops.filter((s) => s.assignmentId === routes[0].assignmentId).every((s) => s.etaS === null), 'changed route: null times, never estimated');
  await assert.rejects(
    () => c.publish(p.id, { expectedVersion: r.plan.version }, 'pub-x'),
    (e: { code: string; body: { routes: { assignmentId: string }[] } }) => e.code === 'PLAN_NOT_PUBLISHABLE' && e.body.routes.some((x) => x.assignmentId === routes[0].assignmentId),
  );
});
