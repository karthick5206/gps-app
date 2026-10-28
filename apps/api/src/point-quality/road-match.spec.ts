import type { InPoint } from './analyze';
import { distanceToRoad, lineLengthM, thinForMatching } from './road-match';

const T0 = Date.parse('2026-10-28T08:00:00Z');
const pt = (k: number, metresNorth: number, s = k * 3): InPoint => ({ t: T0 + s * 1000, lat: 13.05 + metresNorth / 111_320, lng: 80.25, acc: 5, spdKph: 30, mock: false });

describe('road matching helpers', () => {
  it('thins to one fix per 30 m (keeping the first and last)', () => {
    const points = Array.from({ length: 100 }, (_, k) => pt(k, k * 10)); // 10 m apart, 3 s apart
    const seg = points.map((_, k) => k);
    const kept = thinForMatching(points, seg);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(99);
    // ~990 m at one fix per ≥ 30 m: 25–35 fixes (3 steps of 10 m round to just under 30 m)
    expect(kept.length).toBeGreaterThanOrEqual(25);
    expect(kept.length).toBeLessThanOrEqual(35);
  });

  it('keeps a fix every 20 s even when standing nearly still', () => {
    const points = Array.from({ length: 30 }, (_, k) => pt(k, k * 0.5, k * 5)); // crawling, 5 s apart
    const kept = thinForMatching(points, points.map((_, k) => k));
    expect(kept.length).toBeGreaterThanOrEqual(7);
  });

  it('measures the distance to the nearest part of the road', () => {
    // Road running east along latitude 13.05
    const road: [number, number][] = Array.from({ length: 10 }, (_, k) => [80.25 + k * 0.001, 13.05]);
    const onRoad = distanceToRoad(13.05, 80.2535, road, 0);
    expect(onRoad.d).toBeLessThan(1);
    const off = distanceToRoad(13.05 + 100 / 111_320, 80.2535, road, 3);
    expect(off.d).toBeGreaterThan(95);
    expect(off.d).toBeLessThan(105);
    expect(off.idx).toBe(3);
  });

  it('measures a line length in metres', () => {
    const line: [number, number][] = [
      [80.25, 13.05],
      [80.25, 13.05 + 1000 / 111_320],
    ];
    expect(lineLengthM(line)).toBeGreaterThan(995);
    expect(lineLengthM(line)).toBeLessThan(1005);
  });
});
