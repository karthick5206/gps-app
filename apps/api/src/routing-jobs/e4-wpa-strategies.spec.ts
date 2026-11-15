import { HttpException } from '@nestjs/common';
import { ROUTING_STRATEGIES, ROUTING_STRATEGY_INFO } from '@veetracer/shared';
import { mapSolverResult, planPoints, solverProblem } from './optimize-problem';
import { weightsOf } from './prisma-plan-gateway';
import { checkWeights } from './routing-jobs.service';
import { checkPreferenceMaxRide, checkPreferences, detourGuardOf, occupancyFactor, resolveOptimisation, runLockSets, runMaxRideS, STRATEGY_WEIGHTS, vehicleFixedCosts } from './strategies';
import { syntheticPlan, testMatrix } from './testing/fakes';
import { availabilityOf, chooseWindow, freeIntervals } from './vehicle-availability';

const codeOf = (f: () => unknown) => {
  try {
    f();
    return 'OK';
  } catch (e) {
    return e instanceof HttpException ? `${e.getStatus()} ${(e.getResponse() as { code?: string }).code}` : String(e);
  }
};

describe('E4 WP-A strategies', () => {
  it('maps every strategy to the documented weights; each has an explanation', () => {
    expect(STRATEGY_WEIGHTS).toEqual({
      BALANCED: { vehicle: 3600, distance: 0, time: 2, routeDuration: 0, rideTime: 1 },
      FEWER_VEHICLES: { vehicle: 20000, distance: 0, time: 1, routeDuration: 0, rideTime: 0 },
      SHORTEST_DISTANCE: { vehicle: 2000, distance: 1, time: 0, routeDuration: 0, rideTime: 0 },
      FASTEST: { vehicle: 120, distance: 0, time: 1, routeDuration: 0, rideTime: 0 },
      COMFORT: { vehicle: 1800, distance: 0, time: 1, routeDuration: 0, rideTime: 2 },
    });
    for (const s of ROUTING_STRATEGIES) {
      expect(() => checkWeights(STRATEGY_WEIGHTS[s])).not.toThrow();
      expect(ROUTING_STRATEGY_INFO[s].tradeOffs.length).toBeGreaterThan(10);
    }
  });

  it('default BALANCED; raw weights win over a strategy (recorded); occupancy scales the vehicle weight', () => {
    expect(resolveOptimisation({})).toMatchObject({ strategy: 'BALANCED', weightsSource: 'strategy', weights: STRATEGY_WEIGHTS.BALANCED });
    const raw = { vehicle: 7200, distance: 0, time: 1, routeDuration: 0 };
    expect(resolveOptimisation({ strategy: 'COMFORT', weights: raw })).toMatchObject({ strategy: 'COMFORT', weightsSource: 'weights', weights: raw });
    expect(resolveOptimisation({ weights: raw }).strategy).toBeNull();
    expect([0.5, 0.75, 1].map(occupancyFactor)).toEqual([0.5, 1, 2]);
    expect(resolveOptimisation({ strategy: 'FASTEST', preferences: { preferredOccupancy: 1 } }).weights.vehicle).toBe(240);
    expect(codeOf(() => resolveOptimisation({ strategy: 'NOPE' }))).toBe('400 VALIDATION_FAILED');
  });

  it('backward compatible weights: stored weights without rideTime stay valid; rideTime kept when given', () => {
    const old = { vehicle: 7200, distance: 0, time: 1, routeDuration: 0 };
    expect(weightsOf(old)).toEqual(old);
    expect(checkWeights(old)).toEqual(old);
    expect(weightsOf({ ...old, rideTime: 2 })).toEqual({ ...old, rideTime: 2 });
    expect(weightsOf({ ...old, rideTime: -1 })).toBeUndefined();
    expect(codeOf(() => checkWeights({ ...old, rideTime: -1 }))).toBe('400 VALIDATION_FAILED');
  });
});

describe('E4 WP-A preferences', () => {
  it('validates bounds and drops unknown keys', () => {
    expect(checkPreferences({ maxRideS: 1800, detourGuard: { ratio: 1.5, extraMin: 5 }, preferredOccupancy: 0.8, vehicleSize: 'SMALLER', groupingPreference: 'KEEP_DIRECTIONS', preservePins: false, x: 1 })).toEqual({
      maxRideS: 1800,
      detourGuard: { ratio: 1.5, extraMin: 5 },
      preferredOccupancy: 0.8,
      vehicleSize: 'SMALLER',
      groupingPreference: 'KEEP_DIRECTIONS',
      preservePins: false,
    });
    for (const bad of [{ maxRideS: 60 }, { detourGuard: { ratio: 1.1, extraMin: 5 } }, { detourGuard: { ratio: 2, extraMin: 61 } }, { preferredOccupancy: 0.4 }, { vehicleSize: 'HUGE' }, { preserveLocks: 'no' }]) {
      expect(codeOf(() => checkPreferences(bad))).toBe('400 VALIDATION_FAILED');
    }
  });

  it('max ride: never above the effective policy / override; tighter is fine; no policy = any bounded value', () => {
    expect(codeOf(() => checkPreferenceMaxRide({ maxRideS: 3600 }, 2700))).toBe('400 MAX_RIDE_ABOVE_POLICY');
    expect(codeOf(() => checkPreferenceMaxRide({ maxRideS: 2700 }, 2700))).toBe('OK');
    expect(codeOf(() => checkPreferenceMaxRide({ maxRideS: 1800 }, null))).toBe('OK');
    expect(runMaxRideS(2700, { maxRideS: 1800 })).toBe(1800);
    expect(runMaxRideS(1800, { maxRideS: 2700 })).toBe(1800); // never loosened
    expect(runMaxRideS(null, { maxRideS: 2700 })).toBe(2700);
  });

  it('detour guard: explicit, KEEP_DIRECTIONS default 1.6 / +10 min, cost fixed server-side', () => {
    expect(detourGuardOf({ detourGuard: { ratio: 2, extraMin: 15 } })).toEqual({ ratio: 2, extraS: 900, costPerS: 20 });
    expect(detourGuardOf({ groupingPreference: 'KEEP_DIRECTIONS' })).toEqual({ ratio: 1.6, extraS: 600, costPerS: 20 });
    expect(detourGuardOf({ groupingPreference: 'ALLOW_MIXED_DIRECTIONS' })).toBeNull();
  });

  it('vehicle size: SMALLER makes big vehicles dearer, LARGER cheaper (clamped); ANY / no seats → none', () => {
    const v = [
      { assignmentId: 'a', capacity: 4 },
      { assignmentId: 'b', capacity: 12 },
      { assignmentId: 'c', capacity: null },
    ];
    // average seats 8
    expect(Object.fromEntries(vehicleFixedCosts(v, 1000, 'SMALLER'))).toEqual({ a: 500, b: 1500 });
    expect(Object.fromEntries(vehicleFixedCosts(v, 1000, 'LARGER'))).toEqual({ a: 2000, b: 667 });
    expect(vehicleFixedCosts(v, 1000, 'ANY').size).toBe(0);
    expect(Object.fromEntries(vehicleFixedCosts([{ assignmentId: 'x', capacity: 1 }, { assignmentId: 'y', capacity: 40 }], 100, 'SMALLER'))).toEqual({ x: 25, y: 195 });
  });

  it('pins / locks of the run: preservePins / preserveLocks false release them; published routes stay frozen', () => {
    const o = { lockedAssignmentIds: ['r1'], pinnedStopIds: ['s1'] };
    expect(runLockSets(o)).toEqual({ lockedAssignmentIds: new Set(['r1']), pinnedStopIds: new Set(['s1']) });
    expect(runLockSets({ ...o, preferences: { preservePins: false, preserveLocks: false } }, ['pub'])).toEqual({ lockedAssignmentIds: new Set(['pub']), pinnedStopIds: new Set() });
  });
});

describe('E4 WP-A vehicle availability', () => {
  it('free intervals and the window chosen around the site span', () => {
    expect(freeIntervals([[100, 200], [150, 300]])).toEqual([[0, 100], [300, null]]);
    // IN, arrive in [3000, 3600]: a trip 2000–3300 leaves [0, 2000] (cannot arrive) and [3300, ∞) (300 s before 3600).
    expect(chooseWindow([[2000, 3300]], 'IN', [3000, 3600])).toEqual([3300, null]);
    expect(chooseWindow([[0, 4000]], 'IN', [3000, 3600])).toBeNull();
    // OUT, leave in [3000, 3600]: a later trip at 5000 → [0, 5000].
    expect(chooseWindow([[5000, 6000]], 'OUT', [3000, 3600])).toEqual([0, 5000]);
  });

  it('busy vehicle → VEHICLE_BUSY, busy driver → DRIVER_BUSY, partly busy → window, free → no entry', () => {
    const t0 = Date.parse('2026-12-01T02:00:00Z');
    const at = (s: number) => new Date(t0 + s * 1000);
    const vehicles = [
      { assignmentId: 'a', objectId: 'oa', driverId: null },
      { assignmentId: 'b', objectId: 'ob', driverId: 'd1' },
      { assignmentId: 'c', objectId: 'oc', driverId: null },
      { assignmentId: 'e', objectId: 'oe', driverId: null },
    ];
    const trips = [
      { objectId: 'oa', driverId: null, plannedStart: at(0), plannedEnd: at(4000) },
      { objectId: 'zz', driverId: 'd1', plannedStart: at(-100), plannedEnd: at(5000) },
      { objectId: 'oc', driverId: null, plannedStart: at(0), plannedEnd: at(1000) },
    ];
    const r = availabilityOf(vehicles, trips, { planStartMs: t0, direction: 'IN', siteSpan: [3000, 3600] });
    expect(r.get('a')).toEqual({ unusable: 'VEHICLE_BUSY' });
    expect(r.get('b')).toEqual({ unusable: 'DRIVER_BUSY' });
    expect(r.get('c')).toEqual({ window: [1000, null] });
    expect(r.has('e')).toBe(false);
  });
});

describe('E4 WP-A solver mapping', () => {
  it('solverProblem sends rideTime, detourGuard, per-vehicle fixedCost and the availability window', () => {
    const inp = syntheticPlan({
      solver: { weights: STRATEGY_WEIGHTS.COMFORT },
      detourGuard: { ratio: 1.6, extraS: 600, costPerS: 20 },
      vehicleSize: 'SMALLER',
      vehicles: [
        { assignmentId: 'veh-a', label: 'A', capacity: 4, type: 'VAN', wheelchairSpaces: 0, availability: [1200, null] },
        { assignmentId: 'veh-b', label: 'B', capacity: 12, type: 'BUS', wheelchairSpaces: 0 },
      ],
    });
    const b = planPoints(inp);
    const p = solverProblem(inp, b, testMatrix(b.points.length), { timeLimitS: 5 });
    expect(p.options.weights.rideTime).toBe(2);
    expect(p.trip?.detourGuard).toEqual({ ratio: 1.6, extraS: 600, costPerS: 20 });
    expect(p.vehicles[0]).toMatchObject({ fixedCost: 900, timeWindow: [1200, p.horizonS] });
    expect(p.vehicles[1]).toMatchObject({ fixedCost: 2700 });
    expect(p.vehicles[1].timeWindow).toBeUndefined();
    // Without preferences nothing new is sent (current solver unchanged).
    const plain = syntheticPlan();
    const q = solverProblem(plain, planPoints(plain), testMatrix(planPoints(plain).points.length), { timeLimitS: 5 });
    expect(q.trip?.detourGuard).toBeUndefined();
    expect(q.vehicles.every((v) => v.fixedCost === undefined && v.timeWindow === undefined)).toBe(true);
  });

  it('FLEET_TOO_SMALL → reason fleet_too_small (site end too), detail kept (known keys); busy vehicles reported', () => {
    const inp = { ...syntheticPlan(), strategy: 'BALANCED', unusableVehicles: [{ vehicleId: 'veh-x', reason: 'VEHICLE_BUSY' }] };
    const b = planPoints(inp);
    const r = mapSolverResult(
      inp,
      b,
      {
        status: 'FEASIBLE',
        provenOptimal: false,
        routes: [{ vehicleId: 'veh-a', startS: 2000, endS: 3300, durationS: 1300, distanceM: 9000, locationSequence: [], load: 2, stops: [1, 2].map((i) => ({ stopId: `pick-${i}`, locationIndex: 0, arrivalS: 2000 + i * 100, serviceStartS: 2000 + i * 100, waitS: 0, departureS: 2060 + i * 100, load: i })) }],
        unassigned: [{ stopId: 'pick-3', reason: 'not_scheduled_capacity_or_time', code: 'FLEET_TOO_SMALL', detail: { binding: ['max_ride'], freeSeats: 2, lat: 13 } }],
        unusableVehicles: [{ vehicleId: 'veh-b', reason: 'availability_outside_site_window' }],
      },
      'gh',
    );
    expect(r.write.unassigned.filter((u) => u.reason === 'fleet_too_small').map((u) => u.stopId).sort()).toEqual(['drop-3', 'pick-3']);
    expect(r.result.unassigned.find((u) => u.stopId === 'pick-3')).toEqual({ stopId: 'pick-3', reason: 'fleet_too_small', code: 'FLEET_TOO_SMALL', detail: { binding: ['max_ride'], freeSeats: 2 } });
    expect(r.result.unusableVehicles).toEqual([{ vehicleId: 'veh-x', reason: 'VEHICLE_BUSY' }, { vehicleId: 'veh-b', reason: 'availability_outside_site_window' }]);
    expect(r.result.strategy).toBe('BALANCED');
  });
});
