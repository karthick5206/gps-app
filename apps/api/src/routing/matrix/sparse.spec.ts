import { kNearestPairs } from './sparse';
import { syntheticPoints } from './testing/matrix-test-kit';

describe('kNearestPairs', () => {
  const pts = syntheticPoints(30);

  it('k = n − 1 is the full matrix', () => {
    expect(kNearestPairs(pts, 29)).toHaveLength(30 * 29);
  });

  it('each point has its k nearest in both directions, no duplicates, no self-loops', () => {
    const pairs = kNearestPairs(pts, 5);
    const keys = pairs.map(([a, b]) => `${a}:${b}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(pairs.some(([a, b]) => a === b)).toBe(false);
    for (let i = 0; i < 30; i++) {
      expect(pairs.filter(([a]) => a === i).length).toBeGreaterThanOrEqual(5);
      expect(pairs.filter(([, b]) => b === i).length).toBeGreaterThanOrEqual(5);
    }
    expect(pairs.length).toBeLessThan(30 * 29);
  });

  it('always includes every depot leg', () => {
    const pairs = kNearestPairs(pts, 2, [0, 29]);
    for (let i = 1; i < 30; i++) {
      expect(pairs).toContainEqual([0, i]);
      expect(pairs).toContainEqual([i, 0]);
    }
    expect(pairs).toContainEqual([29, 0]);
    expect(kNearestPairs(pts, 0, [99])).toEqual([]); // out-of-range depot ignored
  });
});
