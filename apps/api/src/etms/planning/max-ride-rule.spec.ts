import { maxRideViolations, publishIssues, routeViolations, type RuleStop } from './plan-rules';
import { effectiveMaxRideS } from '../../routing-jobs/max-ride';

/**
 * E4 decisions review D-M1: the server computes `max_ride_exceeded` from the stored ETAs (the solver's definition:
 * IN = site arrival − pickup service start, OUT = drop service start − site departure; an ETA is the service start),
 * against the plan's effective max ride, so a manual edit after an optimisation surfaces it as a SOFT publish warning.
 */
let n = 0;
const stop = (o: Partial<RuleStop>): RuleStop => ({
  id: `s${++n}`,
  ref: `r${n}`,
  assignmentId: 'A',
  sequence: n,
  etaS: 0,
  serviceS: 0,
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
const seats = () => 1;
const HOUR = 3600;

describe('D-M1: max ride on the server', () => {
  it('IN: pickup → site drop longer than the max ride is max_ride_exceeded on the passenger’s pickup; within it is not', () => {
    const p1 = stop({ id: 'p1', stopKind: 'PICKUP', bookingId: 'b1', etaS: 0 });
    const p2 = stop({ id: 'p2', stopKind: 'PICKUP', bookingId: 'b2', etaS: 2400 });
    const d1 = stop({ id: 'd1', stopKind: 'DROP', bookingId: 'b1', etaS: 5700 });
    const d2 = stop({ id: 'd2', stopKind: 'DROP', bookingId: 'b2', etaS: 5700 });
    const v = maxRideViolations([p1, p2, d1, d2], 3600, 'IN');
    expect(v).toEqual([{ stopId: 'p1', ref: p1.ref, kind: 'max_ride_exceeded', etaS: 0, window: null }]);
    expect(maxRideViolations([p1, p2, d1, d2], null, 'IN')).toEqual([]);
  });

  it('OUT: site pickup → drop; the warning is on the passenger’s drop', () => {
    const p1 = stop({ id: 'p1', stopKind: 'PICKUP', bookingId: 'b1', etaS: 0 });
    const d1 = stop({ id: 'd1', stopKind: 'DROP', bookingId: 'b1', etaS: 2 * HOUR });
    expect(maxRideViolations([p1, d1], HOUR, 'OUT')).toEqual([{ stopId: 'd1', ref: d1.ref, kind: 'max_ride_exceeded', etaS: 2 * HOUR, window: null }]);
  });

  it('no ETA, or ends on different routes: nothing claimed', () => {
    const p1 = stop({ id: 'p1', stopKind: 'PICKUP', bookingId: 'b1', etaS: null });
    const d1 = stop({ id: 'd1', stopKind: 'DROP', bookingId: 'b1', etaS: 2 * HOUR });
    expect(maxRideViolations([p1, d1], HOUR, 'IN')).toEqual([]);
  });

  it('is part of routeViolations and a SOFT publish warning (in the fingerprint), never hard', () => {
    const p1 = stop({ id: 'p1', stopKind: 'PICKUP', bookingId: 'b1', etaS: 0 });
    const d1 = stop({ id: 'd1', stopKind: 'DROP', bookingId: 'b1', etaS: 2 * HOUR });
    expect(routeViolations([p1, d1], 4, seats, false, { maxRideS: HOUR, direction: 'IN' }).map((v) => v.kind)).toEqual(['max_ride_exceeded']);
    const r = publishIssues([{ id: 'A', vehicleLabel: 'Van 1', capacity: 4 }], [p1, d1], seats, { maxRideS: HOUR, direction: 'IN' });
    expect(r.hard).toEqual([]);
    expect(r.soft.map((i) => [i.stopId, i.kind])).toEqual([['p1', 'max_ride_exceeded']]);
    expect(r.fingerprint).not.toBeNull();
    expect(publishIssues([{ id: 'A', vehicleLabel: 'Van 1', capacity: 4 }], [p1, d1], seats).soft).toEqual([]);
  });

  it('effective max ride: the last optimisation’s snapshot (even "none"), else the plan override, else the policy now', () => {
    expect(effectiveMaxRideS({ maxRideS: 3600, maxRideSource: 'policy' }, 5400)).toBe(3600);
    expect(effectiveMaxRideS({ maxRideSource: 'none' }, 5400)).toBeNull();
    expect(effectiveMaxRideS({ maxRideOverride: { maxRideS: 7200, reason: 'Long trip today', setById: null, setAt: '' } }, 5400)).toBe(7200);
    expect(effectiveMaxRideS({}, 5400)).toBe(5400);
    expect(effectiveMaxRideS(null, null)).toBeNull();
  });
});
