import { HttpException } from '@nestjs/common';
import { bookingStopChanged, buildPlanChangeSet, capacityViolations, relS, pairProblem, planMetrics, retime, windowViolations, type PublishBooking, type PublishPlace, type PublishRoute, type RuleStop } from './plan-rules';
import { routeError } from './plans.service';

const START = new Date('2026-11-20T02:00:00Z'); // 07:30 IST
const DAY = new Date('2026-11-20T00:00:00Z');
const SITE = '00000000-0000-4000-8000-0000000000aa';

let n = 0;
const stop = (o: Partial<RuleStop>): RuleStop => ({
  id: `s${++n}`,
  ref: `r${n}`,
  assignmentId: null,
  sequence: null,
  etaS: null,
  serviceS: 60,
  demand: 1,
  timeWindows: null,
  stopKind: null,
  bookingId: null,
  profileId: null,
  poiId: null,
  lat: 13.06,
  lng: 80.24,
  name: null,
  ...o,
});

const booking = (id: string, o: Partial<PublishBooking> = {}): PublishBooking => ({
  id,
  status: 'PENDING_ASSIGNMENT',
  serviceDate: DAY,
  direction: 'IN',
  passengerCount: 1,
  profileId: `p-${id}`,
  pickupLat: 13.06,
  pickupLng: 80.24,
  pickupPoiId: null,
  pickupLabel: 'Home',
  dropLat: 13.05,
  dropLng: 80.25,
  dropPoiId: SITE,
  dropLabel: 'Office',
  ...o,
});

const route = (id: string, seq: number, o: Partial<PublishRoute> = {}): PublishRoute => ({ id, seq, vehicleLabel: `Van ${seq + 1}`, objectId: `00000000-0000-4000-8000-00000000000${seq + 1}`, driverId: null, startS: 0, endS: 3600, seats: 4, ...o });
const PLAN = { id: 'plan-1', name: 'Morning', planDate: DAY, planStartAt: START, direction: 'IN' as const, shiftId: null, sitePoiId: SITE };
const PLACES = new Map<string, PublishPlace>([[SITE, { id: SITE, name: 'Office', lat: 13.05, lng: 80.25 }]]);

/** Two passengers on route A, one on route B: pickups at homes, one drop stop each at the site. */
function threePassengers() {
  const ids = ['b1', 'b2', 'b3'].map((x) => `00000000-0000-4000-8000-0000000000${x === 'b1' ? '01' : x === 'b2' ? '02' : '03'}`);
  const bookings = new Map(ids.map((id) => [id, booking(id)]));
  const stops = [
    stop({ assignmentId: 'A', sequence: 0, etaS: 600, stopKind: 'PICKUP', bookingId: ids[0], profileId: `p-${ids[0]}` }),
    stop({ assignmentId: 'A', sequence: 1, etaS: 1200, stopKind: 'PICKUP', bookingId: ids[1], profileId: `p-${ids[1]}` }),
    stop({ assignmentId: 'A', sequence: 2, etaS: 2400, stopKind: 'DROP', bookingId: ids[0], poiId: SITE }),
    stop({ assignmentId: 'A', sequence: 3, etaS: 2400, stopKind: 'DROP', bookingId: ids[1], poiId: SITE }),
    stop({ assignmentId: 'B', sequence: 0, etaS: 900, stopKind: 'PICKUP', bookingId: ids[2], profileId: `p-${ids[2]}` }),
    stop({ assignmentId: 'B', sequence: 1, etaS: 2000, stopKind: 'DROP', bookingId: ids[2], poiId: SITE }),
  ];
  return { ids, bookings, stops, consents: new Set(ids.map((id) => `p-${id}`)) };
}

describe('plan rules: checks', () => {
  it('time windows: late, early wait; unreachable only after a re-time', () => {
    const s = [stop({ etaS: 100, timeWindows: [[200, 300]] }), stop({ etaS: 400, timeWindows: [[200, 300]] }), stop({ etaS: null })];
    expect(windowViolations(s).map((v) => v.kind)).toEqual(['early_wait', 'late']);
    expect(windowViolations(s, true).map((v) => v.kind)).toEqual(['early_wait', 'late', 'unreachable']);
  });

  it('capacity follows the E3 rule (seats never free up along a trip)', () => {
    const seats = (id: string) => ({ a: 2, b: 2 })[id];
    const s = [stop({ stopKind: 'PICKUP', bookingId: 'a' }), stop({ stopKind: 'DROP', bookingId: 'a' }), stop({ stopKind: 'PICKUP', bookingId: 'b' })];
    expect(capacityViolations(s, 3, seats).map((v) => [v.kind, v.stopId])).toEqual([['over_capacity', s[2].id]]);
    expect(capacityViolations(s, 4, seats)).toEqual([]);
    expect(capacityViolations(s, null, seats)).toEqual([]);
  });

  it('pickup before drop, both on one route', () => {
    expect(pairProblem([stop({ bookingId: 'x', stopKind: 'PICKUP', assignmentId: 'A', sequence: 1 }), stop({ bookingId: 'x', stopKind: 'DROP', assignmentId: 'A', sequence: 0 })])).toMatch(/before its drop/);
    expect(pairProblem([stop({ bookingId: 'x', stopKind: 'PICKUP', assignmentId: 'A', sequence: 0 }), stop({ bookingId: 'x', stopKind: 'DROP', assignmentId: 'B', sequence: 0 })])).toMatch(/same route/);
    expect(pairProblem([stop({ bookingId: 'x', stopKind: 'PICKUP', assignmentId: 'A', sequence: 0 }), stop({ bookingId: 'x', stopKind: 'DROP', assignmentId: 'A', sequence: 1 })])).toBeNull();
  });

  it('re-time waits for windows and never estimates a missing leg', () => {
    const s = [stop({ serviceS: 60, timeWindows: [[500, 900]] }), stop({ serviceS: 0 }), stop({ serviceS: 0 })];
    expect(retime(0, [100, 200, 50], s, 10)).toEqual({ etas: [500, 760, 810], endS: 820 });
    expect(retime(0, [100, null, 50], s, 10)).toEqual({ etas: [500, null, null], endS: null });
  });

  it('compare metrics are counts and sums only', () => {
    const { stops, bookings } = threePassengers();
    const m = planMetrics(
      { id: 'p', name: 'P', planDate: DAY, status: 'DRAFT', version: 3, graphVersion: null, assignments: [{ id: 'A', objectId: 'o1', capacity: 4, distanceM: 1000, durationS: 2400 }, { id: 'B', objectId: 'o2', capacity: 4, distanceM: 500, durationS: null }], stops },
      (id) => bookings.get(id)?.passengerCount,
    );
    expect(m).toMatchObject({ routes: 2, activeRoutes: 2, stops: 6, passengers: 3, seats: 3, unassigned: 0, distanceM: 1500, durationS: null, seatUtilisation: 0.375, violations: 0 });
    expect(JSON.stringify(m)).not.toContain('13.06');
  });
});

describe('plan rules: plan → E3 change set', () => {
  it('one CREATE_TRIP per route with merged site stops, one ADD_PASSENGER per booking, times from planStartAt + etaS', () => {
    const { ids, bookings, stops, consents } = threePassengers();
    const cs = buildPlanChangeSet(PLAN, [route('A', 0), route('B', 1)], stops, bookings, PLACES, consents);
    expect(cs.errors).toEqual([]);
    expect(cs.input).toMatchObject({ serviceDate: '2026-11-20', direction: 'IN' });
    expect(cs.input.changes.map((c) => c.op)).toEqual(['CREATE_TRIP', 'ADD_PASSENGER', 'ADD_PASSENGER', 'CREATE_TRIP', 'ADD_PASSENGER']);
    const a = cs.input.changes[0] as Extract<(typeof cs.input.changes)[number], { op: 'CREATE_TRIP' }>;
    expect(a.stops!.map((s) => [s.seq, s.point.poiId, s.plannedArrival])).toEqual([
      [0, null, '2026-11-20T02:10:00.000Z'],
      [1, null, '2026-11-20T02:20:00.000Z'],
      [2, SITE, '2026-11-20T02:40:00.000Z'],
    ]);
    expect(a.plannedStart).toBe('2026-11-20T02:00:00.000Z');
    expect(a.sitePoiId).toBe(SITE);
    expect(cs.input.changes[1]).toEqual({ op: 'ADD_PASSENGER', tripId: 'route-1', bookingId: ids[0], pickupSeq: 0, dropSeq: 2 });
    expect(cs.input.changes[2]).toEqual({ op: 'ADD_PASSENGER', tripId: 'route-1', bookingId: ids[1], pickupSeq: 1, dropSeq: 2 });
    expect(cs.opRoute).toEqual([null, 'A', 'A', 'A', 'B', 'B']);
    expect([...cs.tempIds]).toEqual([['A', 'route-1'], ['B', 'route-2']]);
  });

  it('adds a missing site end and keeps a route without stops out (warning)', () => {
    const { bookings, stops, consents } = threePassengers();
    const onlyPickups = stops.filter((s) => s.stopKind === 'PICKUP');
    const cs = buildPlanChangeSet(PLAN, [route('A', 0), route('B', 1), route('C', 2)], onlyPickups, bookings, PLACES, consents);
    expect(cs.errors).toEqual([]);
    const b = cs.input.changes.find((c) => c.op === 'CREATE_TRIP' && c.tempId === 'route-2') as { stops: { point: { poiId: string | null }; plannedArrival: string }[] };
    expect(b.stops.map((s) => s.point.poiId)).toEqual([null, SITE]);
    expect(b.stops[1].plannedArrival).toBe('2026-11-20T03:00:00.000Z'); // route end (endS 3600)
    expect(cs.warnings).toEqual(['Route Van 3 has no stops and is not published']);
  });

  it('per-route pre-checks: no vehicle, capacity, consent, booking state, untimed route, split booking', () => {
    const { ids, bookings, stops, consents } = threePassengers();
    bookings.set(ids[2], booking(ids[2], { status: 'ASSIGNED' }));
    consents.delete(`p-${ids[1]}`);
    const cs = buildPlanChangeSet(PLAN, [route('A', 0, { seats: 1 }), route('B', 1, { objectId: null })], stops, bookings, PLACES, consents);
    expect(cs.errors.map((e) => [e.assignmentId, e.code])).toEqual([
      ['A', 'CONSENT_REQUIRED'],
      ['A', 'CAPACITY_EXCEEDED'],
      ['B', 'NO_VEHICLE'],
      ['B', 'INVALID_STATE'],
    ]);
    const untimed = buildPlanChangeSet(PLAN, [route('A', 0)], stops.map((s) => (s.sequence === 1 && s.assignmentId === 'A' ? { ...s, etaS: null } : s)), threePassengers().bookings, PLACES, threePassengers().consents);
    expect(untimed.errors.map((e) => e.code)).toContain('ROUTE_NOT_TIMED');
    const split = buildPlanChangeSet(PLAN, [route('A', 0), route('B', 1)], stops.map((s) => (s.bookingId === ids[0] && s.stopKind === 'DROP' ? { ...s, assignmentId: 'B', sequence: 5 } : s)), threePassengers().bookings, PLACES, threePassengers().consents);
    expect(split.errors.map((e) => e.code)).toContain('SPLIT_BOOKING');
    expect(buildPlanChangeSet({ ...PLAN, planStartAt: null }, [route('A', 0)], stops, bookings, PLACES, consents).errors[0].code).toBe('ROUTE_NOT_TIMED');
  });

  it('WP 3.9: a booking edited after the plan was built (point, place or window) is refused as BOOKING_CHANGED', () => {
    const { ids, bookings, stops, consents } = threePassengers();
    // The site stops carry the booking window as plan create writes it (seconds after planStartAt).
    const ws = new Date(START.getTime() + 1800_000);
    const we = new Date(START.getTime() + 2700_000);
    const withWindows = stops.map((s) => (s.poiId === SITE ? { ...s, timeWindows: [[1800, 2700]] as [number, number][] } : s));
    for (const id of ids) bookings.set(id, booking(id, { windowStart: ws, windowEnd: we }));
    expect(buildPlanChangeSet(PLAN, [route('A', 0), route('B', 1)], withWindows, bookings, PLACES, consents).errors).toEqual([]);

    const edit = (o: Partial<PublishBooking>) => {
      const m = new Map(bookings);
      m.set(ids[2], { ...bookings.get(ids[2])!, ...o });
      return buildPlanChangeSet(PLAN, [route('A', 0), route('B', 1)], withWindows, m, PLACES, consents).errors.map((e) => [e.assignmentId, e.code]);
    };
    expect(edit({ pickupLat: 13.07 })).toEqual([['B', 'BOOKING_CHANGED']]);
    expect(edit({ pickupLat: 13.06 + 1e-9 })).toEqual([]); // float noise only
    expect(edit({ dropPoiId: '00000000-0000-4000-8000-0000000000bb' })).toEqual([['B', 'BOOKING_CHANGED']]);
    expect(edit({ pickupPoiId: SITE })).toEqual([['B', 'BOOKING_CHANGED']]); // personal pickup became a company place
    expect(edit({ windowEnd: new Date(we.getTime() + 600_000) })).toEqual([['B', 'BOOKING_CHANGED']]);
    expect(edit({ passengerCount: 2 })).toEqual([]); // seats are re-checked from the booking, not frozen in the stop
    // A changed booking taken off the route is not published, so it no longer blocks.
    const off = withWindows.map((s) => (s.bookingId === ids[2] ? { ...s, assignmentId: null, sequence: null } : s));
    const m = new Map(bookings);
    m.set(ids[2], { ...bookings.get(ids[2])!, pickupLat: 13.07 });
    expect(buildPlanChangeSet(PLAN, [route('A', 0), route('B', 1)], off, m, PLACES, consents).errors).toEqual([]);
  });

  it('bookingStopChanged ignores generic stops and a missing point (NEEDS_LOCATION)', () => {
    const b = booking('x', { pickupLat: null, pickupLng: null });
    expect(bookingStopChanged(stop({ stopKind: null }), b, START.getTime())).toBe(false);
    expect(bookingStopChanged(stop({ stopKind: 'PICKUP' }), b, START.getTime())).toBe(false);
    expect(relS(new Date(START.getTime() - 5000), START.getTime())).toBe(0);
  });

  it('an E3 publish error names the route of the change that failed', () => {
    const e = new HttpException({ message: 'The vehicle is already planned on "X" at that time', code: 'VEHICLE_BUSY' }, 409);
    const out = routeError(e, 4, [null, 'A', 'A', 'A', 'B'], [{ id: 'A', vehicleLabel: 'Van 1' }, { id: 'B', vehicleLabel: 'Van 2' }]) as HttpException;
    expect(out.getStatus()).toBe(409);
    expect(out.getResponse()).toMatchObject({ code: 'VEHICLE_BUSY', routes: [{ assignmentId: 'B', vehicleLabel: 'Van 2', code: 'VEHICLE_BUSY' }] });
    expect(routeError(e, 0, [null], [])).toBe(e);
  });
});
