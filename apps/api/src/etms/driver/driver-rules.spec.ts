import { driverDisplayName, driverOutcomeAllowed, driverTripActions, passengerPushAllowed } from '@veetracer/shared';
import { applyToSnapshot, clockOk, correctedTime, decide, licenceValid, onlineCommandFresh, verifyArrival, withinStartWindow, type EventIn, type TripSnapshot } from './driver-rules';

const MIN = 60_000;
const NOW = Date.parse('2026-11-12T03:00:00Z');

function snap(over: Partial<TripSnapshot> = {}): TripSnapshot {
  return {
    plannedTripStatus: 'IN_PROGRESS',
    publishedAt: new Date(NOW - 3600_000),
    acknowledgedAt: null,
    assigned: true,
    plannedStart: new Date(NOW - 10 * MIN),
    stops: [
      { id: 's0', seq: 0, status: 'PENDING', plannedArrival: new Date(NOW), actualArrival: null, lat: 13.06, lng: 80.24, radiusM: 100 },
      { id: 's1', seq: 1, status: 'PENDING', plannedArrival: new Date(NOW + 30 * MIN), actualArrival: null, lat: 13.05, lng: 80.25, radiusM: 100 },
    ],
    passengers: [
      { id: 'p1', status: 'PENDING', pickupSeq: 0, dropSeq: 1 },
      { id: 'p2', status: 'PENDING', pickupSeq: 0, dropSeq: 1 },
    ],
    lastSeq: null,
    fix: null,
    ...over,
  };
}
const ev = (type: string, seq: number, extra: Partial<EventIn> = {}): EventIn => ({ type, seq, occurredAt: new Date(NOW), ...extra });

/** Run events in order against one snapshot, as the service does (accepted effects are applied, seq advances when stored). */
function run(s: TripSnapshot, events: EventIn[]) {
  return events.map((e) => {
    const d = decide(s, e, NOW);
    if (d.outcome === 'ACCEPTED') applyToSnapshot(s, d.effect, e.occurredAt);
    if (d.outcome !== 'RETRY') s.lastSeq = Math.max(s.lastSeq ?? 0, e.seq);
    return d.outcome === 'ACCEPTED' ? 'ACCEPTED' : `${d.outcome}:${d.code}`;
  });
}

describe('driver trip-event state machine (09 §4.4)', () => {
  it('arrive then board; a no-show right at the arrival is refused (minimum wait)', () => {
    const s = snap();
    expect(run(s, [ev('ARRIVED', 1, { stopSeq: 0 }), ev('BOARDED', 2, { passengerTripId: 'p1' }), ev('NO_SHOW', 3, { passengerTripId: 'p2' })])).toEqual(['ACCEPTED', 'ACCEPTED', 'REJECTED:WAIT_NOT_ELAPSED']);
    expect(s.stops[0]).toMatchObject({ status: 'ARRIVED', actualArrival: new Date(NOW) });
    expect(s.passengers.map((p) => p.status)).toEqual(['BOARDED', 'PENDING']);
  });

  it('no-show only after the minimum wait from the arrival; then depart, drop, complete', () => {
    const s = snap({ stops: [{ id: 's0', seq: 0, status: 'ARRIVED', plannedArrival: new Date(NOW - 10 * MIN), actualArrival: new Date(NOW - 6 * MIN), lat: 13.06, lng: 80.24, radiusM: 100 }, { id: 's1', seq: 1, status: 'PENDING', plannedArrival: new Date(NOW + 30 * MIN), actualArrival: null, lat: 13.05, lng: 80.25, radiusM: 100 }] });
    expect(
      run(s, [
        ev('NO_SHOW', 1, { passengerTripId: 'p2', occurredAt: new Date(NOW - 2 * MIN) }), // 4 min after arrival
        ev('BOARDED', 2, { passengerTripId: 'p1' }),
        ev('DEPARTED', 3, { stopSeq: 0 }), // p2 still pending
        ev('NO_SHOW', 4, { passengerTripId: 'p2' }), // 6 min after arrival
        ev('DEPARTED', 5, { stopSeq: 0 }),
        ev('COMPLETE_TRIP', 6), // p1 on board
        ev('DROPPED', 7, { passengerTripId: 'p1', stopSeq: 1 }),
        ev('COMPLETE_TRIP', 8),
      ]),
    ).toEqual(['REJECTED:WAIT_NOT_ELAPSED', 'ACCEPTED', 'REJECTED:UNRESOLVED_PASSENGERS', 'ACCEPTED', 'ACCEPTED', 'REJECTED:PASSENGERS_ON_BOARD', 'ACCEPTED', 'ACCEPTED']);
    expect(s.plannedTripStatus).toBe('COMPLETED');
    expect(s.stops[1].status).toBe('SKIPPED');
  });

  it('first outcome wins: a contradiction is CONFLICT, the same fact again is DUPLICATE (ALREADY_RECORDED)', () => {
    const s = snap();
    s.stops[0].status = 'ARRIVED';
    s.stops[0].actualArrival = new Date(NOW - 10 * MIN);
    expect(run(s, [ev('BOARDED', 1, { passengerTripId: 'p1' }), ev('NO_SHOW', 2, { passengerTripId: 'p1' }), ev('BOARDED', 3, { passengerTripId: 'p1' }), ev('NO_SHOW', 4, { passengerTripId: 'p2' }), ev('BOARDED', 5, { passengerTripId: 'p2' })])).toEqual([
      'ACCEPTED',
      'REJECTED:CONFLICT',
      'DUPLICATE:ALREADY_RECORDED',
      'ACCEPTED',
      'REJECTED:CONFLICT',
    ]);
  });

  it('out of order: a dependent event ahead of a missing seq is RETRY OUT_OF_ORDER (not stored); without a gap it is REJECTED', () => {
    const s = snap({ lastSeq: 1 });
    // seq 3 arrives before seq 2 (the ARRIVED): retry later.
    expect(run(s, [ev('BOARDED', 3, { passengerTripId: 'p1' })])).toEqual(['RETRY:OUT_OF_ORDER']);
    expect(s.lastSeq).toBe(1);
    // Now seq 2 (ARRIVED) and the retried seq 3 converge.
    expect(run(s, [ev('ARRIVED', 2, { stopSeq: 0 }), ev('BOARDED', 3, { passengerTripId: 'p1' })])).toEqual(['ACCEPTED', 'ACCEPTED']);
    // No gap and the stop not reached: a real rule violation.
    const t = snap({ lastSeq: 4 });
    expect(run(t, [ev('BOARDED', 5, { passengerTripId: 'p1' })])).toEqual(['REJECTED:STOP_NOT_ARRIVED']);
  });

  it('GPS arrival counts: boarding at a stop the tracker marked ARRIVED needs no driver ARRIVED (shuffled replay converges)', () => {
    const s = snap({ lastSeq: 0 });
    s.stops[0].status = 'ARRIVED';
    expect(run(s, [ev('BOARDED', 2, { passengerTripId: 'p1' })])).toEqual(['ACCEPTED']);
  });

  it('dispatcher wins: on a cancelled / closed trip queued events are LATE; on a reassigned trip NOT_ASSIGNED', () => {
    expect(run(snap({ plannedTripStatus: 'CANCELLED' }), [ev('BOARDED', 1, { passengerTripId: 'p1' }), ev('REPORT_DELAY', 2)])).toEqual(['LATE:TRIP_CLOSED', 'LATE:TRIP_CLOSED']);
    expect(run(snap({ plannedTripStatus: 'COMPLETED' }), [ev('COMPLETE_TRIP', 1), ev('DROPPED', 2, { passengerTripId: 'p1' })])).toEqual(['DUPLICATE:ALREADY_RECORDED', 'LATE:TRIP_CLOSED']);
    expect(run(snap({ assigned: false }), [ev('ACKNOWLEDGE', 1)])).toEqual(['REJECTED:NOT_ASSIGNED']);
  });

  it('START_TRIP is never accepted from a batch (online only); unknown types are rejected per event', () => {
    expect(run(snap({ plannedTripStatus: 'SCHEDULED' }), [ev('START_TRIP', 1), ev('FLY', 2)])).toEqual(['REJECTED:ONLINE_ONLY', 'REJECTED:VALIDATION_FAILED']);
  });

  it('acknowledge: only published; again = DUPLICATE; allowed before the start', () => {
    const s = snap({ plannedTripStatus: 'SCHEDULED' });
    expect(run(s, [ev('ACKNOWLEDGE', 1), ev('ACKNOWLEDGE', 2)])).toEqual(['ACCEPTED', 'DUPLICATE:ALREADY_RECORDED']);
    expect(run(snap({ plannedTripStatus: 'SCHEDULED', publishedAt: null }), [ev('ACKNOWLEDGE', 1)])).toEqual(['REJECTED:INVALID_STATE']);
  });

  it('a not-started trip refuses stop / passenger events; delay reports are allowed before the start', () => {
    expect(run(snap({ plannedTripStatus: 'SCHEDULED' }), [ev('ARRIVED', 1, { stopSeq: 0 }), ev('REPORT_DELAY', 2, { etaMin: 15 }), ev('REPORT_BREAKDOWN', 3)])).toEqual(['REJECTED:TRIP_NOT_STARTED', 'ACCEPTED', 'ACCEPTED']);
  });

  it('drop: only a boarded passenger; another stop than the drop stop needs a reason (early drop, flagged)', () => {
    const s = snap();
    s.passengers[0].status = 'BOARDED';
    expect(decide(s, ev('DROPPED', 1, { passengerTripId: 'p1', stopSeq: 0 }), NOW)).toMatchObject({ outcome: 'REJECTED', code: 'NOT_AT_DROP_STOP' });
    expect(decide(s, ev('DROPPED', 1, { passengerTripId: 'p1', stopSeq: 0, reasonCode: 'PASSENGER_REQUEST' }), NOW)).toMatchObject({ outcome: 'ACCEPTED', effect: { kind: 'OUTCOME', earlyDrop: true } });
    expect(decide(s, ev('DROPPED', 1, { passengerTripId: 'p2' }), NOW)).toMatchObject({ outcome: 'REJECTED', code: 'INVALID_STATE' });
    expect(decide(s, ev('DROPPED', 1, { passengerTripId: 'nope' }), NOW)).toMatchObject({ outcome: 'REJECTED', code: 'NOT_FOUND' });
  });

  it('ARRIVED vs the vehicle GPS: near fix → gps; far fresh fix → NOT_AT_STOP; no / stale fix → unverified_location', () => {
    const near = snap({ fix: { lat: 13.0605, lng: 80.2402, at: new Date(NOW) } });
    expect(decide(near, ev('ARRIVED', 1, { stopSeq: 0 }), NOW)).toMatchObject({ outcome: 'ACCEPTED', verified: 'gps' });
    const far = snap({ fix: { lat: 13.2, lng: 80.4, at: new Date(NOW) } });
    expect(decide(far, ev('ARRIVED', 1, { stopSeq: 0 }), NOW)).toMatchObject({ outcome: 'REJECTED', code: 'NOT_AT_STOP' });
    const stale = snap({ fix: { lat: 13.2, lng: 80.4, at: new Date(NOW - 10 * MIN) } });
    expect(decide(stale, ev('ARRIVED', 1, { stopSeq: 0 }), NOW)).toMatchObject({ outcome: 'ACCEPTED', verified: 'unverified_location' });
    expect(verifyArrival(snap().stops[0], null, new Date(NOW))).toBe('unverified_location');
    // A stop the GPS already reached: the driver's ARRIVED is a confirmation; a departed stop: already recorded.
    const arrived = snap();
    arrived.stops[0].status = 'ARRIVED';
    expect(decide(arrived, ev('ARRIVED', 1, { stopSeq: 0 }), NOW)).toMatchObject({ outcome: 'ACCEPTED', effect: { confirmOnly: true } });
    arrived.stops[0].status = 'DEPARTED';
    expect(decide(arrived, ev('ARRIVED', 1, { stopSeq: 0 }), NOW)).toMatchObject({ outcome: 'DUPLICATE' });
    arrived.stops[0].status = 'SKIPPED';
    expect(decide(arrived, ev('ARRIVED', 1, { stopSeq: 0 }), NOW)).toMatchObject({ outcome: 'REJECTED', code: 'INVALID_STATE' });
  });

  it('clock: at most 2 min in the future (after the offset), not older than 48 h; the offset corrects a wrong device clock', () => {
    const plannedStart = new Date(NOW);
    expect(clockOk(new Date(NOW + 3 * MIN), plannedStart, NOW)).toBe(false);
    expect(clockOk(new Date(NOW + MIN), plannedStart, NOW)).toBe(true);
    expect(clockOk(new Date(NOW - 49 * 3600_000), plannedStart, NOW)).toBe(false);
    const c = correctedTime(new Date(NOW + 10 * MIN).toISOString(), -10 * MIN)!;
    expect(c.at.getTime()).toBe(NOW);
    expect(correctedTime('garbage', 0)).toBeNull();
    expect(decide(snap(), ev('REPORT_DELAY', 1, { occurredAt: new Date(NOW + 10 * MIN) }), NOW)).toMatchObject({ outcome: 'REJECTED', code: 'CLOCK_SKEW' });
  });
});

describe('online-only commands, start window, licence', () => {
  it('a start replayed from an offline queue (device time > 2 min old) is stale', () => {
    expect(onlineCommandFresh(new Date(NOW - 30_000).toISOString(), NOW)).toBe(true);
    expect(onlineCommandFresh(new Date(NOW - 3 * MIN).toISOString(), NOW)).toBe(false);
    expect(onlineCommandFresh(new Date(NOW + 5 * MIN).toISOString(), NOW)).toBe(false);
    expect(onlineCommandFresh('nope', NOW)).toBe(false);
  });

  it('start window: from 60 min before the planned start until 60 min after the planned end', () => {
    const s = new Date(NOW + 30 * MIN);
    const e = new Date(NOW + 90 * MIN);
    expect(withinStartWindow(s, e, NOW)).toBe(true);
    expect(withinStartWindow(new Date(NOW + 61 * MIN), e, NOW)).toBe(false);
    expect(withinStartWindow(new Date(NOW - 3 * 3600_000), new Date(NOW - 61 * MIN), NOW)).toBe(false);
  });

  it('licence: valid through its expiry day; none set is not blocking', () => {
    expect(licenceValid(null, NOW)).toBe(true);
    expect(licenceValid(new Date('2026-11-12T00:00:00Z'), NOW)).toBe(true);
    expect(licenceValid(new Date('2026-11-11T00:00:00Z'), NOW)).toBe(false);
  });
});

describe('shared driver rules (contract)', () => {
  it('display name: first name + last initial; one word as is', () => {
    expect(driverDisplayName('Asha Kumari Rao')).toBe('Asha R.');
    expect(driverDisplayName('  Ravi  ')).toBe('Ravi');
    expect(driverDisplayName('')).toBe('Passenger');
  });

  it('driver outcomes are stricter than the dispatcher’s: no corrections', () => {
    expect(driverOutcomeAllowed('PENDING', 'BOARDED')).toBe(true);
    expect(driverOutcomeAllowed('PENDING', 'DROPPED')).toBe(false);
    expect(driverOutcomeAllowed('BOARDED', 'NO_SHOW')).toBe(false);
    expect(driverOutcomeAllowed('NO_SHOW', 'BOARDED')).toBe(false);
    expect(driverOutcomeAllowed('BOARDED', 'DROPPED')).toBe(true);
  });

  it('trip actions per state', () => {
    expect(driverTripActions({ plannedTripStatus: 'SCHEDULED', publishedAt: new Date(), acknowledgedAt: null })).toEqual(['acknowledge', 'start', 'report']);
    expect(driverTripActions({ plannedTripStatus: 'IN_PROGRESS', publishedAt: new Date(), acknowledgedAt: new Date() })).toEqual(['complete', 'report']);
    expect(driverTripActions({ plannedTripStatus: 'COMPLETED', publishedAt: new Date(), acknowledgedAt: new Date() })).toEqual([]);
  });

  it('passenger push preferences: master switch and per kind; default on', () => {
    expect(passengerPushAllowed({}, 'TRIP_DELAYED')).toBe(true);
    expect(passengerPushAllowed({ notifications: { push: false } }, 'TRIP_DELAYED')).toBe(false);
    expect(passengerPushAllowed({ notifications: { push: true, kinds: { TRIP_STARTING_SOON: false } } }, 'TRIP_STARTING_SOON')).toBe(false);
    expect(passengerPushAllowed({ notifications: { push: true, kinds: { TRIP_STARTING_SOON: false } } }, 'VEHICLE_APPROACHING')).toBe(true);
  });
});
