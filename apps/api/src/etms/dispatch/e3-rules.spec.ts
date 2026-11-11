import { bookingAllowedActions, bookingTransition, deriveTripState, passengerOutcomeAllowed, allowedPassengerOutcomes, TRANSPORT_BOOKING_STATUSES } from '@veetracer/shared';
import { legPoints, overrideOf, bookingData } from './booking-generator.service';
import { parseChangeOps, adhocStops } from './change-ops';
import { isServiceDate, requestHash, stableJson } from './e3-common';
import { stopWithPendingOutcome } from './e3-mapping';
import { vehicleWindow } from './me-transport.service';
import { legWindow, sameWallTime, scheduleOccurrences } from './service-dates';

const H = 3_600_000;
const MIN = 60_000;
const at = (iso: string) => Date.parse(iso);

describe('service dates (12 WP 3.2: site time zone, overnight, US DST)', () => {
  const ist = { startMin: 9 * 60, endMin: 18 * 60, overnight: false, days: [1, 2, 3, 4, 5], timeZone: 'Asia/Kolkata' };

  it('IN window ends at login, OUT window starts at logout (IST)', () => {
    expect(legWindow(ist, 'IN', '2026-11-16')).toEqual({ anchor: at('2026-11-16T03:30:00Z'), start: at('2026-11-16T02:00:00Z'), end: at('2026-11-16T03:30:00Z') });
    expect(legWindow(ist, 'OUT', '2026-11-16')).toEqual({ anchor: at('2026-11-16T12:30:00Z'), start: at('2026-11-16T12:30:00Z'), end: at('2026-11-16T14:00:00Z') });
  });

  it('an overnight shift logs out on the next local day; an override replaces the anchor time', () => {
    const night = { startMin: 22 * 60, endMin: 6 * 60, overnight: true, days: [1], timeZone: 'Asia/Kolkata' };
    expect(legWindow(night, 'OUT', '2026-11-16').anchor).toBe(at('2026-11-17T00:30:00Z')); // 06:00 IST next day
    expect(legWindow(night, 'IN', '2026-11-16').anchor).toBe(at('2026-11-16T16:30:00Z')); // 22:00 IST
    expect(legWindow(ist, 'IN', '2026-11-16', 10 * 60).anchor).toBe(at('2026-11-16T04:30:00Z'));
  });

  it('keeps 09:00 local across the US DST change (America/New_York, 1 Nov 2026)', () => {
    const ny = { startMin: 9 * 60, endMin: 17 * 60, overnight: false, days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'America/New_York' };
    expect(legWindow(ny, 'IN', '2026-10-31').anchor).toBe(at('2026-10-31T13:00:00Z')); // EDT −4
    expect(legWindow(ny, 'IN', '2026-11-01').anchor).toBe(at('2026-11-01T14:00:00Z')); // EST −5
    expect(legWindow(ny, 'IN', '2026-11-02').anchor).toBe(at('2026-11-02T14:00:00Z'));
    // Spring forward (8 Mar 2026): 09:00 EDT.
    expect(legWindow(ny, 'IN', '2026-03-09').anchor).toBe(at('2026-03-09T13:00:00Z'));
  });

  it('occurrences: weekdays of schedule ∩ shift, validity, window start inside [from, to)', () => {
    const schedule = { direction: 'IN' as const, days: [1, 3, 6], validFrom: new Date('2026-11-16T00:00:00Z'), validTo: new Date('2026-11-25T00:00:00Z') };
    // Mon 16 … Sun 29 Nov 2026; Saturday (6) is not a shift day.
    const occ = scheduleOccurrences(schedule, ist, at('2026-11-15T00:00:00Z'), at('2026-11-30T00:00:00Z'));
    expect(occ.map((o) => o.serviceDate)).toEqual(['2026-11-16', '2026-11-18', '2026-11-23', '2026-11-25']);
    // A 72 h horizon from Monday 08:00 IST: Monday's login window (07:30–09:00) already started → only Wednesday.
    const from = at('2026-11-16T02:30:00Z');
    expect(scheduleOccurrences(schedule, ist, from, from + 72 * H).map((o) => o.serviceDate)).toEqual(['2026-11-18']);
    expect(scheduleOccurrences(schedule, ist, from, from)).toEqual([]);
  });

  it('a US DST week yields one 09:00-local login per day', () => {
    const ny = { startMin: 9 * 60, endMin: 17 * 60, overnight: false, days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'America/New_York' };
    const occ = scheduleOccurrences({ direction: 'IN', days: [0, 1, 2, 3, 4, 5, 6], validFrom: new Date('2026-10-28T00:00:00Z'), validTo: null }, ny, at('2026-10-29T00:00:00Z'), at('2026-11-05T00:00:00Z'));
    expect(occ.map((o) => o.serviceDate)).toEqual(['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']);
    for (const o of occ) expect(new Date(o.window.anchor).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false })).toBe('09:00:00');
  });

  it('sameWallTime keeps the local clock when repeating across DST', () => {
    const tz = 'America/New_York';
    expect(sameWallTime(at('2026-10-30T11:40:00Z'), tz, '2026-10-30', '2026-11-02')).toBe(at('2026-11-02T12:40:00Z')); // 07:40 local both days
    expect(sameWallTime(at('2026-11-16T02:10:00Z'), 'Asia/Kolkata', '2026-11-16', '2026-11-17')).toBe(at('2026-11-17T02:10:00Z'));
  });

  it('service-date validation', () => {
    expect(isServiceDate('2026-11-16')).toBe(true);
    expect(isServiceDate('2026-02-30')).toBe(false);
    expect(isServiceDate('16-11-2026')).toBe(false);
  });
});

describe('booking state machine (05 §3, 02 §5.2)', () => {
  it('allows exactly the documented transitions', () => {
    expect(bookingTransition('REQUESTED', 'approve')).toBe('PENDING_ASSIGNMENT');
    expect(bookingTransition('ASSIGNED', 'approve')).toBe('CONFIRMED');
    expect(bookingTransition('PENDING_ASSIGNMENT', 'assign')).toBe('ASSIGNED');
    expect(bookingTransition('ASSIGNED', 'unassign')).toBe('PENDING_ASSIGNMENT');
    expect(bookingTransition('PENDING_ASSIGNMENT', 'expire')).toBe('EXPIRED');
    expect(bookingTransition('ASSIGNED', 'reject')).toBeNull();
    expect(bookingTransition('ASSIGNED', 'expire')).toBeNull();
    expect(bookingTransition('REQUESTED', 'assign')).toBeNull();
    for (const final of ['REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED'] as const) {
      for (const cmd of ['approve', 'reject', 'cancel', 'assign', 'unassign', 'expire'] as const) expect([final, cmd, bookingTransition(final, cmd)]).toEqual([final, cmd, null]);
    }
  });

  it('allowed actions: edit only unseated and before the cut-off', () => {
    const now = at('2026-11-16T00:00:00Z');
    expect(bookingAllowedActions({ status: 'PENDING_ASSIGNMENT', cutoffAt: new Date(now + H) }, now)).toEqual(['edit', 'cancel', 'reject']);
    expect(bookingAllowedActions({ status: 'PENDING_ASSIGNMENT', cutoffAt: new Date(now - 1) }, now)).toEqual(['cancel', 'reject']);
    expect(bookingAllowedActions({ status: 'ASSIGNED', cutoffAt: null }, now)).toEqual(['cancel', 'approve']);
    expect(bookingAllowedActions({ status: 'CANCELLED', cutoffAt: null }, now)).toEqual([]);
    expect(TRANSPORT_BOOKING_STATUSES).toHaveLength(9);
  });
});

describe('passenger outcomes and derived trip state (D2, condition A)', () => {
  it('outcome transitions', () => {
    expect(allowedPassengerOutcomes('PENDING')).toEqual(['BOARDED', 'NO_SHOW']);
    expect(allowedPassengerOutcomes('BOARDED')).toEqual(['NO_SHOW', 'DROPPED']);
    expect(allowedPassengerOutcomes('NO_SHOW')).toEqual(['BOARDED']);
    expect(allowedPassengerOutcomes('DROPPED')).toEqual([]);
    expect(allowedPassengerOutcomes('CANCELLED')).toEqual([]);
    expect(passengerOutcomeAllowed('PENDING', 'DROPPED')).toBe(false);
  });

  it('derived states from PlannedTrip + header (no second status column)', () => {
    const base = { publishedAt: null, acknowledgedAt: null, stopWithPendingOutcome: false };
    expect(deriveTripState({ ...base, plannedTripStatus: 'SCHEDULED' })).toBe('PLANNED');
    expect(deriveTripState({ ...base, plannedTripStatus: 'SCHEDULED', publishedAt: new Date() })).toBe('PUBLISHED');
    expect(deriveTripState({ ...base, plannedTripStatus: 'SCHEDULED', publishedAt: new Date(), acknowledgedAt: new Date() })).toBe('DRIVER_ACKNOWLEDGED');
    expect(deriveTripState({ ...base, plannedTripStatus: 'STARTED' })).toBe('EN_ROUTE');
    expect(deriveTripState({ ...base, plannedTripStatus: 'IN_PROGRESS' })).toBe('IN_PROGRESS');
    expect(deriveTripState({ ...base, plannedTripStatus: 'IN_PROGRESS', stopWithPendingOutcome: true })).toBe('AT_STOP');
    expect(deriveTripState({ ...base, plannedTripStatus: 'COMPLETED' })).toBe('COMPLETED');
    expect(deriveTripState({ ...base, plannedTripStatus: 'INCOMPLETE' })).toBe('INCOMPLETE');
    expect(deriveTripState({ ...base, plannedTripStatus: 'CANCELLED' })).toBe('CANCELLED');
    expect(deriveTripState({ ...base, plannedTripStatus: null })).toBe('DETACHED');
  });

  it('a GPS-arrived stop with a PENDING passenger is "at stop", the passenger stays PENDING', () => {
    expect(stopWithPendingOutcome([{ seq: 0, status: 'ARRIVED' }], [{ status: 'PENDING', pickupSeq: 0 }])).toBe(true);
    expect(stopWithPendingOutcome([{ seq: 0, status: 'ARRIVED' }], [{ status: 'BOARDED', pickupSeq: 0 }])).toBe(false);
    expect(stopWithPendingOutcome([{ seq: 0, status: 'PENDING' }], [{ status: 'PENDING', pickupSeq: 0 }])).toBe(false);
  });
});

describe('passenger vehicle window (05 §2.8, 10 §4.3)', () => {
  const pt = (o: Partial<{ status: string; plannedStart: Date; plannedEnd: Date; actualStart: Date | null; actualEnd: Date | null }> = {}) => ({
    status: 'SCHEDULED',
    plannedStart: new Date(at('2026-11-16T03:00:00Z')),
    plannedEnd: new Date(at('2026-11-16T04:00:00Z')),
    actualStart: null,
    actualEnd: null,
    ...o,
  });

  it('opens 30 min before the planned start (or at an earlier actual start) and closes 10 min after the drop / end', () => {
    expect(vehicleWindow(pt(), { status: 'PENDING', droppedAt: null })!.start).toBe(at('2026-11-16T02:30:00Z'));
    expect(vehicleWindow(pt({ actualStart: new Date(at('2026-11-16T02:00:00Z')) }), { status: 'PENDING', droppedAt: null })!.start).toBe(at('2026-11-16T02:00:00Z'));
    expect(vehicleWindow(pt({ status: 'IN_PROGRESS' }), { status: 'DROPPED', droppedAt: new Date(at('2026-11-16T03:40:00Z')) })!.end).toBe(at('2026-11-16T03:50:00Z'));
    expect(vehicleWindow(pt({ status: 'COMPLETED', actualEnd: new Date(at('2026-11-16T04:05:00Z')) }), { status: 'BOARDED', droppedAt: null })!.end).toBe(at('2026-11-16T04:15:00Z'));
  });

  it('never for a cancelled trip, a no-show / cancelled passenger or a detached trip', () => {
    expect(vehicleWindow(pt({ status: 'CANCELLED' }), { status: 'PENDING', droppedAt: null })).toBeNull();
    expect(vehicleWindow(pt(), { status: 'NO_SHOW', droppedAt: null })).toBeNull();
    expect(vehicleWindow(pt(), { status: 'CANCELLED', droppedAt: null })).toBeNull();
    expect(vehicleWindow(null, { status: 'PENDING', droppedAt: null })).toBeNull();
  });
});

describe('generator legs: consent gates every passenger point (D8, 10 §4.2)', () => {
  const shift = { sitePoi: { id: 'site', name: 'HQ', lat: 13.05, lng: 80.25 } } as never;
  const home = { lat: 13.06, lng: 80.24, label: null, poiId: null };
  it('IN = passenger → site, OUT = site → passenger; no passenger point without consent', () => {
    expect(legPoints({ direction: 'IN', pickupMode: 'HOME', stopPoi: null, shift }, { consent: true, home })).toEqual({ pickup: home, drop: { lat: 13.05, lng: 80.25, label: 'HQ', poiId: 'site' } });
    expect(legPoints({ direction: 'OUT', pickupMode: 'HOME', stopPoi: null, shift }, { consent: true, home }).drop).toEqual(home);
    expect(legPoints({ direction: 'IN', pickupMode: 'HOME', stopPoi: null, shift }, { consent: false, home }).pickup).toBeNull();
    expect(legPoints({ direction: 'IN', pickupMode: 'STOP', stopPoi: { id: 's', name: 'Gate', lat: 13.1, lng: 80.2 }, shift }, { consent: false, home }).pickup).toBeNull();
    expect(legPoints({ direction: 'IN', pickupMode: 'STOP', stopPoi: { id: 's', name: 'Gate', lat: 13.1, lng: 80.2 }, shift }, { consent: true, home }).pickup).toEqual({ lat: 13.1, lng: 80.2, label: 'Gate', poiId: 's' });
  });

  it('override JSON is parsed defensively; generated rows are deterministic except the id', () => {
    expect(overrideOf({ timeMin: 600, pickup: { lat: 13, lng: 80 } })).toEqual({ timeMin: 600, pickup: { lat: 13, lng: 80, label: null, poiId: null } });
    expect(overrideOf({ timeMin: 9999, pickup: { lat: 0, lng: 0 } })).toEqual({});
    expect(overrideOf(null)).toBeNull();
    const s = { id: 'sc', companyId: 'c', profileId: 'p', shiftId: 'sh', direction: 'IN', days: [1], pickupMode: 'HOME', validFrom: new Date(), validTo: null, stopPoi: null, shift: { id: 'sh', startMin: 540, endMin: 1080, overnight: false, days: [1], timeZone: 'Asia/Kolkata', sitePoi: null } } as never;
    const w = legWindow({ startMin: 540, endMin: 1080, timeZone: 'Asia/Kolkata' }, 'IN', '2026-11-16');
    const a = bookingData(s, '2026-11-16', w, { pickup: home, drop: null }, 60);
    const b = bookingData(s, '2026-11-16', w, { pickup: home, drop: null }, 60);
    expect({ ...a, id: 'x' }).toEqual({ ...b, id: 'x' });
    expect(a).toMatchObject({ status: 'PENDING_ASSIGNMENT', source: 'SCHEDULE', scheduleId: 'sc', cutoffAt: new Date(w.start - 60 * MIN), dropLat: null });
  });
});

describe('change-set parsing (05 §3.4)', () => {
  const stop = (seq: number, min: number) => ({ seq, point: { lat: 13 + seq / 100, lng: 80 }, plannedArrival: new Date(at('2026-11-16T03:00:00Z') + min * MIN).toISOString() });
  const create = { op: 'CREATE_TRIP', tempId: 't1', objectId: '11111111-1111-4111-8111-111111111111', plannedStart: '2026-11-16T03:00:00Z', stops: [stop(0, 0), stop(1, 20)] };

  it('accepts a door-to-door trip and passengers referencing its tempId', () => {
    const ops = parseChangeOps([create, { op: 'ADD_PASSENGER', tripId: 't1', bookingId: '22222222-2222-4222-8222-222222222222', pickupSeq: 0, dropSeq: 1 }]);
    expect(ops[0]).toMatchObject({ op: 'CREATE_TRIP', routeId: null, driverId: null });
    expect(adhocStops((ops[0] as unknown as { stops: never }).stops).map((s) => s.name)).toEqual(['Stop 1', 'Stop 2']);
  });

  it.each([
    ['unknown op', [{ op: 'REORDER_STOPS', tripId: 'x', seqs: [] }], /unknown op/],
    ['route and stops together', [{ ...create, routeId: '33333333-3333-4333-8333-333333333333' }], /either routeId/],
    ['one stop', [{ ...create, stops: [stop(0, 0)] }], /stops/],
    ['gap in seqs', [{ ...create, stops: [stop(0, 0), stop(2, 10)] }], /without gaps/],
    ['time going back', [{ ...create, stops: [stop(0, 20), stop(1, 0)] }], /back in time/],
    ['(0,0) point', [{ ...create, stops: [{ ...stop(0, 0), point: { lat: 0, lng: 0 } }, stop(1, 10)] }], /valid point/],
    ['tempId that looks like an id', [{ ...create, tempId: '11111111-1111-4111-8111-111111111111' }], /tempId/],
    ['reference to an unknown tempId', [{ op: 'ADD_PASSENGER', tripId: 'nope', bookingId: '22222222-2222-4222-8222-222222222222', pickupSeq: 0, dropSeq: 1 }], /tempId created earlier/],
    ['drop before pickup', [create, { op: 'ADD_PASSENGER', tripId: 't1', bookingId: '22222222-2222-4222-8222-222222222222', pickupSeq: 1, dropSeq: 1 }], /before dropSeq/],
    ['remove without reason', [{ op: 'REMOVE_PASSENGER', passengerTripId: '22222222-2222-4222-8222-222222222222' }], /reason/],
  ])('refuses %s', (_name, raw, msg) => {
    expect(() => parseChangeOps(raw as unknown[])).toThrow(msg as RegExp);
  });
});

describe('idempotency hash (05 §1)', () => {
  it('ignores key order and undefined fields, distinguishes values', () => {
    expect(stableJson({ b: 1, a: { d: [1, 2], c: undefined } })).toBe('{"a":{"d":[1,2]},"b":1}');
    expect(requestHash({ a: 1, b: 2 })).toBe(requestHash({ b: 2, a: 1 }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
  });
});
