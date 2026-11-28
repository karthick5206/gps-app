import type { TrackIndex } from './playback-core.ts';

export interface Checkpoint {
  t: number;
  lat: number;
  lng: number;
  /** km from the trip start */
  km: number;
}

/** Most rows one trip's route timeline shows; longer trips space the rows further apart. */
export const ROUTE_MAX_ROWS = 40;
/** Normal spacing between rows (km). */
export const ROUTE_STEP_KM = 0.75;

/**
 * Points along a trip for the route timeline: the start, then one each time the vehicle has covered another
 * `step` km (0.75 km, or trip length / ROUTE_MAX_ROWS when longer), and the end. Times come from the GPS points.
 */
export function routeCheckpoints(idx: TrackIndex, fromMs: number, toMs: number): Checkpoint[] {
  let a = -1;
  let b = -1;
  for (let i = 0; i < idx.n; i++) {
    const t = idx.t[i];
    if (t < fromMs) continue;
    if (t > toMs) break;
    if (a < 0) a = i;
    b = i;
  }
  if (a < 0) return [];
  const startKm = idx.dist[a];
  const total = idx.dist[b] - startKm;
  const step = Math.max(ROUTE_STEP_KM, total / (ROUTE_MAX_ROWS - 1));
  const at = (i: number): Checkpoint => ({ t: idx.t[i], lat: idx.lat[i], lng: idx.lng[i], km: idx.dist[i] - startKm });
  const out: Checkpoint[] = [at(a)];
  let next = step;
  for (let i = a + 1; i < b; i++) {
    const km = idx.dist[i] - startKm;
    if (km >= next) {
      out.push(at(i));
      next = km + step;
    }
  }
  // The end, unless it is (almost) the last row already.
  if (b > a && total - out[out.length - 1].km > step * 0.3) out.push(at(b));
  else if (b > a) out[out.length - 1] = at(b);
  return out;
}

/**
 * Rows to show: consecutive checkpoints with the same street collapse into the first one (keeping its time),
 * except the final row, which always shows where the trip ended.
 */
export function collapseSameAddress<T extends { address: string | null }>(rows: T[]): T[] {
  return rows.filter((r, i) => i === 0 || i === rows.length - 1 || !r.address || r.address !== rows[i - 1].address);
}
