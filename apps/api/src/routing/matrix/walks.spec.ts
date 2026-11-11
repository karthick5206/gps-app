import { Arc, chunkTrails, eulerTrails, legsOf } from './walks';

const key = ([a, b]: Arc) => `${a}:${b}`;
const allLegs = (trails: number[][]) => trails.flatMap(legsOf);

function complete(n: number): Arc[] {
  const arcs: Arc[] = [];
  for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) if (a !== b) arcs.push([a, b]);
  return arcs;
}

function expectExactCover(arcs: Arc[], trails: number[][]) {
  const want = arcs.filter(([a, b]) => a !== b).map(key).sort();
  const got = allLegs(trails).map(key).sort();
  expect(got).toEqual(want);
}

describe('eulerTrails', () => {
  it('covers the complete digraph with one closed walk, each arc exactly once', () => {
    for (const n of [2, 3, 5, 12]) {
      const arcs = complete(n);
      const trails = eulerTrails(arcs);
      expect(trails).toHaveLength(1);
      expect(trails[0]).toHaveLength(n * (n - 1) + 1);
      expect(trails[0][0]).toBe(trails[0][trails[0].length - 1]);
      expectExactCover(arcs, trails);
    }
  });

  it('covers an unbalanced sparse set exactly, never adding arcs that were not asked for', () => {
    let x = 3;
    const rnd = () => (x = (x * 48271) % 2147483647) / 2147483647;
    for (let round = 0; round < 25; round++) {
      const arcs: Arc[] = [];
      const seen = new Set<string>();
      for (let k = 0; k < 40; k++) {
        const a = Math.floor(rnd() * 15);
        const b = Math.floor(rnd() * 15);
        if (seen.has(`${a}:${b}`)) continue;
        seen.add(`${a}:${b}`);
        arcs.push([a, b]);
      }
      expectExactCover(arcs, eulerTrails(arcs));
    }
  });

  it('handles disjoint components, a single arc, self-loops and no arcs', () => {
    expectExactCover(
      [
        [0, 1],
        [1, 0],
        [5, 6],
        [6, 5],
        [8, 9],
      ],
      eulerTrails([
        [0, 1],
        [1, 0],
        [5, 6],
        [6, 5],
        [8, 9],
      ]),
    );
    expect(eulerTrails([[3, 4]])).toEqual([[3, 4]]);
    expect(eulerTrails([[2, 2]])).toEqual([]);
    expect(eulerTrails([])).toEqual([]);
  });

  it('turns a star of anchor probes into anchor → x → anchor walks', () => {
    const arcs: Arc[] = [1, 2, 3].flatMap((x) => [[0, x] as Arc, [x, 0] as Arc]);
    const trails = eulerTrails(arcs);
    expect(trails).toHaveLength(1);
    expectExactCover(arcs, trails);
    expect(trails[0].filter((_, i) => i % 2 === 0).every((v) => v === 0)).toBe(true);
  });
});

describe('chunkTrails / legsOf', () => {
  it('splits a trail into requests of at most k legs that share end points', () => {
    const trail = [0, 1, 2, 3, 4, 5, 6];
    const chunks = chunkTrails([trail], 4);
    expect(chunks).toEqual([
      [0, 1, 2, 3, 4],
      [4, 5, 6],
    ]);
    expect(chunks.flatMap(legsOf)).toEqual(legsOf(trail));
    expect(chunkTrails([trail], 0)).toHaveLength(6); // at least one leg per request
  });

  it('legsOf lists consecutive pairs', () => {
    expect(legsOf([4, 2, 9])).toEqual([
      [4, 2],
      [2, 9],
    ]);
    expect(legsOf([1])).toEqual([]);
  });
});
