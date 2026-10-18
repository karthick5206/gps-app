import {
  cloneState,
  createState,
  DayAcc,
  daySeconds,
  emptyOutput,
  extendOffline,
  processPoint,
  SegConfig,
  SegOutput,
  SegPoint,
  SegState,
  StopOut,
  TripOut,
} from './segmenter';
import { addDays, localDayRange } from './tz';

const TZ = 'Asia/Kolkata';
const cfg: SegConfig = { tz: TZ, runningSpeedKph: 5, offlineAfterSec: 600, speedLimitKph: 80, maxPlausibleKph: 200 };
const M_PER_DEG_LAT = 111_195;

/** Builds a point stream: drive / stand still, advancing time and position. */
class Track {
  points: SegPoint[] = [];
  constructor(
    public t: number,
    public lat = 13.05,
    public lng = 80.2,
  ) {}
  drive(sec: number, kph: number, every = 10, ign: boolean | null = true): this {
    for (let s = 0; s < sec; s += every) {
      this.t += every * 1000;
      this.lat += ((kph / 3.6) * every) / M_PER_DEG_LAT;
      this.points.push({ t: this.t, lat: this.lat, lng: this.lng, speed: kph, ign });
    }
    return this;
  }
  stand(sec: number, ign: boolean | null, every = 10): this {
    for (let s = 0; s < sec; s += every) {
      this.t += every * 1000;
      this.points.push({ t: this.t, lat: this.lat, lng: this.lng, speed: 0, ign });
    }
    return this;
  }
  silence(sec: number): this {
    this.t += sec * 1000;
    return this;
  }
}

function run(points: SegPoint[], state = createState(), out = emptyOutput()): { state: SegState; out: SegOutput } {
  for (const p of points) processPoint(state, p, cfg, out);
  return { state, out };
}

function totalMs(d: DayAcc): number {
  return d.runningMs + d.idleMs + d.stopMs + d.offlineMs;
}

// 2026-10-17 08:30 IST
const T0 = Date.parse('2026-10-17T03:00:00Z');

describe('trip / stop segmentation', () => {
  it('splits trips at a long parked stop and records the stop', () => {
    const tr = new Track(T0).drive(600, 36).stand(600, false).drive(300, 48);
    const { state, out } = run(tr.points);
    expect(out.trips).toHaveLength(1); // second trip still open
    expect(out.stops).toHaveLength(1);
    const trip = out.trips[0];
    expect(trip.distanceKm).toBeCloseTo(5.9, 1); // 36 km/h × 10 min, first fix after 10 s
    expect(trip.durationSec).toBeCloseTo(600, -1);
    expect(out.stops[0].ignitionOn).toBe(false);
    expect(out.stops[0].durationSec).toBeGreaterThanOrEqual(600);
    expect(state.trip).not.toBeNull();
    expect(trip.end).toBe(out.stops[0].start);
  });

  it('drops trips shorter than 0.2 km', () => {
    const tr = new Track(T0).stand(60, false).drive(10, 36).stand(600, false); // 100 m
    const { out } = run(tr.points);
    expect(out.trips).toHaveLength(0);
  });

  it('keeps short idle within a trip, records 3–5 min stops without splitting, splits at ≥ 5 min', () => {
    const tr = new Track(T0)
      .drive(300, 40)
      .stand(120, true) // traffic light: no stop
      .drive(300, 40)
      .stand(240, true) // 4 min idle: stop, same trip
      .drive(300, 40)
      .stand(400, true) // ≥ 5 min: splits the trip
      .drive(300, 40);
    const { out } = run(tr.points);
    expect(out.stops).toHaveLength(2);
    expect(out.stops.every((s) => s.ignitionOn)).toBe(true);
    expect(out.stops[0].durationSec).toBeGreaterThanOrEqual(240);
    expect(out.stops[0].durationSec).toBeLessThan(300);
    expect(out.trips).toHaveLength(1);
    const trip = out.trips[0];
    expect(trip.idleSec).toBeGreaterThanOrEqual(360);
    expect(trip.idleSec).toBeLessThanOrEqual(380);
    expect(trip.distanceKm).toBeCloseTo(10, 0);
    expect(trip.maxSpeedKph).toBe(40);
  });

  it('marks a stop as parked when ignition went off during it', () => {
    const tr = new Track(T0).drive(300, 40).stand(120, true).stand(300, false).drive(300, 40);
    const { out } = run(tr.points);
    expect(out.stops).toHaveLength(1);
    expect(out.stops[0].ignitionOn).toBe(false);
  });

  it('continues a stop across an offline gap at the same place, splits trips on a gap while driving', () => {
    const tr = new Track(T0).drive(300, 40).stand(120, false).silence(3600).stand(60, false).drive(300, 40);
    const { out } = run(tr.points);
    expect(out.stops).toHaveLength(1);
    expect(out.stops[0].durationSec).toBeGreaterThan(3600);
    expect(out.trips).toHaveLength(1);

    const tr2 = new Track(T0).drive(300, 40).silence(1200).drive(300, 40).stand(400, false);
    const r2 = run(tr2.points);
    expect(r2.out.trips).toHaveLength(2);
  });

  it('ignores implausible jumps for distance', () => {
    const tr = new Track(T0).drive(300, 40);
    const jump = { ...tr.points[tr.points.length - 1] };
    tr.t += 10_000;
    tr.points.push({ ...jump, t: tr.t, lat: jump.lat + 1 }); // 111 km in 10 s
    const { state } = run(tr.points);
    expect(state.day!.distanceM).toBeLessThan(4000);
  });
});

describe('daily summary accounting', () => {
  it('running + idle + stop + offline add up to the accounted part of the day', () => {
    const tr = new Track(T0).drive(1800, 50).stand(300, true).stand(900, false).silence(1800).stand(30, false).drive(600, 90);
    const { state } = run(tr.points);
    const d = state.day!;
    expect(totalMs(d)).toBe(state.at! - d.start);
    const s = daySeconds(d);
    expect(s.runningSec + s.idleSec + s.stopSec + s.offlineSec).toBe(Math.round((state.at! - d.start) / 1000));
    expect(s.offlineSec).toBeGreaterThanOrEqual(8.5 * 3600 + 1800); // midnight → 08:30 plus the silence
    expect(s.idleSec).toBeCloseTo(300, -1);
    expect(d.overspeedCount).toBe(1);
    expect(s.overspeedSec).toBeCloseTo(590, -1); // interval before the first fast fix belongs to the stop
    expect(s.engineSec).toBeCloseTo(1800 + 300 + 590, -1);
    expect(d.maxSpeed).toBe(90);
    expect(d.distanceM / 1000).toBeCloseTo(25 + 15, 0);
  });

  it('merges overspeed bursts less than a minute apart into one episode', () => {
    const tr = new Track(T0).drive(60, 50).drive(60, 95).drive(30, 70).drive(60, 95).drive(120, 70).drive(60, 95).drive(60, 50);
    const { state } = run(tr.points);
    expect(state.day!.overspeedCount).toBe(2);
  });

  it('splits a drive across local midnight into two days that each add up', () => {
    const start = Date.parse('2026-10-17T18:20:00Z'); // 23:50 IST
    const tr = new Track(start).drive(1200, 60); // until 00:10 IST
    const out = emptyOutput();
    const { state } = run(tr.points, createState(), out);
    expect(out.days).toHaveLength(1);
    const d1 = out.days[0];
    expect(d1.day).toBe('2026-10-17');
    expect(totalMs(d1)).toBe(86_400_000);
    expect(d1.runningMs).toBe(590_000); // first fix at 23:50:10
    expect(state.day!.day).toBe('2026-10-18');
    expect(state.day!.runningMs).toBe(state.at! - state.day!.start);
    expect(d1.distanceM / 1000 + state.day!.distanceM / 1000).toBeCloseTo(20 - 1 / 6, 1);
    expect(d1.distanceM / 1000).toBeCloseTo(10 - 1 / 6, 1);
    expect(out.snapshots.map((s) => s.day)).toEqual(['2026-10-18']);
  });

  it('closes out silent days as offline', () => {
    const tr = new Track(T0).drive(600, 40).stand(600, false);
    const { state } = run(tr.points);
    const out = emptyOutput();
    const midnight2 = localDayRange(addDays('2026-10-17', 2), TZ).start;
    extendOffline(state, midnight2, cfg, out);
    expect(out.days.map((d) => d.day)).toEqual(['2026-10-17']);
    expect(totalMs(out.days[0])).toBe(86_400_000);
    expect(state.day!.day).toBe('2026-10-18');
    expect(state.day!.offlineMs).toBe(86_400_000);
    expect(state.at).toBe(midnight2);
    expect(out.snapshots.map((s) => s.day)).toEqual(['2026-10-18']);
  });
});

/** Emulates the database side of the summarizer (upsert by key, delete + rebuild from a day snapshot). */
class FakeStore {
  trips = new Map<number, TripOut>();
  stops = new Map<number, StopOut>();
  days = new Map<string, DayAcc>();
  snapshots = new Map<string, SegState>();
  state = createState();

  apply(out: SegOutput) {
    for (const t of out.trips) this.trips.set(t.start, t);
    for (const s of out.stops) this.stops.set(s.start, s);
    for (const d of out.days) this.days.set(d.day, d);
    if (this.state.day) this.days.set(this.state.day.day, this.state.day);
    for (const s of out.snapshots) this.snapshots.set(s.day, s.state);
  }

  ingest(points: SegPoint[]) {
    const out = emptyOutput();
    for (const p of points) processPoint(this.state, p, cfg, out);
    this.apply(structuredClone(out));
    this.state = cloneState(this.state);
  }

  recompute(dirtyDay: string, all: SegPoint[]) {
    const snapDay = [...this.snapshots.keys()].filter((k) => k <= dirtyDay).sort().pop();
    if (!snapDay) {
      // No snapshot at or before the dirty day: full rebuild.
      this.trips.clear();
      this.stops.clear();
      this.days.clear();
      this.snapshots.clear();
      this.state = createState();
      this.ingest(all);
      return;
    }
    const m = localDayRange(snapDay, TZ).start;
    for (const [k, t] of this.trips) if (t.start >= m || t.end > m) this.trips.delete(k);
    for (const [k, s] of this.stops) if (s.start >= m || s.end > m) this.stops.delete(k);
    for (const k of [...this.days.keys()]) if (k >= snapDay) this.days.delete(k);
    this.state = cloneState(this.snapshots.get(snapDay)!);
    this.ingest(all.filter((p) => p.t > m));
  }

  dump() {
    const sort = <T>(m: Map<number | string, T>) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v);
    return { trips: sort(this.trips), stops: sort(this.stops), days: sort(this.days) };
  }
}

describe('late data recomputation', () => {
  it('produces identical results whether data arrived in order or late', () => {
    const start = Date.parse('2026-10-16T12:00:00Z'); // 17:30 IST
    const tr = new Track(start);
    for (let i = 0; i < 40; i++) tr.drive(1500, 30 + i * 5).stand(i % 2 ? 900 : 200, i % 3 === 0).silence(i % 4 === 0 ? 1800 : 0);
    const all = tr.points;

    const inOrder = new FakeStore();
    inOrder.ingest(all);

    // Same data, but a slice in the middle (on day 2) arrives only after everything else.
    const lateFrom = Math.floor(all.length * 0.45);
    const lateTo = Math.floor(all.length * 0.55);
    const late = all.slice(lateFrom, lateTo);
    const early = [...all.slice(0, lateFrom), ...all.slice(lateTo)];
    const store = new FakeStore();
    store.ingest(early.slice(0, Math.floor(early.length / 2)));
    store.ingest(early.slice(Math.floor(early.length / 2)));
    const dirtyDay = new Date(late[0].t + 5.5 * 3600_000).toISOString().slice(0, 10);
    expect(dirtyDay > '2026-10-16').toBe(true); // exercises the snapshot path
    store.recompute(dirtyDay, all);

    expect(store.dump()).toEqual(inOrder.dump());

    // Late data on the very first day (no snapshot) → full rebuild, same result.
    const store2 = new FakeStore();
    store2.ingest(all.filter((_, i) => i % 7 !== 3));
    store2.recompute('2026-10-16', all);
    expect(store2.dump()).toEqual(inOrder.dump());
    expect(inOrder.dump().days.length).toBeGreaterThanOrEqual(2);
    expect(inOrder.dump().trips.length).toBeGreaterThan(3);
  });
});
