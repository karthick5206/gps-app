import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EtaModel, RoutePlanAssignmentDto } from '@veetracer/shared';
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
  type PlannerPlan,
  type PlannerStop,
} from './planner-format.ts';

const ENGINE: EtaModel = { source: 'engine_free_flow', calibrated: false, liveTraffic: false, graphVersion: 'gh', band: null, factor: 1, factorSource: null };
const LIVE: EtaModel = { ...ENGINE, source: 'live_heuristic' };

function stop(id: string, over: Partial<PlannerStop> = {}): PlannerStop {
  return {
    id, ref: id.toUpperCase(), name: null, lat: 12.912345678, lng: 80.198765432, snappedLat: null, snappedLng: null, snapDistanceM: null,
    demand: 1, serviceS: 60, timeWindows: null, assignmentId: null, sequence: null, etaS: null, unassignedReason: null,
    stopKind: 'PICKUP', bookingId: `b-${id}`, profileId: 'p', poiId: null, customerCompanyId: null, personal: true, ...over,
  };
}
function asg(id: string, over: Partial<RoutePlanAssignmentDto> = {}): RoutePlanAssignmentDto {
  return { id, seq: 0, vehicleLabel: id, objectId: `o-${id}`, driverId: null, capacity: 4, distanceM: 10_000, durationS: 1800, adjustedDurationS: 1800, startS: 0, endS: 2400, geometry: { type: 'LineString', coordinates: [[80.1, 12.9], [80.2, 12.95]] }, eta: ENGINE, transportTripId: null, ...over };
}
function plan(over: Partial<PlannerPlan> = {}): PlannerPlan {
  return {
    id: 'pl', name: 'P', planDate: '2026-11-12', planStartAt: '2026-11-12T01:30:00.000Z', status: 'PLANNED', profile: 'car', branchId: null, graphVersion: 'gh', depot: { lat: 12.9, lng: 80.2 },
    direction: 'IN', shiftId: 's', sitePoiId: 'site', version: 3, publishedAt: null, createdAt: '', updatedAt: '',
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
  const p = plan({ stops: [stop('s1', { assignmentId: 'a1', sequence: 0 }), stop('s2', { pointHidden: true }), stop('s3', { lat: Number.NaN, lng: Number.NaN })] });
  const company = mapPoints(p, 'COMPANY');
  assert.equal(company.points.length, 1);
  assert.equal(company.hidden, 2);
  assert.equal(company.points[0].lat, 12.912345678);
  assert.equal(company.points[0].position, 1);
  const branch = mapPoints(p, 'ASSIGNED');
  assert.equal(branch.points[0].lat, 12.9123);
  assert.equal(branch.points[0].lng, 80.1988);
  assert.equal(branch.points[0].label, 'Passenger pickup', 'no address / name on the map for a personal point');
});

test('stopLabel never shows an address for personal points', () => {
  assert.equal(stopLabel(stop('s1', { name: '12 Some Street', passengerName: 'A. B.' })), 'Pickup · A. B.');
  assert.equal(stopLabel(stop('s1', { name: 'Gate 2', personal: false })), 'Gate 2');
});

test('weights must be set explicitly (P6); objective follows them', () => {
  const d = emptyWeights();
  assert.equal(completeWeights(d), null);
  assert.equal(parseWeight(''), null);
  assert.equal(parseWeight('12'), 10);
  assert.equal(parseWeight('-3'), 0);
  assert.equal(completeWeights({ vehicles: 0, distance: 0, driveTime: 0, maxRide: 0, unassigned: 0 }), null, 'all zero is no objective');
  const w = completeWeights({ vehicles: 3, distance: 5, driveTime: 2, maxRide: 4, unassigned: 10 });
  assert.ok(w);
  assert.equal(solverObjective(w), 'distance');
  assert.equal(solverObjective({ ...w, driveTime: 5 }), 'duration');
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
  assert.deepEqual(weightedScores([a, b], null), { scores: [null, null], winner: null, missing: [] });
  const r = weightedScores([a, b], { vehicles: 0, distance: 10, driveTime: 0, maxRide: 0, unassigned: 0 });
  assert.equal(r.winner, 0);
  const none = planMetrics(plan({ assignments: [asg('a1', { eta: LIVE }), asg('a2', { eta: LIVE })] }));
  assert.deepEqual(weightedScores([a, none], { vehicles: 0, distance: 10, driveTime: 0, maxRide: 0, unassigned: 0 }).missing, ['distance']);
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
