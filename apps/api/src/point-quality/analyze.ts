import type { PointLabel } from '@veetracer/shared';
import { haversineMeters } from '../tracking/geo';

/** One recorded point, oldest first. `acc` null when the source gives none (most GPS trackers). */
export interface InPoint {
  t: number;
  lat: number;
  lng: number;
  acc: number | null;
  spdKph: number;
  mock: boolean;
}

export const QUALITY = {
  /** Worse than this is never trusted. */
  MAX_ACC_M: 150,
  /** Also inaccurate: worse than 50 m and more than 3× the accuracy of the neighbouring fixes. */
  REL_ACC_MIN_M: 50,
  REL_ACC_FACTOR: 3,
  REL_ACC_WINDOW: 10,
  /** Assumed accuracy when the source reports none. */
  DEFAULT_ACC_M: 15,
  /** Nothing we track moves faster (after subtracting both points' error radius). */
  MAX_SPEED_MPS: 200 / 3.6,
  /** Out-and-back groups up to this many points are spikes; shorter chains cut off by impossible moves are jumps. */
  SPIKE_MAX_RUN: 5,
  JUMP_MAX_CHAIN: 20,
  /** A stop: points within this radius (or their accuracy, if larger) for at least this long. */
  STAY_RADIUS_M: 50,
  STAY_MIN_MS: 3 * 60_000,
  /** Up to this many consecutive fixes outside the radius keep a stop going when the next ones are back inside. */
  STAY_LOOKAHEAD: 3,
  /** Inside a stop, farther than this from its centre is parked drift. */
  DRIFT_M: 25,
  /** Kalman: restart after a gap this long; vehicle acceleration noise (m/s²); outlier threshold (χ², 2 dof). */
  SEGMENT_GAP_MS: 120_000,
  ACCEL_SD: 2.5,
  OUTLIER_D2: 16,
} as const;

export interface QualityResult {
  labels: PointLabel[];
  /** Cleaned track [t, lat, lng]: smoothed moving parts; each stop as its centre at its start and end time. */
  clean: [number, number, number][];
  /** Moving parts (indexes of the accepted fixes, oldest first), split at stops and long gaps: what road matching uses. */
  segments: number[][];
}

/**
 * Labels every point and builds a cleaned track, looking at the whole track (both directions), in four stages:
 *  1. hard checks: bad coordinates, duplicate time, fake GPS, accuracy (absolute and relative to the neighbours);
 *  2. spikes and jumps: moves that need an impossible speed after subtracting both points' error radius; a short
 *     group that is impossible to enter and to leave while skipping it is fine is a spike (out and back); a short
 *     chain cut off from the rest by impossible moves is a jump;
 *  3. stops: points staying within a small radius for minutes; the wobble far from the stop's centre is drift;
 *  4. moving parts: a Kalman filter (constant velocity, each fix weighted by its accuracy) rejects statistical
 *     outliers as jumps, and an RTS smoother gives the cleaned positions.
 */
export function analyzeTrack(points: InPoint[]): QualityResult {
  const n = points.length;
  const labels: PointLabel[] = new Array(n).fill('good');
  const acc = (i: number) => points[i].acc ?? QUALITY.DEFAULT_ACC_M;

  // 1. Hard checks.
  let lastT = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180 || (p.lat === 0 && p.lng === 0)) {
      labels[i] = 'invalid';
      continue;
    }
    if (p.t <= lastT) {
      labels[i] = 'duplicate';
      continue;
    }
    lastT = p.t;
    if (p.mock) labels[i] = 'mock';
    else if (p.acc !== null && p.acc > QUALITY.MAX_ACC_M) labels[i] = 'inaccurate';
  }
  relativeAccuracy(points, labels);

  // 2. Spikes, then jumps, on the remaining points.
  let cand = indexesOf(labels, 'good');
  const vEff = (a: number, b: number) => {
    const d = haversineMeters(points[a].lat, points[a].lng, points[b].lat, points[b].lng) - acc(a) - acc(b);
    return Math.max(0, d) / Math.max(1, (points[b].t - points[a].t) / 1000);
  };
  const impossible = (a: number, b: number) => vEff(a, b) > QUALITY.MAX_SPEED_MPS;
  for (let pass = 0; pass < 3; pass++) {
    let found = false;
    for (let i = 1; i < cand.length - 1; i++) {
      if (!impossible(cand[i - 1], cand[i])) continue;
      for (let k = 1; k <= QUALITY.SPIKE_MAX_RUN && i + k < cand.length; k++) {
        if (impossible(cand[i + k - 1], cand[i + k]) && !impossible(cand[i - 1], cand[i + k])) {
          for (let j = i; j < i + k; j++) labels[cand[j]] = 'spike';
          found = true;
          i += k;
          break;
        }
      }
    }
    if (!found) break;
    cand = cand.filter((i) => labels[i] === 'good');
  }
  const chains = splitChains(cand, impossible);
  for (let c = 0; c < chains.length; c++) {
    const size = chains[c].length;
    if (size > QUALITY.JUMP_MAX_CHAIN) continue;
    const prev = chains[c - 1]?.length ?? 0;
    const next = chains[c + 1]?.length ?? 0;
    if (size < Math.max(prev, next)) for (const i of chains[c]) labels[i] = 'jump';
  }
  cand = cand.filter((i) => labels[i] === 'good');

  // 3. Stops.
  const stays = findStays(points, cand, acc);
  const inStay = new Set<number>();
  const clean: [number, number, number][] = [];
  for (const s of stays) {
    for (const i of s.members) {
      inStay.add(i);
      if (haversineMeters(s.lat, s.lng, points[i].lat, points[i].lng) > Math.max(QUALITY.DRIFT_M, acc(i) / 2)) labels[i] = 'drift';
    }
    clean.push([points[s.members[0]].t, s.lat, s.lng], [points[s.members[s.members.length - 1]].t, s.lat, s.lng]);
  }

  // 4. Moving parts: Kalman filter + smoother per segment (split at stops and long gaps).
  let seg: number[] = [];
  const segments: number[][] = [];
  const flush = () => {
    if (seg.length) {
      for (const c of smoothSegment(points, seg, acc, labels)) clean.push(c);
      const kept = seg.filter((i) => labels[i] === 'good');
      if (kept.length >= 2) segments.push(kept);
    }
    seg = [];
  };
  for (const i of cand) {
    if (inStay.has(i)) {
      flush();
      continue;
    }
    if (seg.length && points[i].t - points[seg[seg.length - 1]].t > QUALITY.SEGMENT_GAP_MS) flush();
    seg.push(i);
  }
  flush();
  clean.sort((a, b) => a[0] - b[0]);
  return { labels, clean, segments };
}

const indexesOf = (labels: PointLabel[], label: PointLabel) => labels.flatMap((l, i) => (l === label ? [i] : []));

/** Inaccurate when worse than REL_ACC_MIN_M and REL_ACC_FACTOR × the median accuracy of the neighbouring fixes. */
function relativeAccuracy(points: InPoint[], labels: PointLabel[]) {
  const usable = indexesOf(labels, 'good').filter((i) => points[i].acc !== null);
  const w = QUALITY.REL_ACC_WINDOW;
  const flagged: number[] = [];
  for (let k = 0; k < usable.length; k++) {
    const a = points[usable[k]].acc!;
    if (a <= QUALITY.REL_ACC_MIN_M) continue;
    const around = usable.slice(Math.max(0, k - w), k).concat(usable.slice(k + 1, k + 1 + w)).map((i) => points[i].acc!);
    if (around.length < 3) continue;
    around.sort((x, y) => x - y);
    if (a > QUALITY.REL_ACC_FACTOR * around[around.length >> 1]) flagged.push(usable[k]);
  }
  for (const i of flagged) labels[i] = 'inaccurate';
}

/** Splits the candidates where moving from one point to the next would need an impossible speed. */
function splitChains(cand: number[], impossible: (a: number, b: number) => boolean): number[][] {
  const chains: number[][] = [];
  let cur: number[] = [];
  for (let k = 0; k < cand.length; k++) {
    if (cur.length && impossible(cur[cur.length - 1], cand[k])) {
      chains.push(cur);
      cur = [];
    }
    cur.push(cand[k]);
  }
  if (cur.length) chains.push(cur);
  return chains;
}

interface Stay {
  members: number[];
  lat: number;
  lng: number;
}

/** Stay points: grow from each point while the next stays within the radius of the running (accuracy-weighted) centre. */
function findStays(points: InPoint[], cand: number[], acc: (i: number) => number): Stay[] {
  const stays: Stay[] = [];
  let k = 0;
  while (k < cand.length) {
    let wSum = 0;
    let lat = 0;
    let lng = 0;
    const add = (i: number) => {
      const w = 1 / Math.max(9, acc(i) ** 2);
      lat = (lat * wSum + points[i].lat * w) / (wSum + w);
      lng = (lng * wSum + points[i].lng * w) / (wSum + w);
      wSum += w;
    };
    add(cand[k]);
    const inside = (i: number) => haversineMeters(lat, lng, points[i].lat, points[i].lng) <= Math.max(QUALITY.STAY_RADIUS_M, acc(i));
    let j = k;
    while (j + 1 < cand.length) {
      if (inside(cand[j + 1])) {
        add(cand[j + 1]);
        j++;
        continue;
      }
      // A few wobbles outside, then back inside: still the same stop (they become drift, not part of the centre).
      let back = -1;
      for (let a = j + 2; a < Math.min(cand.length, j + 2 + QUALITY.STAY_LOOKAHEAD); a++) {
        if (inside(cand[a])) {
          back = a;
          break;
        }
      }
      if (back < 0) break;
      add(cand[back]);
      j = back;
    }
    if (points[cand[j]].t - points[cand[k]].t >= QUALITY.STAY_MIN_MS) {
      stays.push({ members: cand.slice(k, j + 1), lat, lng });
      k = j + 1;
    } else {
      k++;
    }
  }
  return stays;
}

/**
 * Constant-velocity Kalman filter per axis in a local metric frame; a fix whose innovation is a statistical outlier
 * is labelled a jump and skipped (after two in a row the filter restarts at the next fix: a real manoeuvre). The
 * Rauch–Tung–Striebel smoother then gives the cleaned positions of the accepted fixes.
 */
function smoothSegment(points: InPoint[], seg: number[], acc: (i: number) => number, labels: PointLabel[]): [number, number, number][] {
  const lat0 = points[seg[0]].lat;
  const lng0 = points[seg[0]].lng;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const q = QUALITY.ACCEL_SD ** 2;

  type Axis = { x: [number, number]; P: [number, number, number, number] };
  const init = (z: number, r: number): Axis => ({ x: [z, 0], P: [r, 0, 0, 100] });
  const steps: { i: number; dt: number; pred: [Axis, Axis]; filt: [Axis, Axis] }[] = [];

  let state: [Axis, Axis] | null = null;
  let lastT = 0;
  let rejected = 0;
  for (const i of seg) {
    const z = [(points[i].lng - lng0) * mPerDegLng, (points[i].lat - lat0) * mPerDegLat];
    const r = Math.max(3, acc(i)) ** 2;
    if (!state) {
      state = [init(z[0], r), init(z[1], r)];
      steps.push({ i, dt: 0, pred: state, filt: state });
      lastT = points[i].t;
      continue;
    }
    const dt = Math.max(0.5, (points[i].t - lastT) / 1000);
    const pred = state.map((a) => predict(a, dt, q)) as [Axis, Axis];
    const d2 = [0, 1].reduce((s, ax) => s + (z[ax] - pred[ax].x[0]) ** 2 / (pred[ax].P[0] + r), 0);
    if (d2 > QUALITY.OUTLIER_D2 && rejected < 2) {
      labels[i] = 'jump';
      rejected++;
      continue; // keep the state; the next fix is predicted over the longer interval
    }
    const filt =
      d2 > QUALITY.OUTLIER_D2 ? ([init(z[0], r), init(z[1], r)] as [Axis, Axis]) : (pred.map((a, ax) => update(a, z[ax], r)) as [Axis, Axis]);
    rejected = 0;
    steps.push({ i, dt, pred, filt });
    state = filt;
    lastT = points[i].t;
  }

  // RTS smoother (per axis): xs[k] = xf[k] + C (xs[k+1] − xp[k+1]), C = Pf[k] Fᵀ Pp[k+1]⁻¹.
  const xs = steps.map((s) => [s.filt[0].x.slice(), s.filt[1].x.slice()] as [number[], number[]]);
  for (let k = steps.length - 2; k >= 0; k--) {
    const dt = steps[k + 1].dt;
    for (let ax = 0; ax < 2; ax++) {
      const Pf = steps[k].filt[ax].P;
      const Pp = steps[k + 1].pred[ax].P;
      // Pf·Fᵀ with F = [[1, dt], [0, 1]]
      const a = Pf[0] + Pf[1] * dt;
      const b = Pf[1];
      const c = Pf[2] + Pf[3] * dt;
      const d = Pf[3];
      const det = Pp[0] * Pp[3] - Pp[1] * Pp[2];
      if (Math.abs(det) < 1e-9) continue;
      const inv = [Pp[3] / det, -Pp[1] / det, -Pp[2] / det, Pp[0] / det];
      const C = [a * inv[0] + b * inv[2], a * inv[1] + b * inv[3], c * inv[0] + d * inv[2], c * inv[1] + d * inv[3]];
      const dx0 = xs[k + 1][ax][0] - steps[k + 1].pred[ax].x[0];
      const dx1 = xs[k + 1][ax][1] - steps[k + 1].pred[ax].x[1];
      xs[k][ax][0] += C[0] * dx0 + C[1] * dx1;
      xs[k][ax][1] += C[2] * dx0 + C[3] * dx1;
    }
  }
  return steps.map((s, k) => [points[s.i].t, lat0 + xs[k][1][0] / mPerDegLat, lng0 + xs[k][0][0] / mPerDegLng]);
}

type AxisState = { x: [number, number]; P: [number, number, number, number] };

function predict(a: AxisState, dt: number, q: number): AxisState {
  const [p, v] = a.x;
  const [p00, p01, p10, p11] = a.P;
  const dt2 = dt * dt;
  return {
    x: [p + v * dt, v],
    P: [
      p00 + dt * (p10 + p01) + dt2 * p11 + (q * dt2 * dt2) / 4,
      p01 + dt * p11 + (q * dt2 * dt) / 2,
      p10 + dt * p11 + (q * dt2 * dt) / 2,
      p11 + q * dt2,
    ],
  };
}

function update(a: AxisState, z: number, r: number): AxisState {
  const [p00, p01, p10, p11] = a.P;
  const s = p00 + r;
  const k0 = p00 / s;
  const k1 = p10 / s;
  const y = z - a.x[0];
  return {
    x: [a.x[0] + k0 * y, a.x[1] + k1 * y],
    P: [(1 - k0) * p00, (1 - k0) * p01, p10 - k1 * p00, p11 - k1 * p01],
  };
}
