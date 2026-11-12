import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EtaModel } from '@veetracer/shared';
import {
  bestOf,
  capabilityView,
  changedRoutes,
  completeWeights,
  deltaPercent,
  emptyWeights,
  engineEta,
  etaQuality,
  mapPoints,
  mergeViolations,
  movePassenger,
  moveStop,
  parseWeight,
  planMetrics,
  plannerErrorKind,
  plannerErrorText,
  planSeeds,
  routeLines,
  routesOf,
  shiftStop,
  solverObjective,
  stopEta,
  stopLabel,
  toEditResult,
  toList,
  unassignedReason,
  weightedScores,
  zonedIso,
  type PlannerAssignment,
  metricsFromCompare,
  unassignedPassengers,
  skippedSummary,
  activeJobId,
  publishable,
  type PlannerPlan,
  type PlannerStop,
} from './planner-format.ts';

const ENGINE: EtaModel = { source: 'engine_free_flow', calibrated: false, liveTraffic: false, graphVersion: 'gh', band: null, factor: 1, factorSource: null };
const LIVE: EtaModel = { ...ENGINE, source: 'live_heuristic' };

function stop(id: string, over: Partial<PlannerStop> = {}): PlannerStop {
  return {
    id, ref: id.toUpperCase(), name: null, lat: 12.912345678, lng: 80.198765432, snappedLat: null, snappedLng: null, snapDistanceM: null,
    demand: 1, serviceS: 60, timeWindows: null, assignmentId: null, sequence: null, etaS: null, unassignedReason: null,
    stopKind: 'PICKUP', bookingId: `b-${id}`, profileId: 'p', poiId: null, customerCompanyId: null, personal: true,
    pointHidden: null, pinned: false, plannedArrival: null, seats: 1, ...over,
  };
}
function asg(id: string, over: Partial<PlannerAssignment> = {}): PlannerAssignment {
  return { id, seq: 0, vehicleLabel: id, objectId: `o-${id}`, driverId: null, capacity: 4, distanceM: 10_000, durationS: 1800, adjustedDurationS: 1800, startS: 0, endS: 2400, geometry: { type: 'LineString', coordinates: [[80.1, 12.9], [80.2, 12.95]] }, eta: ENGINE, transportTripId: null,
    locked: false, vehicleName: id, plateNumber: null, driverName: null, passengers: 0, seats: 0, violations: [], plannedTripId: null, ...over };
}
function plan(over: Partial<PlannerPlan> = {}): PlannerPlan {
  return {
    id: 'pl', name: 'P', planDate: '2026-11-12', planStartAt: '2026-11-12T01:30:00.000Z', status: 'PLANNED', profile: 'car', branchId: null, graphVersion: 'gh', depot: { lat: 12.9, lng: 80.2 },
    direction: 'IN', shiftId: 's', sitePoiId: 'site', version: 3, publishedAt: null, createdAt: '', updatedAt: '', precise: true, editable: true, violations: [], unassigned: 1,
    assignments: [asg('a1'), asg('a2', { distanceM: 5000, durationS: 900, adjustedDurationS: 900, endS: 1500 })],
    stops: [
      stop('s1', { assignmentId: 'a1', sequence: 0, etaS: 300 }),
      stop('s2', { assignmentId: 'a1', sequence: 1, etaS: 900 }),
      stop('s3', { assignmentId: 'a2', sequence: 0, etaS: 600 }),
      stop('s4', { unassignedReason: 'time_window_unreachable' }),
    ],
    ...over,
  };
}

test('engine ETAs only: live / heuristic sources are never shown (0 ETAs with a live source)', () => {
  assert.equal(engineEta(ENGINE), true);
  assert.equal(engineEta({ ...ENGINE, source: 'engine_calibrated', calibrated: true }), true);
  assert.equal(engineEta(LIVE), false);
  assert.equal(engineEta(null), false);
  const p = plan({ assignments: [asg('a1', { eta: LIVE }), asg('a2', { eta: LIVE })] });
  for (const s of p.stops) assert.equal(stopEta(s, p.assignments.find((a) => a.id === s.assignmentId), p.planStartAt, 'Asia/Kolkata').at, null);
  const m = planMetrics(p);
  assert.equal(m.distanceM, null);
  assert.equal(m.driveS, null);
  assert.equal(m.maxRideS, null);
  assert.equal(m.etaQuality, 'none');
  assert.deepEqual(routeLines(p), [], 'no road line drawn from a non-engine route');
});

test('stopEta: engine time in the zone, labelled uncalibrated · no live traffic', () => {
  const p = plan();
  const v = stopEta(p.stops[0], p.assignments[0], p.planStartAt, 'Asia/Kolkata');
  assert.equal(v.at, '07:05');
  assert.match(v.note, /uncalibrated · no live traffic/);
  assert.equal(stopEta(p.stops[3], undefined, p.planStartAt, 'Asia/Kolkata').at, null);
  assert.equal(stopEta({ etaS: null }, p.assignments[0], p.planStartAt, 'UTC').at, null);
});

test('planMetrics: vehicles, km, time, longest ride, unassigned with reasons, violations', () => {
  const m = planMetrics(plan({ violations: [{ stopId: 's1', ref: 'S1', kind: 'late', etaS: 300, window: [0, 200] }] }));
  assert.equal(m.vehiclesUsed, 2);
  assert.equal(m.distanceM, 15_000);
  assert.equal(m.driveS, 2700);
  assert.equal(m.maxRideS, 2100, 'login ride = site arrival − pickup (2400 − 300)');
  assert.equal(m.avgRideS, Math.round((2100 + 1500 + 900) / 3));
  assert.equal(m.unassigned, 1);
  assert.deepEqual(m.unassignedByReason, { time_window_unreachable: 1 });
  assert.equal(m.violations, 1);
  assert.equal(m.seatsUsed, 3);
  assert.equal(m.seats, 8);
  assert.equal(m.passengers, 4);
  assert.equal(m.etaQuality, 'uncalibrated');
});

test('etaQuality is the worst case of the routes', () => {
  assert.equal(etaQuality([{ eta: { ...ENGINE, calibrated: true } }, { eta: ENGINE }]), 'uncalibrated');
  assert.equal(etaQuality([{ eta: { ...ENGINE, calibrated: true } }]), 'calibrated');
  assert.equal(etaQuality([{ eta: null }]), 'none');
});

test('mapPoints: only points the API sent, 4 decimals for branch scope', () => {
  const p = plan({ stops: [stop('s1', { assignmentId: 'a1', sequence: 0 }), stop('s2', { pointHidden: 'CONSENT_REQUIRED', lat: null, lng: null }), stop('s3', { pointHidden: 'OUT_OF_SCOPE', lat: null, lng: null })] });
  const company = mapPoints(p, true);
  assert.equal(company.points.length, 1);
  assert.equal(company.hidden, 2);
  assert.equal(company.points[0].lat, 12.912345678);
  assert.equal(company.points[0].position, 1);
  const branch = mapPoints(p, false);
  assert.equal(branch.points[0].lat, 12.9123);
  assert.equal(branch.points[0].lng, 80.1988);
  assert.equal(branch.points[0].label, 'Passenger pickup', 'no address / name on the map for a personal point');
});

test('stopLabel never shows an address for personal points', () => {
  assert.equal(stopLabel(stop('s1', { name: '12 Some Street', passengerName: 'A. B.' })), 'Pickup · A. B.');
  assert.equal(stopLabel(stop('s1', { name: 'Gate 2', personal: false })), 'Gate 2');
});

test('weights are the four solver weights, set explicitly (P6), with the API ranges and rule', () => {
  const d = emptyWeights();
  assert.deepEqual(Object.keys(d).sort(), ['distance', 'routeDuration', 'time', 'vehicle'], 'exactly SolverWeightsDto keys');
  assert.equal(completeWeights(d), null, 'no defaults');
  assert.equal(completeWeights({ ...d, vehicle: 7200, time: 1, distance: 0 }), null, 'every weight must be set');
  assert.equal(parseWeight('', 'time'), null);
  assert.equal(parseWeight('0,5', 'time'), 0.5);
  assert.equal(parseWeight('20000', 'time'), 10_000);
  assert.equal(parseWeight('20000000', 'vehicle'), 10_000_000);
  assert.equal(parseWeight('-3', 'distance'), 0);
  assert.equal(completeWeights({ vehicle: 5000, distance: 0, time: 0, routeDuration: 0 }), null, 'needs distance, time or routeDuration > 0');
  const w = completeWeights({ vehicle: 7200, distance: 0, time: 1, routeDuration: 0 });
  assert.deepEqual(w, { vehicle: 7200, distance: 0, time: 1, routeDuration: 0 });
  assert.equal(solverObjective(w!), 'duration');
  assert.equal(solverObjective({ vehicle: 0, distance: 1, time: 0, routeDuration: 0 }), 'distance');
});

test('publish is offered for DRAFT and PLANNED with a route that has passengers and no blocking violation (B3)', () => {
  assert.equal(publishable(plan({ status: 'DRAFT' })), true, 'DRAFT after optimisation');
  assert.equal(publishable(plan({ status: 'PLANNED' })), true);
  for (const status of ['OPTIMIZING', 'PUBLISHED', 'CANCELLED'] as const) assert.equal(publishable(plan({ status })), false, status);
  assert.equal(publishable(plan({ editable: false })), false);
  assert.equal(publishable(plan({ stops: plan().stops.map((s) => ({ ...s, assignmentId: null })) })), false, 'nothing assigned');
  const over = [{ stopId: 's1', ref: 'S1', kind: 'over_capacity' as const, etaS: null, window: null }, { stopId: 's3', ref: 'S3', kind: 'over_capacity' as const, etaS: null, window: null }];
  assert.equal(publishable(plan({ violations: over })), false, 'every route blocked');
  assert.equal(publishable(plan({ violations: [over[0]] })), true, 'one clean route is enough; the server decides the rest');
  assert.equal(publishable(plan({ violations: [{ stopId: 's1', ref: 'S1', kind: 'late', etaS: 1, window: [0, 0] }, { stopId: 's3', ref: 'S3', kind: 'late', etaS: 1, window: [0, 0] }] })), true, 'warnings do not block');
});

test('compare: Best only where unambiguous, no overall winner without weights', () => {
  assert.deepEqual(bestOf([3, 2, 2], 'min'), [1, 2]);
  assert.deepEqual(bestOf([2, 2], 'min'), [], 'all tie → no marker');
  assert.deepEqual(bestOf([1, 5], null), [], 'ambiguous rows never get a marker');
  assert.deepEqual(bestOf([1, null], 'min'), []);
  assert.equal(deltaPercent(88, 100), '−12 %');
  assert.equal(deltaPercent(105, 100), '+5 %');
  assert.equal(deltaPercent(1, 0), null);
  const a = planMetrics(plan());
  const b = planMetrics(plan({ assignments: [asg('a1'), asg('a2', { distanceM: 50_000 })] }));
  assert.deepEqual(weightedScores([a, b], null), { scores: [null, null], winner: null, missing: [], excluded: [] });
  const r = weightedScores([a, b], { vehicle: 0, distance: 1, time: 0, routeDuration: 0 });
  assert.equal(r.winner, 0);
  assert.deepEqual(r.scores, [15_000, 60_000], 'cost = distance weight × metres');
  const v = weightedScores([a, b], { vehicle: 7200, distance: 0, time: 1, routeDuration: 1 });
  assert.equal(v.scores[0], 7200 * 2 + 2 * 2700);
  const none = planMetrics(plan({ assignments: [asg('a1', { eta: LIVE }), asg('a2', { eta: LIVE })] }));
  assert.deepEqual(weightedScores([a, none], { vehicle: 0, distance: 1, time: 0, routeDuration: 0 }).missing, ['distance']);
  const more = { ...a, unassigned: a.unassigned + 1, distanceM: 1 };
  const x = weightedScores([a, more], { vehicle: 0, distance: 1, time: 0, routeDuration: 0 });
  assert.deepEqual(x.excluded, [1], 'more unassigned passengers never wins on cost');
  assert.equal(x.winner, 0);
});

test('explicit edits: up / down, move, passenger pickup + drop move together', () => {
  const p = plan();
  const r = routesOf(p);
  assert.deepEqual(r, [{ assignmentId: 'a1', stopIds: ['s1', 's2'] }, { assignmentId: 'a2', stopIds: ['s3'] }]);
  assert.deepEqual(shiftStop(r, 's2', -1)[0].stopIds, ['s2', 's1']);
  assert.deepEqual(shiftStop(r, 's1', -1), r, 'no-op at the top');
  assert.deepEqual(moveStop(r, 's1', 'a2', 0)[1].stopIds, ['s1', 's3']);
  assert.deepEqual(changedRoutes(r, shiftStop(r, 's2', -1)), [{ assignmentId: 'a1', stopIds: ['s2', 's1'] }]);
  const stops = [
    { id: 'p1', bookingId: 'b1', stopKind: 'PICKUP' as const },
    { id: 'd1', bookingId: 'b1', stopKind: 'DROP' as const },
    { id: 'p2', bookingId: 'b2', stopKind: 'PICKUP' as const },
    { id: 'd2', bookingId: 'b2', stopKind: 'DROP' as const },
  ];
  const routes = [{ assignmentId: 'x', stopIds: ['p1', 'd1'] }, { assignmentId: 'y', stopIds: ['p2', 'd2'] }];
  assert.deepEqual(movePassenger(routes, stops, 'p1', 'y'), [{ assignmentId: 'x', stopIds: [] }, { assignmentId: 'y', stopIds: ['p2', 'p1', 'd2', 'd1'] }]);
  assert.throws(() => moveStop(r, 's1', 'nope'));
});

test('error kinds and texts (routing unavailable, version conflict)', () => {
  assert.equal(plannerErrorKind('ROUTING_UNAVAILABLE'), 'unavailable');
  assert.equal(plannerErrorKind('ENGINE_UNREACHABLE'), 'unavailable');
  assert.equal(plannerErrorKind('PLAN_STALE'), 'conflict');
  assert.equal(plannerErrorKind(null, 409), 'conflict');
  assert.equal(plannerErrorKind(null, 403), 'forbidden');
  assert.equal(plannerErrorKind('OPTIMIZER_BUSY'), 'busy');
  assert.match(plannerErrorText('ROUTING_UNAVAILABLE') ?? '', /Routing unavailable/);
  assert.equal(plannerErrorText('NOPE'), null);
  assert.equal(unassignedReason('demand_exceeds_vehicle_capacity'), 'More seats than any vehicle has');
  assert.equal(unassignedReason(null), 'Not optimised yet');
  assert.equal(unassignedReason('custom'), 'custom');
});

test('capabilities: engine down blocks optimise with the reason; no worker only warns', () => {
  assert.equal(capabilityView(undefined).canOptimise, false);
  const down = capabilityView({ enabled: true, engineReachable: false, optimizer: true, workers: 1 });
  assert.equal(down.canOptimise, false);
  assert.equal(down.label, 'Routing unavailable');
  assert.equal(capabilityView({ enabled: true, engineReachable: true, optimizer: false, workers: 1 }).canOptimise, false);
  const q = capabilityView({ enabled: true, engineReachable: true, optimizer: true, workers: 0 });
  assert.equal(q.canOptimise, true);
  assert.ok(q.detail);
});

test('plan seeds: one plan per shift; login counts from 2 h before the shift in its zone', () => {
  const shifts = [
    { id: 'm', name: 'Morning', siteId: 'site1', siteName: 'Park', startMin: 540, endMin: 1080, timeZone: 'Asia/Kolkata' },
    { id: 'n', name: 'Night', siteId: 'site2', siteName: 'Tower', startMin: 1320, endMin: 360 },
  ];
  const seeds = planSeeds({ day: '2026-11-12', direction: 'IN', shifts, shiftIds: ['m', 'n'], siteIds: ['site1'], tz: 'UTC' });
  assert.equal(seeds.length, 1, 'site filter');
  assert.equal(seeds[0].sitePoiId, 'site1');
  assert.equal(seeds[0].planStartAt, '2026-11-12T01:30:00.000Z');
  assert.match(seeds[0].name, /Morning · Park$/);
  const out = planSeeds({ day: '2026-11-12', direction: 'OUT', shifts, shiftIds: ['n'], siteIds: [], tz: 'UTC' });
  assert.equal(out[0].planStartAt, '2026-11-12T06:00:00.000Z');
  assert.equal(zonedIso('bad', 0, 'UTC'), null);
});

test('response shapes: edit result and lists', () => {
  const p = plan();
  assert.deepEqual(toEditResult({ plan: p, violations: [] }).plan.id, 'pl');
  assert.equal(toEditResult(p).plan.id, 'pl', 'bare plan accepted');
  assert.deepEqual(toList({ items: [1] }), [1]);
  assert.deepEqual(toList([2]), [2]);
  assert.deepEqual(toList(null), []);
  assert.equal(mergeViolations([{ stopId: 'a', ref: 'A', kind: 'late', etaS: 1, window: null }], [{ stopId: 'a', ref: 'A', kind: 'late', etaS: 2, window: null }])[0].etaS, 2);
});

test('compare DTO metrics (server) with ride times from the detail of the same version', () => {
  const own = planMetrics(plan());
  const m = metricsFromCompare({ planId: 'pl', name: 'P', planDate: '2026-11-12', status: 'PLANNED', version: 3, routes: 3, activeRoutes: 2, stops: 4, passengers: 4, seats: 3, unassigned: 1, distanceM: 15000, durationS: 2700, seatUtilisation: 0.375, violations: 0, graphVersion: 'gh' }, own);
  assert.equal(m.vehiclesUsed, 2);
  assert.equal(m.vehiclesTotal, 3);
  assert.equal(m.seats, 8);
  assert.equal(m.maxRideS, own.maxRideS);
  const bare = metricsFromCompare({ planId: 'x', name: 'X', planDate: '2026-11-12', status: 'PLANNED', version: 1, routes: 1, activeRoutes: 1, stops: 1, passengers: 1, seats: 1, unassigned: 0, distanceM: null, durationS: null, seatUtilisation: null, violations: 0, graphVersion: null });
  assert.equal(bare.maxRideS, null);
  assert.equal(bare.seats, null);
  assert.equal(bare.etaQuality, 'none', 'no engine numbers → no ETA quality claimed');
});

test('T2 E2E: unassigned counts passengers, not stops (IN plan: pickup + office drop per booking)', () => {
  const p = plan({
    stops: [
      stop('p1', { assignmentId: 'a1', sequence: 0, etaS: 300 }),
      stop('d1', { assignmentId: 'a1', sequence: 1, etaS: 900, stopKind: 'DROP', bookingId: 'b-p1', personal: false }),
      stop('p2', { unassignedReason: 'not_scheduled_capacity_or_time' }),
      stop('d2', { unassignedReason: 'not_scheduled_capacity_or_time', stopKind: 'DROP', bookingId: 'b-p2', personal: false }),
      stop('p3', { unassignedReason: 'unreachable_location' }),
      stop('d3', { unassignedReason: 'unreachable_location', stopKind: 'DROP', bookingId: 'b-p3', personal: false }),
    ],
  });
  const m = planMetrics(p);
  assert.equal(m.passengers, 3);
  assert.equal(m.unassigned, 2, 'two passengers without a seat, not four stops (was "4 / 3")');
  assert.deepEqual(m.unassignedByReason, { not_scheduled_capacity_or_time: 1, unreachable_location: 1 });
  assert.deepEqual(unassignedPassengers(p.stops, 'IN').map((s) => s.id), ['p2', 'p3'], 'one row per passenger (its pickup); the office drop is not a passenger');
  // OUT: the passenger end is the drop (home)
  const out = plan({ direction: 'OUT', stops: [stop('p4', { unassignedReason: 'no_solution_found', personal: false }), stop('d4', { unassignedReason: 'no_solution_found', stopKind: 'DROP', bookingId: 'b-p4' })] });
  assert.equal(planMetrics(out).unassigned, 1);
  assert.deepEqual(unassignedPassengers(out.stops, 'OUT').map((s) => s.id), ['d4']);
  // compare: the server counts stops; the detail of the same version counts passengers
  const own = planMetrics(p);
  const cmp = metricsFromCompare({ planId: 'pl', name: 'P', planDate: '2026-11-12', status: 'PLANNED', version: 3, routes: 2, activeRoutes: 1, stops: 6, passengers: 3, seats: 1, unassigned: 4, distanceM: 10000, durationS: 1800, seatUtilisation: 0.25, violations: 0, graphVersion: 'gh' }, own);
  assert.equal(cmp.unassigned, 2, 'compare shows passengers too when the detail is at hand');
});

test('T2 E2E: bookings left out of a new plan are summarised by reason', () => {
  assert.deepEqual(skippedSummary([]), []);
  assert.deepEqual(
    skippedSummary([
      { bookingId: 'b1', reason: 'consent_required' },
      { bookingId: 'b2', reason: 'needs_location' },
      { bookingId: 'b3', reason: 'consent_required' },
      { bookingId: 'b4', reason: 'out_of_scope' },
    ]),
    [
      { reason: 'consent_required', label: 'Passenger consent missing', n: 2 },
      { reason: 'needs_location', label: 'Pickup or drop point missing', n: 1 },
      { reason: 'out_of_scope', label: 'Outside your branches', n: 1 },
    ],
  );
  assert.deepEqual(skippedSummary([{ bookingId: 'b9', reason: 'something_new' }]), [{ reason: 'something_new', label: 'something_new', n: 1 }]);
});

test('T2 E2E: after a reload an optimising plan finds its running job from the server', () => {
  const jobs = [
    { jobId: 'old', state: 'succeeded', planId: 'pl' },
    { jobId: 'run', state: 'running', planId: 'pl' },
  ] as never;
  assert.equal(activeJobId({ status: 'OPTIMIZING', lastJobId: null }, null, jobs), 'run', 'no local job id (page reloaded): take the open job of the plan');
  assert.equal(activeJobId({ status: 'OPTIMIZING', lastJobId: null }, 'mine', jobs), 'mine', 'the job started on this page wins');
  assert.equal(activeJobId({ status: 'PLANNED', lastJobId: null }, null, jobs), null, 'not optimising: no progress card');
  assert.equal(activeJobId({ status: 'OPTIMIZING', lastJobId: null }, null, []), null);
});
