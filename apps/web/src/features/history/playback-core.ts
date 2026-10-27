/**
 * Pure playback maths (no DOM / React / MapLibre) so it can be unit-tested with `node --test`.
 *
 * The track is stored column-wise in typed arrays. Two monotonic time axes are precomputed:
 *  - `t`: real fix time (epoch ms) of every point;
 *  - `v`: cumulative *playback* time (ms) — equal to real time, except that stationary stretches and long
 *    gaps are compressed when "skip stops" is on, so a day plays mostly the driving.
 * Each animation frame advances `v`, maps it to real time with one binary search and samples the
 * interpolated pose with a second one (both O(log n), with an O(1) fast path for the previous segment).
 */
import type { GapEstimateSegment, TrackPoint } from '@veetracer/shared';
import { lerp, lerpBearing, normalizeBearing } from '../../lib/geo.ts';

/** Track seconds played per wall-clock second at 1×. */
export const BASE_RATE = 60;
export const PLAYBACK_RATES = [1, 2, 4, 8, 16] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

/** A time gap longer than this breaks the drawn track (shown dashed). */
export const GAP_MS = 15 * 60_000;
/** Speed bands for the "colour by speed" mode (upper bounds, km/h); the last band is open-ended. */
export const SPEED_BANDS = [20, 40, 60, 80] as const;

const STATIONARY_KPH = 3;
const STATIONARY_M = 15;
/** With skip-stops, a whole stationary stretch (a stop, however long) lasts at most this long in playback time. */
const SKIPPED_STOP_MS = 10_000;
/** With skip-stops, a moving segment across a data gap lasts at most this long in playback time. */
const SKIPPED_GAP_MS = 5 * 60_000;

export interface TrackIndex {
  n: number;
  t: Float64Array;
  v: Float64Array;
  lat: Float64Array;
  lng: Float64Array;
  speed: Float32Array;
  /** Heading of segment i → i+1 (geometry based; carried over while stationary). Last entry repeats. */
  heading: Float32Array;
  /** Cumulative distance in km up to point i. */
  dist: Float64Array;
  ignition: Int8Array;
  status: Uint8Array;
  start: number;
  end: number;
  duration: number; // playback ms
}

export interface Sample {
  /** Segment index: the pose lies between point i and i+1 (i = n-1 only for single-point tracks). */
  i: number;
  /** Fraction within the segment [0, 1]. */
  f: number;
  t: number;
  lat: number;
  lng: number;
  bearing: number;
  speed: number;
  /** Distance travelled since the first point (km). */
  distKm: number;
  status: number;
  ignition: number;
}

const R = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Consecutive points this far apart in time and distance get a road estimate (a gap, or missed points while moving). */
export const ESTIMATE_MIN_GAP_MS = 2 * 60_000;
export const ESTIMATE_MIN_GAP_KM = 0.5;

/** Segments worth a road estimate, longest first, at most `max`. */
export function gapSegments(idx: TrackIndex, max: number): GapEstimateSegment[] {
  const found: { km: number; seg: GapEstimateSegment }[] = [];
  for (let i = 0; i < idx.n - 1; i++) {
    const dt = idx.t[i + 1] - idx.t[i];
    if (dt < ESTIMATE_MIN_GAP_MS) continue;
    const km = haversineKm(idx.lat[i], idx.lng[i], idx.lat[i + 1], idx.lng[i + 1]);
    if (km < ESTIMATE_MIN_GAP_KM) continue;
    found.push({ km, seg: { fromLat: idx.lat[i], fromLng: idx.lng[i], toLat: idx.lat[i + 1], toLng: idx.lng[i + 1], seconds: Math.round(dt / 1000) } });
  }
  return found
    .sort((a, b) => b.km - a.km)
    .slice(0, max)
    .map((f) => f.seg);
}

/** Initial great-circle bearing in degrees [0, 360). */
export function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const y = Math.sin(rad(lng2 - lng1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lng2 - lng1));
  return normalizeBearing((Math.atan2(y, x) * 180) / Math.PI);
}

export function speedBand(kph: number): number {
  for (let b = 0; b < SPEED_BANDS.length; b++) if (kph < SPEED_BANDS[b]) return b;
  return SPEED_BANDS.length;
}

/** Builds the column-wise index. Points must be sorted by time (duplicates/out-of-order ones are dropped). */
export function buildTrackIndex(points: readonly TrackPoint[], { skipStops = true }: { skipStops?: boolean } = {}): TrackIndex {
  // Drop non-increasing timestamps so both time axes are strictly monotonic.
  const clean: TrackPoint[] = [];
  for (const p of points) if (!clean.length || p[0] > clean[clean.length - 1][0]) clean.push(p);
  const n = clean.length;
  const idx: TrackIndex = {
    n,
    t: new Float64Array(n),
    v: new Float64Array(n),
    lat: new Float64Array(n),
    lng: new Float64Array(n),
    speed: new Float32Array(n),
    heading: new Float32Array(n),
    dist: new Float64Array(n),
    ignition: new Int8Array(n),
    status: new Uint8Array(n),
    start: n ? clean[0][0] : 0,
    end: n ? clean[n - 1][0] : 0,
    duration: 0,
  };
  for (let i = 0; i < n; i++) {
    const p = clean[i];
    idx.t[i] = p[0];
    idx.lat[i] = p[1];
    idx.lng[i] = p[2];
    idx.speed[i] = p[3];
    idx.ignition[i] = p[5];
    idx.status[i] = p[6];
  }
  let heading = n ? normalizeBearing(clean[0][4]) : 0;
  const stationary = new Uint8Array(Math.max(0, n - 1));
  for (let i = 0; i < n - 1; i++) {
    const d = haversineKm(idx.lat[i], idx.lng[i], idx.lat[i + 1], idx.lng[i + 1]);
    idx.dist[i + 1] = idx.dist[i] + d;
    if (d * 1000 >= 2) heading = bearingDeg(idx.lat[i], idx.lng[i], idx.lat[i + 1], idx.lng[i + 1]);
    idx.heading[i] = heading;
    stationary[i] = d * 1000 < STATIONARY_M && idx.speed[i] < STATIONARY_KPH && idx.speed[i + 1] < STATIONARY_KPH ? 1 : 0;
  }
  // Playback axis: each maximal stationary stretch is squeezed to ≤ SKIPPED_STOP_MS (proportionally),
  // moving segments across data gaps to ≤ SKIPPED_GAP_MS; everything else plays in real time.
  let i = 0;
  while (i < n - 1) {
    if (skipStops && stationary[i]) {
      let j = i;
      while (j < n - 1 && stationary[j]) j++;
      const real = idx.t[j] - idx.t[i];
      const scale = real > SKIPPED_STOP_MS ? SKIPPED_STOP_MS / real : 1;
      for (let k = i; k < j; k++) idx.v[k + 1] = idx.v[k] + (idx.t[k + 1] - idx.t[k]) * scale;
      i = j;
    } else {
      const dt = idx.t[i + 1] - idx.t[i];
      idx.v[i + 1] = idx.v[i] + (skipStops ? Math.min(dt, SKIPPED_GAP_MS) : dt);
      i++;
    }
  }
  if (n) idx.heading[n - 1] = heading;
  idx.duration = n ? idx.v[n - 1] : 0;
  return idx;
}

/**
 * Index i of the segment containing x in a sorted array: arr[i] <= x < arr[i+1], clamped to [0, len-2]
 * (0 for arrays shorter than 2). `hint` (the previous result) makes sequential playback O(1).
 */
export function findSegment(arr: ArrayLike<number>, x: number, hint = -1): number {
  const len = arr.length;
  if (len < 2) return 0;
  if (hint >= 0 && hint < len - 1) {
    if (arr[hint] <= x && x < arr[hint + 1]) return hint;
    const next = hint + 1;
    if (next < len - 1 && arr[next] <= x && x < arr[next + 1]) return next;
  }
  if (x < arr[1]) return 0;
  if (x >= arr[len - 2]) return len - 2;
  let lo = 1;
  let hi = len - 2;
  // Invariant: arr[lo] <= x < arr[hi + 1]
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (arr[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Maps between two parallel monotonic axes by linear interpolation inside the segment. */
function mapAxis(from: Float64Array, to: Float64Array, x: number, hint: number): number {
  const n = from.length;
  if (!n) return 0;
  if (x <= from[0]) return to[0];
  if (x >= from[n - 1]) return to[n - 1];
  const i = findSegment(from, x, hint);
  const span = from[i + 1] - from[i];
  const f = span > 0 ? (x - from[i]) / span : 0;
  return lerp(to[i], to[i + 1], f);
}

export function virtualToReal(idx: TrackIndex, v: number, hint = -1): number {
  return mapAxis(idx.v, idx.t, v, hint);
}

export function realToVirtual(idx: TrackIndex, t: number, hint = -1): number {
  return mapAxis(idx.t, idx.v, t, hint);
}

/** Interpolated pose at real time `t` (clamped to the track). */
export function sampleAt(idx: TrackIndex, t: number, hint = -1): Sample {
  const n = idx.n;
  if (n === 0) return { i: 0, f: 0, t, lat: 0, lng: 0, bearing: 0, speed: 0, distKm: 0, status: 0, ignition: -1 };
  if (n === 1 || t <= idx.t[0]) return pointSample(idx, 0, 0);
  if (t >= idx.t[n - 1]) return pointSample(idx, n - 2, 1);
  const i = findSegment(idx.t, t, hint);
  const span = idx.t[i + 1] - idx.t[i];
  const f = span > 0 ? (t - idx.t[i]) / span : 0;
  return {
    i,
    f,
    t,
    lat: lerp(idx.lat[i], idx.lat[i + 1], f),
    lng: lerp(idx.lng[i], idx.lng[i + 1], f),
    bearing: segmentBearing(idx, i, f),
    speed: lerp(idx.speed[i], idx.speed[i + 1], f),
    distKm: lerp(idx.dist[i], idx.dist[i + 1], f),
    status: idx.status[i],
    ignition: idx.ignition[i],
  };
}

function pointSample(idx: TrackIndex, i: number, f: 0 | 1): Sample {
  const p = Math.min(idx.n - 1, i + f);
  return {
    i,
    f,
    t: idx.t[p],
    lat: idx.lat[p],
    lng: idx.lng[p],
    bearing: idx.heading[Math.min(i, idx.n - 1)],
    speed: idx.speed[p],
    distKm: idx.dist[p],
    status: idx.status[p],
    ignition: idx.ignition[p],
  };
}

/** Turns smoothly into a new segment's heading over its first 20 %. */
function segmentBearing(idx: TrackIndex, i: number, f: number): number {
  const h = idx.heading[i];
  if (i === 0) return h;
  return lerpBearing(idx.heading[i - 1], h, Math.min(1, f / 0.2));
}

/** A drawable piece of track: segments [a, b) i.e. points a..b, uniform colour keys. */
export interface TrackRun {
  a: number;
  b: number;
  status: number;
  band: number;
  gap: boolean;
}

/**
 * Splits the track into runs of equal (status, speed band) — so either colour mode can be painted from the same
 * features — breaking at data gaps (gap runs are drawn dashed) and every `maxSegments` so the progressively
 * drawn "tail" stays small. Consecutive runs share their boundary point, so the line is continuous.
 */
export function buildRuns(idx: TrackIndex, maxSegments = 256): TrackRun[] {
  const runs: TrackRun[] = [];
  let cur: TrackRun | null = null;
  for (let i = 0; i < idx.n - 1; i++) {
    const gap = idx.t[i + 1] - idx.t[i] > GAP_MS;
    const status = idx.status[i];
    const band = speedBand(Math.max(idx.speed[i], idx.speed[i + 1]));
    if (cur && cur.gap === gap && cur.status === status && cur.band === band && cur.b - cur.a < maxSegments) {
      cur.b = i + 1;
    } else {
      cur = { a: i, b: i + 1, status, band, gap };
      runs.push(cur);
    }
  }
  return runs;
}

/** Index of the run containing segment `seg` (runs are contiguous and sorted). */
export function findRun(runs: readonly TrackRun[], seg: number): number {
  let lo = 0;
  let hi = runs.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (runs[mid].a <= seg) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** [lng, lat] coordinates of points a..b. */
export function coordsOf(idx: TrackIndex, a: number, b: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = a; i <= b && i < idx.n; i++) out.push([idx.lng[i], idx.lat[i]]);
  return out;
}

/** Bounding box [[minLng, minLat], [maxLng, maxLat]] of points whose time lies within [from, to]. */
export function boundsBetween(idx: TrackIndex, from: number, to: number): [[number, number], [number, number]] | null {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  const a = idx.n ? (from <= idx.t[0] ? 0 : findSegment(idx.t, from)) : 0;
  for (let i = a; i < idx.n && idx.t[i] <= to; i++) {
    if (idx.t[i] < from) continue;
    minLng = Math.min(minLng, idx.lng[i]);
    maxLng = Math.max(maxLng, idx.lng[i]);
    minLat = Math.min(minLat, idx.lat[i]);
    maxLat = Math.max(maxLat, idx.lat[i]);
  }
  return Number.isFinite(minLng) ? [[minLng, minLat], [maxLng, maxLat]] : null;
}
