/**
 * Scenario tests over the synthetic planner API (the same flow the screens drive): optimise → review → explicit edits
 * with re-validation → version conflict → compare → publish (→ E3 trip ids) → discard; and the engine-down path.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMockPlannerClient, FIXTURE_VEHICLES } from './planner-mock.ts';
import { changedRoutes, engineEta, mapPoints, movePassenger, planMetrics, routesOf, shiftStop, stopEta, weightedScores } from './planner-format.ts';

const W = { vehicles: 2, distance: 5, driveTime: 3, maxRide: 4, unassigned: 10 };

async function optimised(c: ReturnType<typeof createMockPlannerClient>, vehicles = FIXTURE_VEHICLES) {
  let plan = await c.createPlan({ name: 'Login 09:00', planDate: '2026-11-12', planStartAt: '2026-11-12T01:30:00.000Z', direction: 'IN', shiftId: 'sh-1', sitePoiId: 'poi-site-1' });
  for (const v of vehicles) plan = await c.addAssignment(plan.id, { expectedVersion: plan.version, vehicleLabel: v.name, objectId: v.objectId, capacity: v.seats });
  const job = await c.optimize(plan.id, { expectedVersion: plan.version, timeLimitS: 10, objective: 'duration', weights: W });
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
  assert.equal(mapPoints(plan, 'COMPANY').hidden, 1, 'and is not drawn');
  assert.ok(m.distanceM && m.distanceM > 0);
});

test('cancel: a running job stops and the plan goes back to draft', async () => {
  const c = createMockPlannerClient();
  let plan = await c.createPlan({ name: 'x', planDate: '2026-11-12', direction: 'IN' });
  plan = await c.addAssignment(plan.id, { expectedVersion: plan.version, vehicleLabel: 'V', objectId: 'o', capacity: 4 });
  const job = await c.optimize(plan.id, { expectedVersion: plan.version, weights: W });
  await c.getJob(job.jobId);
  await c.cancelJob(job.jobId);
  const j = await c.getJob(job.jobId);
  assert.equal(j.state, 'cancelled');
  assert.equal((await c.getPlan(plan.id)).status, 'DRAFT');
});

test('edits: reorder, move passenger, change vehicle, pin → new version + re-validation', async () => {
  const c = createMockPlannerClient();
  const { plan } = await optimised(c);
  const routes = routesOf(plan);
  const first = routes[0].stopIds;
  const r1 = await c.resequence(plan.id, { expectedVersion: plan.version, assignments: changedRoutes(routes, shiftStop(routes, first[1], -1)) });
  assert.equal(r1.plan.version, plan.version + 1);
  assert.equal(routesOf(r1.plan)[0].stopIds[0], first[1]);
  // Move everything onto the small car: over capacity is reported by the re-check.
  let p = r1.plan;
  let rs = routesOf(p);
  for (const id of rs[0].stopIds) rs = movePassenger(rs, p.stops, id, p.assignments[2].id);
  const r2 = await c.resequence(p.id, { expectedVersion: p.version, assignments: changedRoutes(routesOf(p), rs) });
  assert.ok(r2.violations.some((v) => v.kind === 'over_capacity'));
  p = r2.plan;
  const r3 = await c.changeVehicle(p.id, p.assignments[2].id, { expectedVersion: p.version, objectId: 'veh-9', vehicleLabel: 'Bus 09', capacity: 12 });
  assert.ok(!r3.violations.some((v) => v.kind === 'over_capacity'), 'bigger vehicle clears the warning');
  const pinId = r3.plan.stops.find((s) => s.assignmentId)!.id;
  const r4 = await c.pinStop(p.id, pinId, { expectedVersion: r3.plan.version, pinned: true });
  assert.equal(r4.plan.stops.find((s) => s.id === pinId)?.pinned, true);
  const hist = await c.history(p.id);
  assert.ok(hist.length >= 5);
  assert.ok(hist.every((h) => h.snapshot.stops.every((s) => !('lat' in s))), 'history snapshots carry no coordinates');
});

test('version conflict: an edit on a stale version is refused with PLAN_STALE', async () => {
  const c = createMockPlannerClient();
  const { plan } = await optimised(c);
  c.bumpVersion(plan.id);
  await assert.rejects(() => c.pinStop(plan.id, plan.stops[0].id, { expectedVersion: plan.version, pinned: true }), (e: { status: number; code: string }) => e.status === 409 && e.code === 'PLAN_STALE');
});

test('compare two plans on metrics, then publish one (trips for E3) and discard the other', async () => {
  const c = createMockPlannerClient();
  const a = (await optimised(c)).plan;
  const b = (await optimised(c, FIXTURE_VEHICLES.slice(0, 2))).plan;
  const [ma, mb] = [planMetrics(a), planMetrics(b)];
  assert.equal(mb.unassigned, 2, 'two vehicles leave one more passenger over');
  assert.equal(weightedScores([ma, mb], null).winner, null, 'no winner without weights');
  assert.equal(weightedScores([ma, mb], W).winner !== null, true);
  const pub = await c.publish(a.id, { expectedVersion: a.version, idempotencyKey: 'k-1' });
  assert.equal(pub.trips.length, planMetrics(a).vehiclesUsed);
  assert.ok(pub.trips.every((t) => t.transportTripId));
  const after = await c.getPlan(a.id);
  assert.equal(after.status, 'PUBLISHED');
  await assert.rejects(() => c.pinStop(a.id, after.stops[0].id, { expectedVersion: after.version, pinned: true }), (e: { code: string }) => e.code === 'PLAN_NOT_EDITABLE');
  const d = await c.discard(b.id, { expectedVersion: b.version });
  assert.equal(d.status, 'CANCELLED');
});

test('engine down: optimise refused as routing unavailable and 0 ETAs shown from a live source', async () => {
  const c = createMockPlannerClient();
  const { plan } = await optimised(c);
  c.setMode('engine-down');
  const caps = await c.capabilities();
  assert.equal(caps.engineReachable, false);
  assert.equal(caps.liveTraffic, false);
  await assert.rejects(() => c.optimize(plan.id, { expectedVersion: plan.version, weights: W }), (e: { code: string }) => e.code === 'ROUTING_UNAVAILABLE');
  const p = await c.getPlan(plan.id);
  let shown = 0;
  for (const s of p.stops) {
    const a = p.assignments.find((x) => x.id === s.assignmentId);
    if (a && !engineEta(a.eta) && stopEta(s, a, p.planStartAt, 'Asia/Kolkata').at) shown++;
    if (stopEta(s, a, p.planStartAt, 'Asia/Kolkata').at) shown++;
  }
  assert.equal(shown, 0);
  assert.equal(planMetrics(p).maxRideS, null);
});
