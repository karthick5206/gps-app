import { nearestIndex, simplifyToBudget } from './simplify';

describe('simplifyToBudget', () => {
  it('returns everything when under budget', () => {
    expect(simplifyToBudget([1, 2, 3], [1, 2, 3], 10)).toEqual([0, 1, 2]);
  });

  it('keeps the corners of a polyline and the forced points within the budget', () => {
    const lats: number[] = [];
    const lngs: number[] = [];
    // An L-shaped track: 1,000 points north, then 1,000 points east, with tiny noise.
    for (let i = 0; i < 1000; i++) {
      lats.push(13 + i * 1e-4);
      lngs.push(80 + (i % 2) * 1e-7);
    }
    for (let i = 0; i < 1000; i++) {
      lats.push(13.1 + (i % 2) * 1e-7);
      lngs.push(80 + i * 1e-4);
    }
    const keep = simplifyToBudget(lats, lngs, 50, [1234, 77]);
    expect(keep.length).toBeLessThanOrEqual(50);
    expect(keep).toContain(0);
    expect(keep).toContain(1999);
    expect(keep).toContain(1234);
    expect(keep).toContain(77);
    expect(keep.some((i) => i >= 998 && i <= 1001)).toBe(true); // the corner survives
    expect([...keep].sort((a, b) => a - b)).toEqual(keep);
  });

  it('finds the nearest time index', () => {
    const times = [0, 10, 20, 30];
    expect(nearestIndex(times, -5)).toBe(0);
    expect(nearestIndex(times, 14)).toBe(1);
    expect(nearestIndex(times, 16)).toBe(2);
    expect(nearestIndex(times, 99)).toBe(3);
  });
});
