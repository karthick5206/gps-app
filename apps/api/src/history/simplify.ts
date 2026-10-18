/**
 * Douglas–Peucker simplification to a point budget. Each point gets a significance (its deviation when DP would
 * split there, capped by its parent's), then the most significant points are kept — one O(n log n) pass instead of
 * searching for a tolerance. Forced indices (stops, alerts, endpoints) are always kept.
 */
export function simplifyToBudget(lats: number[], lngs: number[], budget: number, forced: Iterable<number> = []): number[] {
  const n = lats.length;
  if (n <= budget) return Array.from({ length: n }, (_, i) => i);
  const lat0 = (lats[0] * Math.PI) / 180;
  const kx = Math.cos(lat0) * 111_320;
  const ky = 110_540;
  const sig = new Float64Array(n);
  sig[0] = Infinity;
  sig[n - 1] = Infinity;

  const stack: [number, number, number][] = [[0, n - 1, Infinity]];
  while (stack.length) {
    const [lo, hi, parent] = stack.pop()!;
    if (hi - lo < 2) continue;
    const ax = lngs[lo] * kx;
    const ay = lats[lo] * ky;
    const bx = lngs[hi] * kx;
    const by = lats[hi] * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1;
    let bestD = -1;
    for (let i = lo + 1; i < hi; i++) {
      const px = lngs[i] * kx - ax;
      const py = lats[i] * ky - ay;
      let d: number;
      if (len2 === 0) d = px * px + py * py;
      else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        const ex = px - t * dx;
        const ey = py - t * dy;
        d = ex * ex + ey * ey;
      }
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    const s = Math.min(parent, Math.sqrt(bestD));
    sig[best] = s;
    stack.push([lo, best, s], [best, hi, s]);
  }

  const keep = new Set<number>([0, n - 1]);
  for (const i of forced) if (i >= 0 && i < n) keep.add(i);
  const remaining = Math.max(0, budget - keep.size);
  if (remaining > 0) {
    const order = Array.from({ length: n }, (_, i) => i).filter((i) => !keep.has(i));
    order.sort((a, b) => sig[b] - sig[a]);
    for (let k = 0; k < remaining && k < order.length; k++) keep.add(order[k]);
  }
  return [...keep].sort((a, b) => a - b);
}

/** Index of the element of the ascending `times` array closest to `t`. */
export function nearestIndex(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1] - t) <= Math.abs(times[lo] - t)) return lo - 1;
  return lo;
}
