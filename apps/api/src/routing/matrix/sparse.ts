/**
 * Sparse M1 request (doc 06 §2.2 / §7, doc 17 §4.2): instead of all n(n − 1) cells, each point's k nearest neighbours
 * in both directions plus every leg to and from the depots (vehicle start / end, site). Straight-line distance is used
 * ONLY to choose which cells to ask for; it never becomes a number in the matrix. Cells not asked for are null, which
 * the optimiser treats as forbidden arcs; B3 measures the quality loss (target < 3 % at k = 20 / 40 / 60).
 */
import { haversineMeters } from '../../tracking/geo';
import type { MatrixPoint } from './matrix-types';

export function kNearestPairs(points: MatrixPoint[], k: number, depots: number[] = []): [number, number][] {
  const n = points.length;
  const seen = new Set<number>();
  const out: [number, number][] = [];
  const add = (a: number, b: number) => {
    if (a === b || a < 0 || b < 0 || a >= n || b >= n) return;
    const key = a * n + b;
    if (seen.has(key)) return;
    seen.add(key);
    out.push([a, b]);
  };
  const kk = Math.max(0, Math.min(n - 1, Math.floor(k)));
  for (let i = 0; i < n; i++) {
    const near = points
      .map((p, j) => ({ j, d: j === i ? Infinity : haversineMeters(points[i].lat, points[i].lng, p.lat, p.lng) }))
      .sort((x, y) => x.d - y.d || x.j - y.j)
      .slice(0, kk);
    for (const { j } of near) {
      add(i, j);
      add(j, i);
    }
  }
  for (const d of depots) {
    for (let i = 0; i < n; i++) {
      add(d, i);
      add(i, d);
    }
  }
  return out;
}
