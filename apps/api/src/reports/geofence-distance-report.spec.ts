import { PosRow } from '../summarizer/positions';
import { DistanceInterval, IntervalDistance, geofenceTrips } from './geofence-distance-report';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 1, 4);
const cfg = { runningSpeedKph: 5, maxPlausibleKph: 200 };
// 0.01° of latitude ≈ 1.112 km; one step a minute ≈ 67 km/h.
const pt = (min: number, north: number, flags = 0): PosRow => ({ t: T0 + min * MIN, lat: 13 + north * 0.01, lng: 80, speed: 60, course: 0, ign: true, flags });
const iv = (from: number, to: number): DistanceInterval => ({ from: T0 + from * MIN, to: T0 + to * MIN, metres: 0 });
const km = (v: DistanceInterval) => Math.round(v.metres) / 1000;

describe('IntervalDistance', () => {
  it('splits a drive between the visit and the leg from the previous geofence', () => {
    const between = iv(0, 2);
    const inside = iv(2, 3);
    new IntervalDistance([between, inside], cfg).add([pt(0, 0), pt(1, 1), pt(2, 2), pt(3, 3), pt(4, 4)]);
    expect(km(between)).toBeCloseTo(2.224, 1);
    expect(km(inside)).toBeCloseTo(1.112, 1);
  });

  it('counts a step that crosses the edge by its share of time inside', () => {
    const v = iv(0.5, 5);
    new IntervalDistance([v], cfg).add([pt(0, 0), pt(1, 1)]);
    expect(km(v)).toBeCloseTo(0.556, 1);
  });

  it('gives the same distance when the points arrive in pages', () => {
    const a = iv(0, 4);
    const b = iv(0, 4);
    const rows = [pt(0, 0), pt(1, 1), pt(2, 2), pt(3, 3), pt(4, 4)];
    new IntervalDistance([a], cfg).add(rows);
    const paged = new IntervalDistance([b], cfg);
    paged.add(rows.slice(0, 2));
    paged.add(rows.slice(2));
    expect(b.metres).toBeCloseTo(a.metres, 6);
  });

  it('counts overlapping intervals (a geofence nested in another) in both', () => {
    const outer = iv(0, 4);
    const inner = iv(1, 2);
    new IntervalDistance([outer, inner], cfg).add([pt(0, 0), pt(1, 1), pt(2, 2), pt(3, 3), pt(4, 4)]);
    expect(km(outer)).toBeCloseTo(4.448, 1);
    expect(km(inner)).toBeCloseTo(1.112, 1);
  });

  it('ignores an impossible jump, like trips do', () => {
    const v = iv(0, 2);
    new IntervalDistance([v], cfg).add([pt(0, 0), pt(1, 500), pt(2, 500)]);
    expect(km(v)).toBe(0);
  });
});

describe('geofenceTrips', () => {
  const at = (min: number) => new Date(T0 + min * MIN);
  const visit = (id: string, from: number, to: number | null) => ({ id, enterTime: at(from), exitTime: to === null ? null : at(to) });
  const ids = (v: ReturnType<typeof visit>[]) => geofenceTrips(v).map((t) => `${t.from.id}>${t.to?.id ?? '?'}`);

  it('from each out time to the next in time, and the last one still open', () => {
    expect(ids([visit('A', 0, 10), visit('B', 20, 30), visit('C', 40, 50)])).toEqual(['A>B', 'B>C', 'C>?']);
  });

  it('counts a return to the same geofence', () => {
    expect(ids([visit('A', 0, 10), visit('A', 20, 30)])).toEqual(['A>A', 'A>?']);
  });

  it('still inside the last geofence: no open trip', () => {
    expect(ids([visit('A', 0, 10), visit('B', 20, null)])).toEqual(['A>B']);
  });

  it('leaving a geofence nested in another is not a trip, until the vehicle leaves the outer one', () => {
    expect(ids([visit('outer', 0, 50), visit('inner', 10, 20), visit('C', 60, 70)])).toEqual(['outer>C', 'C>?']);
  });

  it('overlapping geofences: the trip starts at the later exit', () => {
    expect(ids([visit('A', 0, 10), visit('B', 5, 20), visit('C', 30, 40)])).toEqual(['B>C', 'C>?']);
  });

  it('no visits, no trips', () => {
    expect(geofenceTrips([])).toEqual([]);
  });
});
