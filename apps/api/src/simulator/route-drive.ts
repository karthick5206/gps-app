/**
 * Route-driving simulator core: turns a road path, its stops and a scenario into a deterministic timeline of GPS
 * fixes for testing planned trips (docs/routes-trips/SPEC.md §4.3). Pure: no I/O, no clock, no randomness.
 *
 * Time model. Fix times `t` are seconds after the drive starts, on the WALL CLOCK: the CLI stamps each fix with the
 * real time it is sent, so the gateway never sees future or back-dated fixes. `speedFactor` (default 1) compresses
 * the drive instead: the vehicle covers `speedFactor` times the distance per second and planned dwells (`waitSec`)
 * are divided by it. Reported `speedKph` stays the nominal (uncompressed) speed so overspeed rules don't fire.
 * Scenario durations that the tracker measures against its own wall-clock thresholds (`delayAtStopSec.sec`,
 * `unscheduledStop.sec`) are NOT compressed, so a 6 min unscheduled stop still crosses the 5 min threshold.
 * The implied speed (distance between fixes / time) must stay below the server's 200 km/h jump filter, so
 * `cruiseKph × speedFactor` is capped at MAX_IMPLIED_KPH.
 */

export type LngLat = [number, number];

export interface RouteStop {
  name: string;
  lat: number;
  lng: number;
  /** Planned dwell at the stop. */
  waitSec: number;
  /** Arrival radius (default 100 m). */
  radiusM?: number;
  /** Planned arrival, minutes after the planned start (only reported, for comparison). */
  offsetMin?: number;
}

export interface DeviationSpec {
  /** Detour between these fractions of the path length (0..1). */
  fromFrac: number;
  toFrac: number;
  /** Sideways distance of the parallel detour, metres. */
  offsetM: number;
  /** Side of the direction of travel (default left). */
  side?: 'left' | 'right';
}

export interface DriveScenario {
  /** Extra dwell (seconds, not compressed) at the stop before stop index `stop` (≥ 1), so `stop` is reached late. */
  delayAtStopSec?: { stop: number; sec: number };
  /** Leave the path on a parallel detour. */
  deviation?: DeviationSpec;
  /** Stop index (not the first or last) to drive past, more than radius + 50 m away. */
  skipStop?: number;
  /** Stand still (speed 0) for `sec` seconds (not compressed) at a path fraction away from every stop. */
  unscheduledStop?: { atFrac: number; sec: number };
  /** Time compression, see the file header (default 1). */
  speedFactor?: number;
}

export interface DriveOptions {
  cruiseKph: number;
  /** Seconds between fixes (integer ≥ 1). */
  intervalSec: number;
  /** Corridor half-width used for the deviation on / off events (default 200 m). */
  corridorM?: number;
  /** Minimum time parked inside the start stop before leaving, so the tracker sees it there (default 60 s). */
  startDwellSec?: number;
  scenario?: DriveScenario;
}

export interface DriveFix {
  /** Seconds after the drive start (wall clock). */
  t: number;
  lat: number;
  lng: number;
  speedKph: number;
  course: number;
  /** Position along the planned path, metres. */
  alongM: number;
  /** Sideways offset from the planned path applied by the scenario, metres (left positive). */
  offsetM: number;
}

export type DriveEventType = 'arrive' | 'depart' | 'skip' | 'deviation-on' | 'deviation-off' | 'unscheduled-start' | 'unscheduled-end';

export interface DriveEvent {
  t: number;
  /** First fix at or after the event (the CLI prints the event when it sends that fix). */
  fixIndex: number;
  type: DriveEventType;
  stop?: number;
  detail: string;
}

export interface StopSummary {
  index: number;
  name: string;
  radiusM: number;
  alongM: number;
  /** Distance from the stop to the path (the vehicle dwells at the nearest path point). */
  snapM: number;
  skipped: boolean;
  /** Dwell the simulator spends at the stop (seconds, after compression, including any scenario delay). */
  dwellSec: number;
  /** First fix inside the radius / first fix outside after it (what the tracker sees). */
  arriveT?: number;
  departT?: number;
  offsetMin?: number;
  /** Closest fix to the stop. */
  minDistanceM: number;
}

export interface DriveTimeline {
  fixes: DriveFix[];
  events: DriveEvent[];
  stops: StopSummary[];
  pathLengthM: number;
  durationSec: number;
  speedFactor: number;
}

export const DEFAULT_RADIUS_M = 100;
export const DEFAULT_CORRIDOR_M = 200;
/** Keep the implied speed below the gateway jump filter (MAX_PLAUSIBLE_SPEED_KPH.VEHICLE = 200). */
export const MAX_IMPLIED_KPH = 180;
/** A skipped stop is passed this far beyond its radius (the tracker test needs > radius + 50 m). */
export const SKIP_CLEARANCE_M = 75;

const ACCEL_MPS2 = 0.8;
const MIN_MOVING_KPH = 6;
const SAMPLE_M = 5;
const NORMAL_HALF_WINDOW_M = 25;
const M_PER_DEG = 111_320;

type XY = [number, number];

/** Local equirectangular projection (metres), accurate to well under 0.5 % across a city. */
class Projection {
  private readonly kx: number;
  constructor(
    private readonly lat0: number,
    private readonly lng0: number,
  ) {
    this.kx = Math.cos((lat0 * Math.PI) / 180) * M_PER_DEG;
  }
  static around(points: LngLat[]): Projection {
    const lat = points.reduce((a, p) => a + p[1], 0) / points.length;
    const lng = points.reduce((a, p) => a + p[0], 0) / points.length;
    return new Projection(lat, lng);
  }
  toXY(lng: number, lat: number): XY {
    return [(lng - this.lng0) * this.kx, (lat - this.lat0) * M_PER_DEG];
  }
  toLngLat([x, y]: XY): LngLat {
    return [this.lng0 + x / this.kx, this.lat0 + y / M_PER_DEG];
  }
}

const dist = (a: XY, b: XY) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const bearingDeg = (a: XY, b: XY) => ((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI + 360) % 360;

function cumulative(pts: XY[]): number[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  return cum;
}

/** Index i with cum[i] <= s < cum[i + 1] (clamped). */
function segmentAt(cum: number[], s: number): number {
  let lo = 0;
  let hi = cum.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

function pointAt(pts: XY[], cum: number[], s: number): XY {
  const total = cum[cum.length - 1];
  const c = Math.min(Math.max(s, 0), total);
  const i = segmentAt(cum, c);
  const len = cum[i + 1] - cum[i];
  const u = len > 0 ? (c - cum[i]) / len : 0;
  return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * u, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u];
}

/** Nearest point of the polyline at or after `fromAlong`: its position along it and the distance. */
function project(pts: XY[], cum: number[], p: XY, fromAlong = 0): { along: number; d: number } {
  let best = { along: fromAlong, d: Infinity };
  for (let i = segmentAt(cum, fromAlong); i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let u = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
    u = Math.min(1, Math.max(0, u));
    const along = cum[i] + u * Math.sqrt(len2);
    if (along < fromAlong) continue;
    const d = dist(p, [a[0] + u * dx, a[1] + u * dy]);
    if (d < best.d) best = { along, d };
  }
  return best;
}

/** Distance in metres from a point to a [lng,lat] path (straight segments). */
export function distanceToPathM(path: LngLat[], lat: number, lng: number): number {
  const proj = Projection.around(path);
  const pts = path.map((p) => proj.toXY(p[0], p[1]));
  return project(pts, cumulative(pts), proj.toXY(lng, lat)).d;
}

function smoothstep(u: number): number {
  return u * u * (3 - 2 * u);
}

interface OffsetWindow {
  from: number;
  to: number;
  offsetM: number;
  rampM: number;
}

function offsetAt(windows: OffsetWindow[], s: number): number {
  let o = 0;
  for (const w of windows) {
    if (s <= w.from || s >= w.to) continue;
    o += w.offsetM * smoothstep(Math.min(1, (s - w.from) / w.rampM, (w.to - s) / w.rampM));
  }
  return o;
}

interface Halt {
  driveAlong: number;
  dwellSec: number;
  stop?: number;
  arriveT?: number;
  departT?: number;
}

export function buildTimeline(path: LngLat[], stopsIn: RouteStop[], opts: DriveOptions): DriveTimeline {
  if (stopsIn.length < 2) throw new Error('A route needs at least 2 stops');
  const scenario = opts.scenario ?? {};
  const f = scenario.speedFactor ?? 1;
  const intervalSec = Math.round(opts.intervalSec);
  const corridorM = opts.corridorM ?? DEFAULT_CORRIDOR_M;
  if (!(f > 0)) throw new Error('speedFactor must be > 0');
  if (!(opts.cruiseKph > MIN_MOVING_KPH)) throw new Error(`cruise speed must be > ${MIN_MOVING_KPH} km/h`);
  if (intervalSec < 1) throw new Error('interval must be at least 1 s');
  if (opts.cruiseKph * f > MAX_IMPLIED_KPH)
    throw new Error(
      `cruise ${opts.cruiseKph} km/h × speed factor ${f} = ${opts.cruiseKph * f} km/h implied speed; the gateway drops ` +
        `fixes above 200 km/h as jumps (limit here ${MAX_IMPLIED_KPH}). Lower --speed-factor or --cruise.`,
    );

  const line: LngLat[] = path.length >= 2 ? path : stopsIn.map((s) => [s.lng, s.lat] as LngLat);
  const proj = Projection.around(line);
  const base: XY[] = [];
  for (const p of line) {
    const xy = proj.toXY(p[0], p[1]);
    if (!base.length || dist(base[base.length - 1], xy) > 0.01) base.push(xy);
  }
  if (base.length < 2) throw new Error('The path has no length');
  const cum = cumulative(base);
  const pathLengthM = cum[cum.length - 1];

  // Stops along the path, in order.
  let from = 0;
  const stops = stopsIn.map((s, index) => {
    const at = project(base, cum, proj.toXY(s.lng, s.lat), from);
    from = at.along;
    return { ...s, index, radiusM: s.radiusM ?? DEFAULT_RADIUS_M, alongM: at.along, snapM: at.d, xy: proj.toXY(s.lng, s.lat) };
  });
  const last = stops.length - 1;

  const skip = scenario.skipStop;
  if (skip !== undefined && !(Number.isInteger(skip) && skip > 0 && skip < last))
    throw new Error(`skipStop must be a stop index between 1 and ${last - 1}`);
  const delay = scenario.delayAtStopSec;
  if (delay && !(Number.isInteger(delay.stop) && delay.stop >= 1 && delay.stop <= last))
    throw new Error(`delayAtStopSec.stop must be a stop index between 1 and ${last}`);
  if (delay && delay.stop - 1 === skip) throw new Error('delayAtStopSec: the stop before the late stop is skipped');

  // Sideways offsets: the detour and the bypass around a skipped stop.
  const windows: OffsetWindow[] = [];
  const dev = scenario.deviation;
  if (dev) {
    if (!(dev.fromFrac >= 0 && dev.toFrac <= 1 && dev.fromFrac < dev.toFrac)) throw new Error('deviation needs 0 ≤ fromFrac < toFrac ≤ 1');
    const a = dev.fromFrac * pathLengthM;
    const b = dev.toFrac * pathLengthM;
    const sign = dev.side === 'right' ? -1 : 1;
    windows.push({ from: a, to: b, offsetM: sign * dev.offsetM, rampM: Math.max(1, Math.min(Math.abs(dev.offsetM), (b - a) / 3)) });
  }
  if (skip !== undefined) {
    const s = stops[skip];
    const offset = s.radiusM + SKIP_CLEARANCE_M;
    const half = s.radiusM + 60; // full offset within ±half; the ramps are farther than radius + 50 along the path
    windows.push({ from: s.alongM - half - offset, to: s.alongM + half + offset, offsetM: offset, rampM: offset });
  }

  // The line the vehicle actually drives: the path sampled every few metres with the offsets applied.
  const marks = new Set<number>([...cum, ...stops.map((s) => s.alongM)]);
  const unsched = scenario.unscheduledStop;
  const unschedAlong = unsched ? Math.min(1, Math.max(0, unsched.atFrac)) * pathLengthM : undefined;
  if (unschedAlong !== undefined) marks.add(unschedAlong);
  for (let s = 0; s < pathLengthM; s += SAMPLE_M) marks.add(s);
  const sAlong = [...marks].filter((s) => s >= 0 && s <= pathLengthM).sort((a, b) => a - b);
  const sOffset = sAlong.map((s) => offsetAt(windows, s));
  const drive: XY[] = sAlong.map((s, i) => {
    const p = pointAt(base, cum, s);
    if (sOffset[i] === 0) return p;
    const a = pointAt(base, cum, s - NORMAL_HALF_WINDOW_M);
    const b = pointAt(base, cum, s + NORMAL_HALF_WINDOW_M);
    const len = dist(a, b) || 1;
    const left: XY = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
    return [p[0] + left[0] * sOffset[i], p[1] + left[1] * sOffset[i]];
  });
  const dcum = cumulative(drive);
  const toDrive = (s: number) => {
    const i = segmentAt(sAlong, s);
    const len = sAlong[i + 1] - sAlong[i];
    const u = len > 0 ? Math.min(1, Math.max(0, (s - sAlong[i]) / len)) : 0;
    return dcum[i] + (dcum[i + 1] - dcum[i]) * u;
  };
  const fromDrive = (d: number) => {
    const i = segmentAt(dcum, d);
    const len = dcum[i + 1] - dcum[i];
    const u = len > 0 ? Math.min(1, Math.max(0, (d - dcum[i]) / len)) : 0;
    return { alongM: sAlong[i] + (sAlong[i + 1] - sAlong[i]) * u, offsetM: sOffset[i] + (sOffset[i + 1] - sOffset[i]) * u };
  };

  // Where the vehicle stands still.
  const halts: Halt[] = [];
  for (const s of stops) {
    if (s.index === skip) continue;
    // At least one fix while standing at every stop, so a compressed drive can't jump over a radius between fixes.
    let dwell = Math.max(s.waitSec / f, intervalSec);
    if (s.index === 0) dwell = Math.max(dwell, opts.startDwellSec ?? 60);
    if (s.index === last) dwell = Math.max(dwell, 2 * intervalSec);
    if (delay && delay.stop - 1 === s.index) dwell += delay.sec;
    halts.push({ driveAlong: toDrive(s.alongM), dwellSec: Math.round(dwell), stop: s.index });
  }
  let unschedHalt: Halt | undefined;
  if (unsched && unschedAlong !== undefined) {
    unschedHalt = { driveAlong: toDrive(unschedAlong), dwellSec: Math.round(unsched.sec) };
    halts.push(unschedHalt);
  }
  halts.sort((a, b) => a.driveAlong - b.driveAlong);
  if (halts[0].stop !== 0) throw new Error('unscheduledStop must lie after the start stop');
  if (halts[halts.length - 1].stop !== last) throw new Error('unscheduledStop must lie before the last stop');

  // Drive: 1 s steps, a fix every intervalSec.
  const fixes: DriveFix[] = [];
  let t = 0;
  let d = halts[0].driveAlong;
  let pos = pointAt(drive, dcum, d);
  let course = bearingDeg(pos, pointAt(drive, dcum, d + 10));
  const emit = (speedKph: number, force = false) => {
    if (!force && t % intervalSec !== 0) return;
    if (fixes.length && fixes[fixes.length - 1].t === t) return;
    const [lng, lat] = proj.toLngLat(pos);
    const at = fromDrive(d);
    fixes.push({
      t,
      lat: Math.round(lat * 1e6) / 1e6,
      lng: Math.round(lng * 1e6) / 1e6,
      speedKph: Math.round(speedKph * 10) / 10,
      course: Math.round(course) % 360,
      alongM: Math.round(at.alongM * 10) / 10,
      offsetM: Math.round(at.offsetM * 10) / 10,
    });
  };
  const step = (speedKph: number) => {
    t += 1;
    const next = pointAt(drive, dcum, d);
    if (dist(pos, next) > 0.3) course = bearingDeg(pos, next);
    pos = next;
    emit(speedKph);
  };
  emit(0, true);
  let prevHalt = d;
  for (const h of halts) {
    while (d < h.driveAlong - 1e-6) {
      const gap = Math.min(d - prevHalt, h.driveAlong - d);
      const v = Math.min(opts.cruiseKph, Math.max(MIN_MOVING_KPH, Math.sqrt(2 * ACCEL_MPS2 * gap) * 3.6));
      d = Math.min(h.driveAlong, d + (v / 3.6) * f);
      step(v);
    }
    h.arriveT = t;
    for (let k = 0; k < h.dwellSec; k++) step(0);
    h.departT = t;
    prevHalt = h.driveAlong;
  }
  emit(0, true);

  // What the tracker will see: radius entries / exits, deviation episodes.
  const events: DriveEvent[] = [];
  const firstFixAt = (time: number) => {
    const i = fixes.findIndex((x) => x.t >= time);
    return i < 0 ? fixes.length - 1 : i;
  };
  const fixXY = fixes.map((x) => proj.toXY(x.lng, x.lat));
  const summaries: StopSummary[] = stops.map((s) => {
    const halt = halts.find((h) => h.stop === s.index);
    const summary: StopSummary = {
      index: s.index,
      name: s.name,
      radiusM: s.radiusM,
      alongM: Math.round(s.alongM),
      snapM: Math.round(s.snapM),
      skipped: s.index === skip,
      dwellSec: halt?.dwellSec ?? 0,
      offsetMin: s.offsetMin,
      minDistanceM: Infinity,
    };
    let inside = false;
    fixXY.forEach((p, i) => {
      const dm = dist(p, s.xy);
      summary.minDistanceM = Math.min(summary.minDistanceM, dm);
      if (!inside && dm <= s.radiusM) {
        inside = true;
        summary.arriveT ??= fixes[i].t;
        events.push({ t: fixes[i].t, fixIndex: i, type: 'arrive', stop: s.index, detail: `${Math.round(dm)} m from ${s.name}` });
      } else if (inside && dm > s.radiusM) {
        inside = false;
        summary.departT ??= fixes[i].t;
        events.push({ t: fixes[i].t, fixIndex: i, type: 'depart', stop: s.index, detail: s.name });
      }
    });
    summary.minDistanceM = Math.round(summary.minDistanceM);
    if (summary.skipped) {
      const i = Math.max(0, fixes.findIndex((x) => x.alongM >= s.alongM));
      events.push({ t: fixes[i].t, fixIndex: i, type: 'skip', stop: s.index, detail: `${s.name} passed ${summary.minDistanceM} m away` });
    }
    return summary;
  });
  let off = false;
  fixXY.forEach((p, i) => {
    const dm = project(base, cum, p).d;
    if (!off && dm > corridorM) {
      off = true;
      events.push({ t: fixes[i].t, fixIndex: i, type: 'deviation-on', detail: `${Math.round(dm)} m off the path` });
    } else if (off && dm <= corridorM) {
      off = false;
      events.push({ t: fixes[i].t, fixIndex: i, type: 'deviation-off', detail: `back within ${corridorM} m` });
    }
  });
  if (unschedHalt?.arriveT !== undefined && unschedHalt.departT !== undefined) {
    events.push({ t: unschedHalt.arriveT, fixIndex: firstFixAt(unschedHalt.arriveT), type: 'unscheduled-start', detail: `standing ${unschedHalt.dwellSec} s` });
    events.push({ t: unschedHalt.departT, fixIndex: firstFixAt(unschedHalt.departT), type: 'unscheduled-end', detail: 'moving again' });
  }
  events.sort((a, b) => a.t - b.t || a.fixIndex - b.fixIndex);

  return { fixes, events, stops: summaries, pathLengthM: Math.round(pathLengthM), durationSec: t, speedFactor: f };
}

/** Planned-vs-simulated arrival per stop, for picking route offsets (minutes, relative to the drive start). */
export function arrivalTable(tl: DriveTimeline): string[] {
  return tl.stops.map((s) => {
    const sim = s.arriveT === undefined ? '—' : (s.arriveT / 60).toFixed(1);
    const planned = s.offsetMin === undefined ? '' : `  planned ${s.offsetMin} min`;
    const lateBy = s.offsetMin !== undefined && s.arriveT !== undefined && s.index > 0 ? `  (${(s.arriveT / 60 - s.offsetMin).toFixed(1)} min vs plan)` : '';
    const dwell = s.skipped ? 'SKIPPED' : `dwell ${s.dwellSec} s`;
    return `${s.index}. ${s.name.padEnd(22)} along ${String(s.alongM).padStart(6)} m  inside radius at ${sim} min${planned}${lateBy}  ${dwell}  closest ${s.minDistanceM} m`;
  });
}
