import { DEFAULT_SHARING_LIMITS, type SharingLimits } from '@veetracer/shared';
import { buildPlanChangeSet, type PublishBooking, type RuleStop } from '../planning/plan-rules';
import { splitRouteTrips } from '../planning/plan-trip-split';
import { buildPdpProblem, verifyPdp } from '../../routing-jobs/pdp-problem';
import type { PdpResult } from '../../routing-jobs/pdp-contract';
import { cheapestInsertion, insertionOps, newTripTiming, type InsertionRequest, type InsertionTrip } from './insertion';
import { activeEditProblem, defaultPreference, joinProblem, limitsChangeProblem, limitsSnapshot, LimitsError, liveChangeAllowed, needsAcceptance, partyCount, privateExclusivityProblem, sameLimits, servedAs } from './pooling-rules';
import { driverHoursProblems, vehicleTimelineProblem } from './timeline-rules';

const MIN = 60_000;
const T0 = Date.parse('2026-12-01T08:00:00Z');
const policy = { SHARED: { ...DEFAULT_SHARING_LIMITS }, FLEXIBLE: { maxWaitS: 1200, maxDetour: { ratio: 2, extraS: 1200 }, maxRideS: null } };

describe('ride-mode eligibility (P1: private is never shared)', () => {
  it('a PRIVATE booking only joins an empty trip, and nobody joins a trip carrying a PRIVATE booking', () => {
    expect(joinProblem('PRIVATE', [])).toBeNull();
    expect(joinProblem('PRIVATE', ['SHARED'])).toBe('PRIVATE_NEEDS_EMPTY_VEHICLE');
    expect(joinProblem('SHARED', ['PRIVATE'])).toBe('PRIVATE_TRIP');
    expect(joinProblem('FLEXIBLE', ['PRIVATE'])).toBe('PRIVATE_TRIP');
    expect(joinProblem('FLEXIBLE', ['SHARED', 'FLEXIBLE'])).toBeNull();
  });

  it('the publish re-check refuses a private booking sharing its trip; its own group is one party', () => {
    expect(privateExclusivityProblem([{ bookingId: 'p', ridePreference: 'PRIVATE' }])).toBeNull();
    expect(privateExclusivityProblem([{ bookingId: 'p', ridePreference: 'PRIVATE' }, { bookingId: 's', ridePreference: 'SHARED' }])).toBe('p');
    expect(privateExclusivityProblem([{ bookingId: 'p1', ridePreference: 'PRIVATE', groupId: 'g' }, { bookingId: 'p2', ridePreference: 'PRIVATE', groupId: 'g' }])).toBeNull();
    expect(privateExclusivityProblem([{ bookingId: 's1', ridePreference: 'SHARED' }, { bookingId: 's2', ridePreference: 'FLEXIBLE' }])).toBeNull();
    expect(partyCount([{ bookingId: 'a', groupId: 'g' }, { bookingId: 'b', groupId: 'g' }, { bookingId: 'c' }])).toBe(2);
  });

  it('served as: PRIVATE when asked or alone, else SHARED (FLEXIBLE either way)', () => {
    expect(servedAs('PRIVATE', 1)).toBe('PRIVATE');
    expect(servedAs('FLEXIBLE', 1)).toBe('PRIVATE');
    expect(servedAs('FLEXIBLE', 3)).toBe('SHARED');
    expect(servedAs('SHARED', 2)).toBe('SHARED');
  });

  it('defaults (P3) and acceptance: commute pooled, point-to-point private; shared P2P needs the policy accepted', () => {
    expect(defaultPreference('COMMUTE')).toBe('SHARED');
    expect(defaultPreference('POINT_TO_POINT')).toBe('PRIVATE');
    expect(needsAcceptance('SHARED', 'POINT_TO_POINT')).toBe(true);
    expect(needsAcceptance('FLEXIBLE', 'POINT_TO_POINT')).toBe(true);
    expect(needsAcceptance('PRIVATE', 'POINT_TO_POINT')).toBe(false);
    expect(needsAcceptance('SHARED', 'COMMUTE')).toBe(false);
  });
});

describe('limits snapshot (immutable, tighten only)', () => {
  it('takes the policy limits for the preference, capped by the company max ride', () => {
    expect(limitsSnapshot('SHARED', policy, undefined, 3600)).toEqual({ maxWaitS: 900, maxDetour: { ratio: 1.8, extraS: 900 }, maxRideS: 3600 });
    expect(limitsSnapshot('FLEXIBLE', policy, undefined, null)).toEqual({ maxWaitS: 1200, maxDetour: { ratio: 2, extraS: 1200 }, maxRideS: null });
    // PRIVATE: nobody else rides, so no detour allowance.
    expect(limitsSnapshot('PRIVATE', policy, undefined, null).maxDetour).toEqual({ ratio: 1, extraS: 0 });
  });

  it('a passenger may tighten but never loosen the policy', () => {
    expect(limitsSnapshot('SHARED', policy, { maxWaitS: 300, maxDetour: { ratio: 1.3 } }, 3600)).toEqual({ maxWaitS: 300, maxDetour: { ratio: 1.3, extraS: 900 }, maxRideS: 3600 });
    expect(() => limitsSnapshot('SHARED', policy, { maxWaitS: 1800 }, null)).toThrow(LimitsError);
    expect(() => limitsSnapshot('SHARED', policy, { maxRideS: 7200 }, 3600)).toThrow(/above the sharing policy/);
    expect(() => limitsSnapshot('SHARED', policy, { maxDetour: { extraS: 2000 } }, null)).toThrow(LimitsError);
  });

  it('once accepted on an active booking, limits / preference / policy version cannot change', () => {
    const limits: SharingLimits = { maxWaitS: 900, maxDetour: { ratio: 1.8, extraS: 900 }, maxRideS: 3600 };
    const before = { limits, ridePreference: 'SHARED' as const, sharingPolicyVersion: 2, active: true };
    expect(limitsChangeProblem(before, { limits: { ...limits } })).toBeNull();
    expect(limitsChangeProblem(before, { limits: { ...limits, maxWaitS: 1200 } })).toMatch(/cannot change/);
    expect(limitsChangeProblem(before, { ridePreference: 'PRIVATE' })).toMatch(/cannot change/);
    expect(limitsChangeProblem(before, { sharingPolicyVersion: 3 })).toMatch(/cannot change/);
    // A finished booking or a pre-pooling row (no snapshot) is not guarded.
    expect(limitsChangeProblem({ ...before, active: false }, { limits: null })).toBeNull();
    expect(limitsChangeProblem({ ...before, limits: null }, { ridePreference: 'PRIVATE' })).toBeNull();
    expect(sameLimits(limits, { maxRideS: 3600, maxDetour: { extraS: 900, ratio: 1.8 }, maxWaitS: 900 })).toBe(true);
  });
});

describe('commitment protection per trip state (§5.2, P4 / P5)', () => {
  it('unpublished and SCHEDULED: any op, automatic; ACTIVE: pending-stop ops only, dispatcher only; closed: nothing', () => {
    expect(liveChangeAllowed('UNPUBLISHED', 'REASSIGN_VEHICLE')).toEqual({ allowed: true, auto: true });
    expect(liveChangeAllowed('SCHEDULED', 'ADD_STOP')).toEqual({ allowed: true, auto: true });
    expect(liveChangeAllowed('STARTED', 'ADD_STOP')).toEqual({ allowed: true, auto: false });
    expect(liveChangeAllowed('IN_PROGRESS', 'REMOVE_PASSENGER')).toEqual({ allowed: true, auto: false });
    expect(liveChangeAllowed('IN_PROGRESS', 'REASSIGN_VEHICLE')).toEqual({ allowed: false, auto: false });
    expect(liveChangeAllowed('COMPLETED', 'ADD_PASSENGER')).toEqual({ allowed: false, auto: false });
    expect(liveChangeAllowed('CANCELLED', 'ADD_STOP')).toEqual({ allowed: false, auto: false });
  });

  it('visited stops are immutable on a started trip', () => {
    const stops = [{ seq: 0, status: 'DEPARTED' }, { seq: 1, status: 'ARRIVED' }, { seq: 2, status: 'PENDING' }, { seq: 3, status: 'PENDING' }];
    expect(activeEditProblem(stops, { kind: 'ADD_STOP', afterSeq: 0 })).toMatch(/after the stops/);
    expect(activeEditProblem(stops, { kind: 'ADD_STOP', afterSeq: 1 })).toBeNull();
    expect(activeEditProblem(stops, { kind: 'ADD_PASSENGER', pickupSeq: 1, dropSeq: 3 })).toMatch(/not visited/);
    expect(activeEditProblem(stops, { kind: 'ADD_PASSENGER', pickupSeq: 2, dropSeq: 3 })).toBeNull();
  });
});

// A straight-line 1 km ≈ 2 min world: travel = |Δlat| in units of 0.01° × 120 s (deterministic, no geodesy).
const travel = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => Math.round((Math.abs(a.lat - b.lat) + Math.abs(a.lng - b.lng)) * 100 * 120);
const stop = (seq: number, lat: number, atMin: number, visited = false) => ({ seq, lat, lng: 0, poiId: null, arrivalMs: T0 + atMin * MIN, departureMs: T0 + atMin * MIN + MIN, visited });
const trip = (over: Partial<InsertionTrip> = {}): InsertionTrip => ({
  tripId: 't1',
  objectId: 'v1',
  status: 'SCHEDULED',
  seatCapacity: 4,
  occupied: 1,
  // 0 → 0.10 over 30 min: a lot of slack between the stops.
  stops: [stop(0, 0, 0), stop(1, 0.1, 30)],
  onTrip: ['SHARED'],
  prevEndMs: null,
  nextStartMs: null,
  turnaroundS: 120,
  ...over,
});
const request = (over: Partial<InsertionRequest> = {}): InsertionRequest => ({
  bookingId: 'b-new',
  seats: 1,
  preference: 'SHARED',
  pickup: { lat: 0.02, lng: 0, poiId: null },
  drop: { lat: 0.06, lng: 0, poiId: null },
  windowStartMs: T0,
  windowEndMs: T0 + 60 * MIN,
  limits: { ...DEFAULT_SHARING_LIMITS },
  companyMaxRideS: null,
  ...over,
});

describe('in-process insertion (fallback): slack only, committed stops never move', () => {
  it('inserts pickup and drop between the existing stops without touching their times', () => {
    const t = trip();
    const r = cheapestInsertion(t, request(), travel, T0 - 60 * MIN);
    expect(r.feasible).toBe(true);
    if (!r.feasible) return;
    expect(r.pickupAfter).toBe(0);
    // Pickup after stop 0's departure + travel; drop before stop 1's planned arrival (minus travel), inside the window.
    expect(r.pickupArrivalMs).toBeGreaterThanOrEqual(t.stops[0].departureMs);
    expect(r.dropArrivalMs + 60_000 + travel(request().drop, t.stops[1]) * 1000).toBeLessThanOrEqual(t.stops[1].arrivalMs);
    const ops = insertionOps('t1', 'b-new', r);
    expect(ops.map((o) => o.op)).toEqual(['ADD_STOP', 'ADD_STOP', 'ADD_PASSENGER']);
    const add = ops[2] as { pickupSeq: number; dropSeq: number };
    expect(add.pickupSeq).toBe(1);
    expect(add.dropSeq).toBe(2);
    expect(t.stops.map((s) => s.arrivalMs)).toEqual([T0, T0 + 30 * MIN]);
  });

  it('refuses when the only way would delay a committed stop (no slack)', () => {
    const tight = trip({ stops: [stop(0, 0, 0), stop(1, 0.1, 13)] }); // 0 → 0.1 needs 12 min: 1 min of slack
    const r = cheapestInsertion(tight, request({ pickup: { lat: 0.05, lng: 0.05, poiId: null }, drop: { lat: 0.07, lng: 0.05, poiId: null } }), travel, T0 - 60 * MIN);
    // The detour cannot fit between the stops; only "after the last stop" remains, which is fine for the others.
    if (r.feasible) expect(r.pickupAfter).toBe(1);
    else expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('respects the pickup window (max wait), capacity, max ride and private rules', () => {
    expect(cheapestInsertion(trip(), request({ windowStartMs: T0 + 120 * MIN, windowEndMs: T0 + 130 * MIN }), travel, T0).feasible).toBe(true); // after the last stop
    const late = cheapestInsertion(trip({ nextStartMs: T0 + 40 * MIN }), request({ windowStartMs: T0 + 120 * MIN, windowEndMs: T0 + 130 * MIN }), travel, T0);
    expect(late.feasible).toBe(false);
    expect(cheapestInsertion(trip({ occupied: 4 }), request(), travel, T0)).toEqual({ feasible: false, reasons: ['CAPACITY'] });
    expect(cheapestInsertion(trip({ onTrip: ['PRIVATE'] }), request(), travel, T0)).toEqual({ feasible: false, reasons: ['PRIVATE_TRIP'] });
    expect(cheapestInsertion(trip(), request({ preference: 'PRIVATE' }), travel, T0)).toEqual({ feasible: false, reasons: ['PRIVATE_NEEDS_EMPTY_VEHICLE'] });
    const short = cheapestInsertion(trip(), request({ limits: { ...DEFAULT_SHARING_LIMITS, maxRideS: 300 }, drop: { lat: 0.09, lng: 0, poiId: null } }), travel, T0);
    expect(short.feasible).toBe(false);
  });

  it('never inserts before a visited stop of a started trip', () => {
    const started = trip({ status: 'IN_PROGRESS', stops: [stop(0, 0, 0, true), stop(1, 0.1, 30)] });
    const r = cheapestInsertion(started, request(), travel, T0 + 2 * MIN);
    expect(r.feasible).toBe(true);
    if (r.feasible) expect(r.pickupAfter).toBeGreaterThanOrEqual(0);
  });

  it('a new trip on an idle vehicle needs the window and a free vehicle (turnaround included)', () => {
    const now = T0 - 60 * MIN;
    expect(newTripTiming(request(), { pos: null, busy: [], turnaroundS: 120 }, travel, now)).not.toBeNull();
    expect(newTripTiming(request(), { pos: null, busy: [{ start: T0, end: T0 + 30 * MIN }], turnaroundS: 120 }, travel, now)).toBeNull();
    expect(newTripTiming(request({ windowEndMs: T0 + 5 * MIN, limits: { ...DEFAULT_SHARING_LIMITS, maxWaitS: 300 } }), { pos: null, busy: [], turnaroundS: 120 }, travel, T0)).toBeNull();
  });
});

describe('trip splitting (AREA plans: one trip per tripIndex)', () => {
  const s = (id: string, sequence: number, tripIndex: number, bookingId: string, stopKind: 'PICKUP' | 'DROP') => ({ id, sequence, tripIndex, bookingId, stopKind });

  it('splits a route by tripIndex and refuses a booking split across trips or out of order', () => {
    const ok = splitRouteTrips([s('a', 1, 0, 'b1', 'PICKUP'), s('b', 2, 0, 'b1', 'DROP'), s('c', 3, 1, 'b2', 'PICKUP'), s('d', 4, 1, 'b2', 'DROP')]);
    expect(ok.problem).toBeNull();
    expect(ok.trips.map((t) => [t.tripIndex, t.stops.map((x) => x.id)])).toEqual([
      [0, ['a', 'b']],
      [1, ['c', 'd']],
    ]);
    expect(splitRouteTrips([s('a', 1, 0, 'b1', 'PICKUP'), s('b', 2, 1, 'b1', 'DROP')]).problem).toMatch(/different trips/);
    expect(splitRouteTrips([s('a', 1, 1, 'b1', 'PICKUP'), s('b', 2, 0, 'b2', 'DROP')]).problem).toMatch(/out of order/);
    expect(splitRouteTrips([s('b', 1, 0, 'b1', 'DROP'), s('a', 2, 0, 'b1', 'PICKUP')]).problem).toMatch(/before its pickup/);
  });

  it('an AREA route with two trips becomes two CREATE_TRIPs with their own passengers', () => {
    const plan0 = T0;
    const booking = (id: string, lat: number): PublishBooking => ({ id, status: 'PENDING_ASSIGNMENT', serviceDate: new Date('2026-12-01T00:00:00Z'), direction: null, journey: 'POINT_TO_POINT', passengerCount: 1, profileId: `p-${id}`, pickupLat: lat, pickupLng: 80, pickupPoiId: null, pickupLabel: null, dropLat: lat + 0.05, dropLng: 80, dropPoiId: null, dropLabel: null });
    const rs = (id: string, seq: number, tripIndex: number, bookingId: string, kind: 'PICKUP' | 'DROP', lat: number, etaS: number): RuleStop => ({ id, ref: `${kind === 'PICKUP' ? 'p' : 'd'}-${bookingId}`, assignmentId: 'a1', sequence: seq, etaS, serviceS: 60, demand: kind === 'PICKUP' ? 1 : 0, timeWindows: null, stopKind: kind, bookingId, profileId: `p-${bookingId}`, poiId: null, lat, lng: 80, name: null, tripIndex });
    const bookings = new Map([
      ['b1', booking('b1', 13)],
      ['b2', booking('b2', 13.2)],
    ]);
    const stops = [rs('s1', 1, 0, 'b1', 'PICKUP', 13, 600), rs('s2', 2, 0, 'b1', 'DROP', 13.05, 1500), rs('s3', 3, 1, 'b2', 'PICKUP', 13.2, 2400), rs('s4', 4, 1, 'b2', 'DROP', 13.25, 3300)];
    const cs = buildPlanChangeSet(
      { id: 'plan', name: 'Area', planDate: new Date('2026-12-01T00:00:00Z'), planStartAt: new Date(plan0), direction: null, shiftId: null, sitePoiId: null, scope: 'AREA' },
      [{ id: 'a1', seq: 0, vehicleLabel: 'Van', objectId: 'v1', driverId: null, startS: 0, endS: 3360, seats: 4 }],
      stops,
      bookings,
      new Map(),
      new Set(['p-b1', 'p-b2']),
    );
    expect(cs.errors).toEqual([]);
    const creates = cs.input.changes.filter((c) => c.op === 'CREATE_TRIP');
    expect(creates).toHaveLength(2);
    expect(cs.tripRefs.map((r) => [r.assignmentId, r.tripIndex])).toEqual([
      ['a1', 0],
      ['a1', 1],
    ]);
    const adds = cs.input.changes.filter((c) => c.op === 'ADD_PASSENGER') as { tripId: string; bookingId: string }[];
    expect(adds.map((a) => [a.tripId, a.bookingId])).toEqual([
      [cs.tripRefs[0].tempId, 'b1'],
      [cs.tripRefs[1].tempId, 'b2'],
    ]);
  });
});

describe('driver working hours and vehicle timeline (C1)', () => {
  const h = (x: number) => T0 + x * 3_600_000;
  it('no policy (P7 default): nothing is checked', () => {
    expect(driverHoursProblems([{ start: h(0), end: h(20) }], null)).toEqual([]);
  });

  it('duty span, total driving and continuous driving without a break', () => {
    const policy = { maxDutyS: 10 * 3600, maxDrivingS: 8 * 3600, breakAfterS: 4.5 * 3600, breakS: 1800, minRestS: 8 * 3600 };
    expect(driverHoursProblems([{ start: h(0), end: h(2) }, { start: h(3), end: h(5) }], policy)).toEqual([]);
    expect(driverHoursProblems([{ start: h(0), end: h(4) }, { start: h(4.1), end: h(6) }], policy).map((p) => p.kind)).toEqual(['BREAK_REQUIRED']);
    expect(driverHoursProblems([{ start: h(0), end: h(4) }, { start: h(5), end: h(9) }, { start: h(10), end: h(11) }], policy).map((p) => p.kind).sort()).toEqual(['MAX_DRIVING', 'MAX_DUTY']);
    // A rest of minRestS starts a new duty: the next day's trips are judged on their own.
    expect(driverHoursProblems([{ start: h(0), end: h(4) }, { start: h(14), end: h(18) }], policy, { start: h(14), end: h(18) })).toEqual([]);
  });

  it('downtime, maintenance, operating windows and turnaround', () => {
    const span = { start: h(1), end: h(2) };
    expect(vehicleTimelineProblem(span, [], null, [], null)).toBeNull();
    expect(vehicleTimelineProblem(span, [{ kind: 'DOWNTIME', startsAt: h(1.5), endsAt: h(3) }], null, [], null)?.code).toBe('VEHICLE_UNAVAILABLE');
    expect(vehicleTimelineProblem(span, [], new Date(h(0)), [], null)?.code).toBe('VEHICLE_UNAVAILABLE');
    expect(vehicleTimelineProblem(span, [{ kind: 'OPERATING', startsAt: h(1.5), endsAt: h(8) }], null, [], null)?.code).toBe('VEHICLE_UNAVAILABLE');
    expect(vehicleTimelineProblem(span, [{ kind: 'OPERATING', startsAt: h(0), endsAt: h(8) }], null, [], null)).toBeNull();
    expect(vehicleTimelineProblem(span, [], null, [{ start: h(0), end: h(0.99) }], 120)?.code).toBe('VEHICLE_TURNAROUND');
    expect(vehicleTimelineProblem(span, [], null, [{ start: h(0), end: h(0.9) }], 120)).toBeNull();
  });
});

describe('solver contract v3 checker (never trust the optimiser)', () => {
  const problem = buildPdpProblem({
    durationsS: [
      [0, 300, 600, 300],
      [300, 0, 300, 400],
      [600, 300, 0, 500],
      [300, 400, 500, 0],
    ],
    distancesM: [[0]],
    horizonS: 86_400,
    vehicles: [{ id: 'v1', startIndex: 0, availableFromS: 0, shiftEndS: 86_400, capacity: 4, turnaroundS: 120 }],
    requests: [
      { bookingId: 'priv', pickupIndex: 1, dropIndex: 2, passengers: 1, preference: 'PRIVATE', windowStartS: 0, windowEndS: 3600, limits: null, companyMaxRideS: null },
      { bookingId: 'shr', pickupIndex: 3, dropIndex: 2, passengers: 1, preference: 'SHARED', windowStartS: 0, windowEndS: 3600, limits: null, companyMaxRideS: null },
    ],
    timeLimitS: 5,
  });
  const res = (stops: { requestId: string; kind: 'P' | 'D'; t: number; load: number }[][]): PdpResult => ({
    schemaVersion: 3,
    status: 'FEASIBLE',
    vehicles: [{ id: 'v1', trips: stops.map((st, index) => ({ index, stops: st.map((s) => ({ requestId: s.requestId, kind: s.kind, arrivalS: s.t, startS: s.t, load: s.load })) })) }],
    unserved: [],
    commitmentViolations: [],
  });

  it('accepts a private ride alone on its trip and rejects one sharing it', () => {
    expect(() => verifyPdp(problem, res([[{ requestId: 'priv', kind: 'P', t: 300, load: 1 }, { requestId: 'priv', kind: 'D', t: 660, load: 0 }], [{ requestId: 'shr', kind: 'P', t: 860, load: 1 }, { requestId: 'shr', kind: 'D', t: 1420, load: 0 }]]))).not.toThrow();
    expect(() => verifyPdp(problem, res([[{ requestId: 'priv', kind: 'P', t: 300, load: 1 }, { requestId: 'shr', kind: 'P', t: 760, load: 2 }, { requestId: 'priv', kind: 'D', t: 1300, load: 1 }, { requestId: 'shr', kind: 'D', t: 1300, load: 0 }]]))).toThrow(/private|detour/);
  });

  it('rejects a drop before its pickup and reported commitment violations', () => {
    expect(() => verifyPdp(problem, res([[{ requestId: 'shr', kind: 'D', t: 300, load: 0 }, { requestId: 'shr', kind: 'P', t: 600, load: 1 }]]))).toThrow(/before its pickup/);
    expect(() => verifyPdp(problem, { ...res([]), commitmentViolations: [{ requestId: 'x' }] })).toThrow(/commitment/);
  });
});
