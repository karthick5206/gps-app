import { metres, plausibleSnap, pointsAlong, snapCandidate, SNAP_SPACING_M } from './road-snap';

const T0 = Date.parse('2026-11-16T04:00:00Z');
const a = { t: T0, lat: 12.95968, lng: 80.19221, speedKph: 30 };
const b = { t: T0 + 70_000, lat: 12.9650, lng: 80.198, speedKph: 35 };

describe('road snapping', () => {
  it('picks moving pairs with a usable gap', () => {
    expect(snapCandidate(a, b)).toBe(true);
    expect(snapCandidate(a, { ...b, t: T0 + 5_000 })).toBe(false); // too close in time
    expect(snapCandidate(a, { ...b, t: T0 + 20 * 60_000 })).toBe(false); // a gap, not driving
    expect(snapCandidate(a, { ...a, t: T0 + 70_000, lat: a.lat + 0.0003 })).toBe(false); // ~33 m: nothing to gain
    expect(snapCandidate({ ...a, speedKph: 0 }, { ...b, speedKph: 0 })).toBe(true); // covered real ground
  });

  it('accepts the road only when plausible', () => {
    const straight = metres(a.lat, a.lng, b.lat, b.lng);
    expect(plausibleSnap(straight, straight * 1.3, 70)).toBe(true);
    expect(plausibleSnap(straight, straight * 2.5, 70)).toBe(false); // detour
    expect(plausibleSnap(straight, straight * 0.5, 70)).toBe(false); // shorter than the straight line
    expect(plausibleSnap(2000, 2200, 30)).toBe(false); // 264 km/h
    expect(plausibleSnap(150, 500, 60)).toBe(true); // short hop: +400 m allowed
  });

  it('adds points along the road, timed by distance and strictly between the ends', () => {
    const shape: [number, number][] = [
      [80.19221, 12.95968],
      [80.19221, 12.9650],
      [80.198, 12.9650],
    ];
    const road = metres(12.95968, 80.19221, 12.965, 80.19221) + metres(12.965, 80.19221, 12.965, 80.198);
    const pts = pointsAlong(a, b, shape, road);
    expect(pts.length).toBe(Math.floor((road - SNAP_SPACING_M / 2) / SNAP_SPACING_M));
    expect(pts.every((p, i) => p.t > a.t && p.t < b.t && (i === 0 || p.t > pts[i - 1].t))).toBe(true);
    let m = metres(a.lat, a.lng, pts[0].lat, pts[0].lng);
    for (let i = 1; i < pts.length; i++) m += metres(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
    m += metres(pts[pts.length - 1].lat, pts[pts.length - 1].lng, b.lat, b.lng);
    expect(Math.abs(m - road) / road).toBeLessThan(0.02); // the path now measures the road length
    expect(pts[0].course).toBe(0); // heading north on the first leg
    expect(pts[pts.length - 1].course).toBe(90); // east on the second
  });
});
