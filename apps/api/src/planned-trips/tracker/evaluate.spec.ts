import {
  emptyEffects,
  leaveRadiusM,
  ObjectTripState,
  parseObjectTripState,
  prepareTrip,
  PreparedTrip,
  TrackEffects,
  TrackerFix,
  trackFix,
  TrackOptions,
  TripSnap,
  TripStopSnap,
} from './evaluate';

const MIN = 60_000;
const T0 = Date.parse('2026-11-10T08:00:00.000Z');
const LAT = 13;
const M_PER_DEG_LNG = 111_320 * Math.cos((LAT * Math.PI) / 180);
/** Point `east` metres east and `north` metres north of the start stop. */
const at = (east: number, north = 0) => ({ lat: LAT + north / 111_320, lng: 80 + east / M_PER_DEG_LNG });

function stop(seq: number, east: number, offsetMin: number, over: Partial<TripStopSnap> = {}): TripStopSnap {
  return {
    seq,
    name: `S${seq}`,
    ...at(east),
    radiusM: 100,
    plannedArrival: T0 + offsetMin * MIN,
    plannedDeparture: T0 + offsetMin * MIN,
    status: 'PENDING',
    actualArrival: null,
    actualDeparture: null,
    delaySec: null,
    ...over,
  };
}

/** Straight east-bound route: S0 at 0 m, S1 at 2 km (+10 min), S2 at 4 km (+20 min). */
function snap(over: Partial<TripSnap> = {}): TripSnap {
  return {
    id: 'trip1',
    routeName: 'Morning run',
    corridorM: 200,
    path: null,
    plannedStart: T0,
    plannedEnd: T0 + 20 * MIN,
    status: 'SCHEDULED',
    actualStart: null,
    deviationCount: 0,
    maxDeviationM: null,
    distanceKm: null,
    stops: [stop(0, 0, 0), stop(1, 2000, 10), stop(2, 4000, 20)],
    ...over,
  };
}

let ids = 0;
const opts = (over: Partial<TrackOptions> = {}): TrackOptions => ({ lateMin: 10, deviationAlertM: null, newId: () => `id${++ids}`, ...over });
const fix = (tMin: number, east: number, north = 0, speedKph = 30): TrackerFix => ({ t: T0 + tMin * MIN, ...at(east, north), speedKph });

/** Feeds fixes in order, threading the state; returns the final state and all effects. */
function run(trips: PreparedTrip[], fixes: TrackerFix[], o: Partial<TrackOptions> = {}, state: ObjectTripState | null = null) {
  const all: TrackEffects = emptyEffects();
  const steps: TrackEffects[] = [];
  let st = state;
  for (const f of fixes) {
    const r = trackFix(trips, st, f, opts(o));
    st = r.state;
    steps.push(r.effects);
    all.trips.push(...r.effects.trips);
    all.stops.push(...r.effects.stops);
    all.eventOpens.push(...r.effects.eventOpens);
    all.eventCloses.push(...r.effects.eventCloses);
    all.alerts.push(...r.effects.alerts);
    all.live.push(...r.effects.live);
    all.statusChanged ||= r.effects.statusChanged;
  }
  return { state: st!, all, steps };
}

const types = (e: TrackEffects) => e.alerts.map((a) => a.type);

beforeEach(() => {
  ids = 0;
});

describe('prepareTrip', () => {
  it('uses straight legs between stops without a path and measures stops along it', () => {
    const p = prepareTrip(snap());
    expect(p.line).toHaveLength(3);
    expect(p.stopAlong[0]).toBe(0);
    expect(p.stopAlong[1]).toBeCloseTo(2000, -1);
    expect(p.stopAlong[2]).toBeCloseTo(4000, -1);
  });

  it('measures stops along a road path ([lng, lat]) in order', () => {
    const corner = at(2000, 1000);
    const p = prepareTrip(
      snap({
        path: [
          [at(0).lng, at(0).lat],
          [corner.lng, corner.lat],
          [at(4000).lng, at(4000).lat],
        ],
        stops: [stop(0, 0, 0), { ...stop(1, 2000, 10), ...corner }, stop(2, 4000, 20)],
      }),
    );
    expect(p.stopAlong[1]).toBeCloseTo(Math.hypot(2000, 1000), -2);
    expect(p.stopAlong[2]).toBeCloseTo(2 * Math.hypot(2000, 1000), -2);
  });
});

describe('trip selection', () => {
  it('ignores SCHEDULED trips outside plannedStart − 60 min … plannedEnd + 120 min', () => {
    const trips = [prepareTrip(snap())];
    expect(run(trips, [fix(-61, 0)]).state.trip).toBeNull();
    expect(run(trips, [fix(20 + 121, 0)]).state.trip).toBeNull();
    expect(run(trips, [fix(-59, 500)]).state.trip?.id).toBe('trip1');
  });

  it('prefers the candidate whose start radius the vehicle is in, else the nearest planned start', () => {
    const a = prepareTrip(snap({ id: 'a', plannedStart: T0, plannedEnd: T0 + 20 * MIN }));
    const b = prepareTrip(snap({ id: 'b', plannedStart: T0 + 30 * MIN, plannedEnd: T0 + 50 * MIN, stops: [stop(0, 4000, 30), stop(1, 2000, 40), stop(2, 0, 50)] }));
    expect(run([a, b], [fix(20, 1000)]).state.trip?.id).toBe('b'); // 10 min from b's start, 20 from a's
    expect(run([a, b], [fix(20, 4000)]).state.trip).toMatchObject({ id: 'b', status: 'STARTED' });
    expect(run([a, b], [fix(20, 0)]).state.trip).toMatchObject({ id: 'a', status: 'STARTED' });
  });

  it('drops a tracked trip that is no longer open in the cache (cancelled / closed elsewhere)', () => {
    const trips = [prepareTrip(snap())];
    const { state } = run(trips, [fix(-5, 0)]);
    expect(state.trip?.status).toBe('STARTED');
    const r = trackFix([], state, fix(-4, 0), opts());
    expect(r.state.trip).toBeNull();
    expect(r.effects.trips).toEqual([]);
  });

  it('takes the stored progress when the database is ahead (manual start)', () => {
    const watched = run([prepareTrip(snap())], [fix(-5, 600)]).state;
    expect(watched.trip?.status).toBe('SCHEDULED');
    const manual = prepareTrip(
      snap({ status: 'IN_PROGRESS', actualStart: T0, stops: [stop(0, 0, 0, { status: 'DEPARTED', actualDeparture: T0 }), stop(1, 2000, 10), stop(2, 4000, 20)] }),
    );
    const r = trackFix([manual], watched, fix(1, 600), opts());
    expect(r.state.trip).toMatchObject({ status: 'IN_PROGRESS', start: T0 });
    expect(r.state.trip?.stops[0].s).toBe('DEPARTED');
  });

  it('trusts its own state while the cache still shows an older status', () => {
    const trips = [prepareTrip(snap())];
    const { state } = run(trips, [fix(-5, 0), fix(0, 300)]);
    expect(state.trip?.status).toBe('IN_PROGRESS');
    // Cache still says SCHEDULED: no reset.
    expect(trackFix(trips, state, fix(1, 600), opts()).state.trip?.status).toBe('IN_PROGRESS');
  });

  it('ignores a fix older than the last one', () => {
    const trips = [prepareTrip(snap())];
    const { state } = run(trips, [fix(-5, 0), fix(0, 300)]);
    const r = trackFix(trips, state, fix(-1, 0), opts());
    expect(r.effects.trips).toEqual([]);
    expect(r.state.trip?.status).toBe('IN_PROGRESS');
  });
});

describe('start', () => {
  it('SCHEDULED → STARTED inside the start radius, → IN_PROGRESS when leaving it', () => {
    const trips = [prepareTrip(snap())];
    const { steps, state } = run(trips, [fix(-10, 30), fix(-5, 50), fix(2, 50 + leaveRadiusM(100))]);
    expect(steps[0].trips[0]).toEqual({ id: 'trip1', data: expect.objectContaining({ status: 'STARTED' }) });
    expect(steps[0].stops).toEqual([{ tripId: 'trip1', seq: 0, status: 'ARRIVED', actualArrival: T0 - 10 * MIN }]);
    expect(steps[0].statusChanged).toBe(true);
    expect(steps[1].trips.some((t) => t.data.status)).toBe(false);
    expect(steps[2].trips[0].data).toMatchObject({ status: 'IN_PROGRESS', actualStart: T0 + 2 * MIN, nextStopSeq: 1 });
    // Start stop: departure + start delay (vs planned departure).
    expect(steps[2].stops).toEqual([{ tripId: 'trip1', seq: 0, status: 'DEPARTED', actualDeparture: T0 + 2 * MIN, delaySec: 120 }]);
    expect(state.trip).toMatchObject({ status: 'IN_PROGRESS', start: T0 + 2 * MIN, at: null });
  });

  it('does not leave on GPS jitter just outside the radius', () => {
    const { state } = run([prepareTrip(snap())], [fix(-5, 0), fix(-4, 105)]);
    expect(state.trip?.status).toBe('STARTED');
  });

  it('starts without having been seen inside when moving away from within 2 × radius', () => {
    const { steps, state } = run([prepareTrip(snap())], [fix(1, 150), fix(2, 400)]);
    expect(steps[0].trips).toEqual([]);
    expect(steps[1].trips[0].data).toMatchObject({ status: 'IN_PROGRESS', actualStart: T0 + 2 * MIN });
    expect(steps[1].stops[0]).toMatchObject({ seq: 0, status: 'DEPARTED', actualDeparture: T0 + 2 * MIN });
    expect(state.trip?.stops[0].a).toBeNull();
  });

  it('does not start from farther away, nor when standing still near the start', () => {
    expect(run([prepareTrip(snap())], [fix(1, 500), fix(2, 900)]).state.trip?.status).toBe('SCHEDULED');
    expect(run([prepareTrip(snap())], [fix(1, 150, 0, 0), fix(2, 160, 0, 1)]).state.trip?.status).toBe('SCHEDULED');
  });
});

/** Started and on the road, 500 m past the start at T0 + 1 min. */
function inProgress(trips = [prepareTrip(snap())], o: Partial<TrackOptions> = {}) {
  return run(trips, [fix(-5, 0), fix(0, 200), fix(1, 500)], o).state;
}

describe('stops', () => {
  it('arrival: ARRIVED with delay; leaving: DEPARTED', () => {
    const trips = [prepareTrip(snap())];
    const { steps, state } = run(trips, [fix(12, 1950, 0, 20), fix(14, 2200)], {}, inProgress(trips));
    expect(steps[0].stops).toEqual([{ tripId: 'trip1', seq: 1, status: 'ARRIVED', actualArrival: T0 + 12 * MIN, delaySec: 120 }]);
    expect(types(steps[0])).toEqual([]); // 2 min late < 10 min threshold
    expect(steps[1].stops).toEqual([{ tripId: 'trip1', seq: 1, status: 'DEPARTED', actualDeparture: T0 + 14 * MIN }]);
    expect(steps[0].live[0].stops?.[1]).toEqual({ seq: 1, status: 'ARRIVED', actualArrival: new Date(T0 + 12 * MIN).toISOString(), actualDeparture: null, delaySec: 120 });
    expect(state.trip?.at).toBeNull();
  });

  it('late arrival beyond the setting raises TRIP_STOP_LATE with stop and delay', () => {
    const trips = [prepareTrip(snap())];
    const { all } = run(trips, [fix(25, 2000)], { lateMin: 10 }, inProgress(trips));
    expect(all.alerts).toEqual([
      expect.objectContaining({
        type: 'TRIP_STOP_LATE',
        tripId: 'trip1',
        cooldownKey: 'TRIP_STOP_LATE:trip1:1',
        data: expect.objectContaining({ tripId: 'trip1', routeName: 'Morning run', stopName: 'S1', delayMin: 15 }),
      }),
    ]);
    expect(run(trips, [fix(25, 2000)], { lateMin: 20 }, inProgress(trips)).all.alerts).toEqual([]);
  });

  it('reaching a later stop first skips the PENDING ones before it (alert per skipped stop)', () => {
    const trips = [prepareTrip(snap({ stops: [stop(0, 0, 0), stop(1, 1000, 5, { lat: at(1000, 3000).lat }), stop(2, 2000, 10), stop(3, 4000, 20)] }))];
    const { all, state } = run(trips, [fix(9, 2000)], {}, inProgress(trips));
    expect(all.stops).toEqual([
      { tripId: 'trip1', seq: 1, status: 'SKIPPED' },
      { tripId: 'trip1', seq: 2, status: 'ARRIVED', actualArrival: T0 + 9 * MIN, delaySec: -60 },
    ]);
    expect(all.alerts.map((a) => [a.type, a.data.stopName, a.cooldownKey])).toEqual([['TRIP_STOP_SKIPPED', 'S1', 'TRIP_STOP_SKIPPED:trip1:1']]);
    expect(state.trip?.stops.map((s) => s.s)).toEqual(['DEPARTED', 'SKIPPED', 'ARRIVED', 'PENDING']);
  });

  it('arrival at the last stop completes the trip (AUTO), closing it for good', () => {
    const trips = [prepareTrip(snap())];
    const { all, state } = run(trips, [fix(11, 2000), fix(13, 2300), fix(22, 3950)], {}, inProgress(trips));
    const done = all.trips.find((t) => t.data.status === 'COMPLETED')!;
    expect(done.data).toMatchObject({ actualEnd: T0 + 22 * MIN, closedBy: 'AUTO', nextStopSeq: null, etaNextStop: null, delaySec: 120, deviationCount: 0 });
    expect(Math.abs(done.data.distanceKm! - 3.75)).toBeLessThanOrEqual(0.06); // 200 m → 3950 m
    expect(all.alerts.map((a) => a.type)).toEqual(['TRIP_COMPLETED']);
    expect(all.alerts[0].data).toMatchObject({ delayMin: 2 });
    expect(all.live.at(-1)).toMatchObject({ id: 'trip1', status: 'COMPLETED', actualEnd: new Date(T0 + 22 * MIN).toISOString(), nextStopSeq: null, etaNextStop: null });
    expect(state.trip).toBeNull();
    expect(state.closed).toEqual(['trip1']);
    // The (stale) cache still lists the trip as open: it is not picked again.
    const again = trackFix(trips, state, fix(30, 3950), opts());
    expect(again.state.trip).toBeNull();
    expect(again.effects.trips).toEqual([]);
  });
});

describe('deviation', () => {
  it('opens after 2 consecutive fixes outside the corridor, alerts, and closes back inside with the max distance', () => {
    const trips = [prepareTrip(snap())];
    const { steps, state } = run(trips, [fix(2, 800, 300), fix(3, 900, 450), fix(4, 1000, 350), fix(5, 1100, 50)], {}, inProgress(trips));
    expect(steps[0].eventOpens).toEqual([]);
    expect(types(steps[0])).toEqual([]);
    expect(steps[1].eventOpens).toEqual([{ id: 'id1', tripId: 'trip1', kind: 'DEVIATION', startAt: T0 + 2 * MIN, lat: at(800, 300).lat, lng: at(800, 300).lng }]);
    expect(steps[1].trips[0].data).toMatchObject({ deviationCount: 1, maxDeviationM: 450 });
    expect(steps[1].alerts).toEqual([expect.objectContaining({ type: 'ROUTE_DEVIATION', cooldownKey: 'ROUTE_DEVIATION:trip1', data: expect.objectContaining({ distanceM: 450, corridorM: 200 }) })]);
    expect(types(steps[2])).toEqual([]); // once per episode
    expect(steps[3].eventCloses).toEqual([{ id: 'id1', endAt: T0 + 5 * MIN, data: { maxM: 450 } }]);
    expect(state.trip).toMatchObject({ devN: 1, devMax: 450, dev: null, out: 0 });
  });

  it('a single stray fix outside the corridor is not a deviation', () => {
    const trips = [prepareTrip(snap())];
    const { all } = run(trips, [fix(2, 800, 400), fix(3, 900, 20)], {}, inProgress(trips));
    expect(all.eventOpens).toEqual([]);
    expect(all.alerts).toEqual([]);
  });

  it('alerts only beyond the setting minDistanceM (when larger than the corridor)', () => {
    const trips = [prepareTrip(snap())];
    const { steps } = run(trips, [fix(2, 800, 300), fix(3, 900, 350), fix(4, 1000, 700)], { deviationAlertM: 600 }, inProgress(trips));
    expect(steps[1].eventOpens).toHaveLength(1);
    expect(types(steps[1])).toEqual([]);
    expect(steps[2].alerts[0]).toMatchObject({ type: 'ROUTE_DEVIATION', data: expect.objectContaining({ distanceM: 700 }) });
  });

  it('measures against the road path when the trip has one', () => {
    const corner = at(2000, 1000);
    const trips = [
      prepareTrip(
        snap({
          path: [
            [at(0).lng, at(0).lat],
            [corner.lng, corner.lat],
            [at(4000).lng, at(4000).lat],
          ],
        }),
      ),
    ];
    const start = run(trips, [fix(-5, 0), fix(0, 200, 100), fix(1, 400, 200)]).state;
    // On the path's diagonal (≈ 500 m north of the straight line): no deviation.
    expect(run(trips, [fix(2, 1000, 500), fix(3, 1200, 600)], {}, start).all.eventOpens).toEqual([]);
    // On the straight line under the corner: off the path.
    expect(run(trips, [fix(2, 1800, 0), fix(3, 2000, 0)], {}, start).all.eventOpens).toHaveLength(1);
  });
});

describe('unscheduled stop', () => {
  it('standing still ≥ 5 min outside every stop radius opens an event; moving again closes it with the duration', () => {
    const trips = [prepareTrip(snap())];
    const { steps } = run(trips, [fix(2, 1000, 0, 0), fix(4, 1000, 0, 2), fix(7, 1002, 0, 1), fix(9, 1100, 0, 25)], {}, inProgress(trips));
    expect(steps[1].eventOpens).toEqual([]);
    expect(steps[2].eventOpens).toEqual([{ id: 'id1', tripId: 'trip1', kind: 'UNSCHEDULED_STOP', startAt: T0 + 2 * MIN, lat: at(1000).lat, lng: at(1000).lng }]);
    expect(steps[3].eventCloses).toEqual([{ id: 'id1', endAt: T0 + 9 * MIN, data: { durationSec: 420 } }]);
  });

  it('a short halt or waiting at a stop is not an unscheduled stop', () => {
    const trips = [prepareTrip(snap())];
    expect(run(trips, [fix(2, 1000, 0, 0), fix(5, 1000, 0, 0), fix(6, 1100, 0, 30)], {}, inProgress(trips)).all.eventOpens).toEqual([]);
    expect(run(trips, [fix(10, 2000, 0, 0), fix(20, 2010, 0, 0)], {}, inProgress(trips)).all.eventOpens).toEqual([]);
  });
});

describe('ETA / delay', () => {
  it('ETA = now + remaining distance ÷ max(recent average speed, 20 km/h); delay vs planned arrival', () => {
    const trips = [prepareTrip(snap())];
    const state = inProgress(trips);
    // 1 km before S1 at T0 + 2 min, slow (10 km/h recent average → floor 20 km/h): 1000 m / 5.556 m/s = 180 s.
    const r = trackFix(trips, { ...state, trip: { ...state.trip!, spd: [] } }, fix(2.5, 1000, 0, 10), opts());
    const u = r.effects.trips[0].data;
    expect(u.nextStopSeq).toBe(1);
    expect(u.etaNextStop! - (T0 + 2.5 * MIN)).toBeCloseTo(180_000, -3);
    expect(u.delaySec).toBeCloseTo((T0 + 2.5 * MIN + 180_000 - (T0 + 10 * MIN)) / 1000, -1);
    expect(r.effects.live[0]).toMatchObject({ id: 'trip1', status: 'IN_PROGRESS', nextStopSeq: 1 });
  });

  it('uses the recent average speed when above the floor', () => {
    const trips = [prepareTrip(snap())];
    const state = inProgress(trips);
    const r = trackFix(trips, { ...state, trip: { ...state.trip!, spd: [] } }, fix(3, 1000, 0, 60), opts());
    expect(r.effects.trips[0].data.etaNextStop! - (T0 + 3 * MIN)).toBeCloseTo(60_000, -3); // 1 km at 60 km/h
  });

  it('is recomputed at most once a minute per trip', () => {
    const trips = [prepareTrip(snap())];
    const state = inProgress(trips); // last ETA at T0 + 1 min
    const { steps } = run(trips, [fix(1.5, 700), fix(2.1, 900)], {}, state);
    expect(steps[0].trips).toEqual([]);
    expect(steps[0].live).toEqual([]);
    expect(steps[1].trips[0].data).toHaveProperty('etaNextStop');
  });

  it('is capped by the routing engine time for that trip and stop', () => {
    const trips = [prepareTrip(snap())];
    const state = inProgress(trips);
    const r = trackFix(trips, state, fix(3, 1000, 0, 10), opts({ routeEta: { tripId: 'trip1', seq: 1, sec: 60 } }));
    expect(r.effects.trips[0].data.etaNextStop).toBe(T0 + 3 * MIN + 60_000);
    const other = trackFix(trips, state, fix(3, 1000, 0, 10), opts({ routeEta: { tripId: 'trip1', seq: 2, sec: 60 } }));
    expect(other.effects.trips[0].data.etaNextStop).toBeGreaterThan(T0 + 3 * MIN + 60_000);
  });

  it('while waiting at the start, the ETA counts from the planned departure', () => {
    const trips = [prepareTrip(snap())];
    const { steps } = run(trips, [fix(-30, 0, 0, 0)]);
    const u = steps[0].trips[0].data;
    expect(u.status).toBe('STARTED');
    expect(u.nextStopSeq).toBe(1);
    // Leaves at T0, 2 km at 20 km/h = 360 s → 4 min early for S1 (planned T0 + 10 min).
    expect(u.etaNextStop! - T0).toBeCloseTo(360_000, -3);
    expect(u.delaySec).toBeCloseTo(-240, -1);
  });
});

describe('a newer trip of the same vehicle', () => {
  it('closes the active trip INCOMPLETE (TIMEOUT), skipping its pending stops, and starts the newer one', () => {
    const first = prepareTrip(snap({ id: 'first' }));
    const second = prepareTrip(snap({ id: 'second', plannedStart: T0 + 40 * MIN, plannedEnd: T0 + 60 * MIN, stops: [stop(0, 3000, 40), stop(1, 1000, 50), stop(2, -1000, 60)] }));
    const state = inProgress([first, second]);
    const { all, state: next } = run([first, second], [fix(35, 3000, 0, 0)], {}, state);
    expect(Object.assign({}, ...all.trips.filter((t) => t.id === 'first').map((t) => t.data))).toMatchObject({ status: 'INCOMPLETE', closedBy: 'TIMEOUT', nextStopSeq: null });
    expect(all.stops.filter((s) => s.tripId === 'first')).toEqual([
      { tripId: 'first', seq: 1, status: 'SKIPPED' },
      { tripId: 'first', seq: 2, status: 'SKIPPED' },
    ]);
    expect(all.alerts.filter((a) => a.type === 'TRIP_STOP_SKIPPED')).toEqual([]);
    expect(all.trips.find((t) => t.id === 'second')?.data).toMatchObject({ status: 'STARTED' });
    expect(next.trip).toMatchObject({ id: 'second', status: 'STARTED' });
    expect(next.closed).toEqual(['first']);
  });
});

describe('state', () => {
  it('parses stored state and rejects garbage', () => {
    const { state } = run([prepareTrip(snap())], [fix(-5, 0)]);
    expect(parseObjectTripState(JSON.stringify(state))).toEqual(state);
    expect(parseObjectTripState('{"v":2}')).toBeNull();
    expect(parseObjectTripState('nope')).toBeNull();
    expect(parseObjectTripState(null)).toBeNull();
  });

  it('is deterministic and does not mutate the previous state', () => {
    const trips = [prepareTrip(snap())];
    const prev = inProgress(trips);
    const copy = JSON.stringify(prev);
    const a = trackFix(trips, prev, fix(12, 2000), opts());
    ids = 0;
    const b = trackFix(trips, prev, fix(12, 2000), opts());
    expect(JSON.stringify(prev)).toBe(copy);
    expect(a.state).toEqual(b.state);
    expect(a.effects).toEqual(b.effects);
  });

  it('drops cooldown marks older than a day', () => {
    const trips = [prepareTrip(snap())];
    const r = trackFix(trips, { v: 1, trip: null, closed: [], cd: { old: T0 - 27 * 3600_000, fresh: T0 - 3600_000 } }, fix(-120, 0), opts());
    expect(r.state.cd).toEqual({ fresh: T0 - 3600_000 });
  });
});
