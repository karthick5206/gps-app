/**
 * Pure trip / stop / daily-summary state machine. Consumes clean points in fixTime order and carries a small,
 * JSON-serialisable state between runs (stored in SummaryCursor.state).
 *
 * Time accounting: every interval between consecutive points [prev, next] is attributed to the status of `prev`
 * (RUNNING / OVERSPEED / IDLE / STOP), or to OFFLINE when the gap exceeds `offlineAfterSec`. Intervals are split at
 * local midnights, so running + idle + stop + offline always equals the accounted part of each local day.
 */
import { haversineMeters } from '../tracking/geo';
import { localDayKey, localDayRange } from './tz';

export const SEG_RULES = {
  /** Trips shorter than this are dropped. */
  MIN_TRIP_KM: 0.2,
  /** A stationary period at least this long ends a trip. */
  TRIP_SPLIT_STOP_SEC: 300,
  /** A stationary period at least this long is a Stop. */
  MIN_STOP_SEC: 180,
  /** Gaps longer than this contribute distance only when the speed suggests movement. */
  DISTANCE_GAP_SEC: 900,
  /** A stop continues across an offline gap when the vehicle reappears within this radius, still stationary. */
  STOP_GAP_RADIUS_M: 100,
  /** Overspeeding again within this time of the previous overspeed counts as the same episode. */
  OVERSPEED_MERGE_SEC: 60,
} as const;

export interface SegConfig {
  tz: string;
  runningSpeedKph: number;
  offlineAfterSec: number;
  /** Effective speed limit; null = never overspeeding. */
  speedLimitKph: number | null;
  maxPlausibleKph: number;
}

/** A clean point. DRIFT points must be passed with speed 0 and the last clean coordinates. */
export interface SegPoint {
  t: number; // epoch ms
  lat: number;
  lng: number;
  speed: number;
  ign: boolean | null;
}

export interface DayAcc {
  day: string;
  start: number; // local midnight (epoch ms)
  end: number; // next local midnight
  runningMs: number;
  idleMs: number;
  stopMs: number;
  offlineMs: number;
  overspeedMs: number;
  engineMs: number;
  overspeedCount: number;
  distanceM: number;
  maxSpeed: number;
  /** Σ speed × ms over running intervals (time-weighted average moving speed). */
  speedTimeSum: number;
}

interface OpenTrip {
  start: number;
  lat: number;
  lng: number;
  distM: number;
  idleMs: number;
  maxSpeed: number;
}

interface OpenStationary {
  start: number;
  lat: number;
  lng: number;
  ignOn: boolean;
  /** Distance accumulated while stationary (removed from the trip when the stop ends it). */
  distM: number;
}

export interface SegState {
  v: 1;
  /** Time up to which intervals have been accounted (≥ last.t; > last.t after an offline extension). */
  at: number | null;
  last: SegPoint | null;
  day: DayAcc | null;
  over: boolean;
  /** End of the last overspeed interval (episode debounce). */
  overUntil?: number | null;
  trip: OpenTrip | null;
  stat: OpenStationary | null;
}

export interface TripOut {
  start: number;
  end: number;
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  distanceKm: number;
  durationSec: number;
  idleSec: number;
  maxSpeedKph: number;
  avgSpeedKph: number;
}

export interface StopOut {
  start: number;
  end: number;
  lat: number;
  lng: number;
  durationSec: number;
  ignitionOn: boolean;
}

export interface SegOutput {
  trips: TripOut[];
  stops: StopOut[];
  /** Days that ended (crossed local midnight) during this call. */
  days: DayAcc[];
  /** State at every local midnight crossed during this call (day = the day starting at that midnight). */
  snapshots: { day: string; state: SegState }[];
}

type Kind = 'RUNNING' | 'OVERSPEED' | 'IDLE' | 'STOP' | 'OFFLINE';

export function emptyOutput(): SegOutput {
  return { trips: [], stops: [], days: [], snapshots: [] };
}

/** Fresh state. `at` = start of accounting (null = from local midnight of the first point). */
export function createState(at: number | null = null): SegState {
  return { v: 1, at, last: null, day: null, over: false, overUntil: null, trip: null, stat: null };
}

export function cloneState(state: SegState): SegState {
  return structuredClone(state);
}

function newDay(t: number, tz: string): DayAcc {
  const day = localDayKey(t, tz);
  const { start, end } = localDayRange(day, tz);
  return {
    day,
    start,
    end,
    runningMs: 0,
    idleMs: 0,
    stopMs: 0,
    offlineMs: 0,
    overspeedMs: 0,
    engineMs: 0,
    overspeedCount: 0,
    distanceM: 0,
    maxSpeed: 0,
    speedTimeSum: 0,
  };
}

const isMoving = (p: SegPoint, cfg: SegConfig) => p.speed > cfg.runningSpeedKph;

function kindOf(p: SegPoint, cfg: SegConfig): Kind {
  if (isMoving(p, cfg)) return cfg.speedLimitKph !== null && p.speed > cfg.speedLimitKph ? 'OVERSPEED' : 'RUNNING';
  return p.ign === true ? 'IDLE' : 'STOP';
}

/**
 * Attribute [state.at, to] to `kind`, splitting at local midnights. Non-gap distance is spread over the interval
 * [distFrom, to] at a constant rate; gap distance (`gapDistM`) goes to the day containing `to`.
 */
function account(
  state: SegState,
  to: number,
  kind: Kind,
  engine: boolean,
  speed: number,
  rateMPerMs: number,
  gapDistM: number,
  cfg: SegConfig,
  out: SegOutput,
): void {
  let cur = state.at ?? to;
  if (!state.day) state.day = newDay(cur, cfg.tz);
  let first = true;
  while (cur < to) {
    if (cur >= state.day.end) {
      out.days.push(state.day);
      state.day = newDay(state.day.end, cfg.tz);
      state.at = cur;
      out.snapshots.push({ day: state.day.day, state: cloneState(state) });
    }
    const segEnd = Math.min(to, state.day.end);
    const ms = segEnd - cur;
    const d = state.day;
    if (first) {
      if (kind === 'OVERSPEED' && !state.over && ms > 0) {
        const lastOver = state.overUntil ?? null;
        if (lastOver === null || cur - lastOver > SEG_RULES.OVERSPEED_MERGE_SEC * 1000) d.overspeedCount++;
      }
      state.over = kind === 'OVERSPEED';
      first = false;
    }
    switch (kind) {
      case 'RUNNING':
      case 'OVERSPEED':
        d.runningMs += ms;
        d.speedTimeSum += speed * ms;
        if (kind === 'OVERSPEED') d.overspeedMs += ms;
        break;
      case 'IDLE':
        d.idleMs += ms;
        break;
      case 'STOP':
        d.stopMs += ms;
        break;
      case 'OFFLINE':
        d.offlineMs += ms;
        break;
    }
    if (engine) d.engineMs += ms;
    d.distanceM += rateMPerMs * ms;
    if (segEnd === to) d.distanceM += gapDistM;
    cur = segEnd;
  }
  if (kind === 'OVERSPEED') state.overUntil = to;
  state.at = to;
}

function closeTripAt(state: SegState, end: number, lat: number, lng: number, extraDistM: number, out: SegOutput): void {
  const trip = state.trip;
  state.trip = null;
  if (!trip) return;
  const distM = Math.max(0, trip.distM - extraDistM);
  if (distM / 1000 < SEG_RULES.MIN_TRIP_KM || end <= trip.start) return;
  const durationSec = Math.round((end - trip.start) / 1000);
  const idleSec = Math.min(durationSec, Math.round(trip.idleMs / 1000));
  const movingSec = Math.max(1, durationSec - idleSec);
  out.trips.push({
    start: trip.start,
    end,
    startLat: trip.lat,
    startLng: trip.lng,
    endLat: lat,
    endLng: lng,
    distanceKm: round3(distM / 1000),
    durationSec,
    idleSec,
    maxSpeedKph: trip.maxSpeed,
    avgSpeedKph: round1(Math.min(trip.maxSpeed || Infinity, (distM / 1000 / movingSec) * 3600)),
  });
}

/** End the trip where the current stationary period began (the stop splits the trip). */
function closeTripAtStationary(state: SegState, out: SegOutput): void {
  const stat = state.stat;
  if (!stat) return;
  closeTripAt(state, stat.start, stat.lat, stat.lng, stat.distM, out);
}

function emitStop(stat: OpenStationary, end: number, out: SegOutput): void {
  const durationSec = Math.round((end - stat.start) / 1000);
  if (durationSec < SEG_RULES.MIN_STOP_SEC) return;
  out.stops.push({ start: stat.start, end, lat: stat.lat, lng: stat.lng, durationSec, ignitionOn: stat.ignOn });
}

function startSegment(state: SegState, p: SegPoint, cfg: SegConfig): void {
  state.trip = null;
  state.stat = null;
  if (isMoving(p, cfg)) state.trip = { start: p.t, lat: p.lat, lng: p.lng, distM: 0, idleMs: 0, maxSpeed: p.speed };
  else state.stat = { start: p.t, lat: p.lat, lng: p.lng, ignOn: p.ign === true, distM: 0 };
}

/** Close everything open at `last` (before an offline gap). */
function closeAll(state: SegState, last: SegPoint, out: SegOutput): void {
  if (state.stat) {
    emitStop(state.stat, last.t, out);
    if (state.trip) closeTripAtStationary(state, out);
  } else if (state.trip) {
    closeTripAt(state, last.t, last.lat, last.lng, 0, out);
  }
  state.trip = null;
  state.stat = null;
}

export function processPoint(state: SegState, p: SegPoint, cfg: SegConfig, out: SegOutput): void {
  if (state.at !== null && p.t <= state.at) return; // duplicate or already accounted
  const last = state.last;
  const moving = isMoving(p, cfg);

  if (!last) {
    if (state.at === null) state.at = localDayRange(localDayKey(p.t, cfg.tz), cfg.tz).start;
    account(state, p.t, 'OFFLINE', false, 0, 0, 0, cfg, out);
    startSegment(state, p, cfg);
    state.last = p;
    if (moving && state.day) state.day.maxSpeed = Math.max(state.day.maxSpeed, p.speed);
    return;
  }

  const dt = p.t - last.t;
  const gap = dt > cfg.offlineAfterSec * 1000;
  const lastMoving = isMoving(last, cfg);
  let d = haversineMeters(last.lat, last.lng, p.lat, p.lng);
  const impliedKph = (d / Math.max(dt / 1000, 1)) * 3.6;
  if (impliedKph > cfg.maxPlausibleKph) d = 0;
  else if (dt > SEG_RULES.DISTANCE_GAP_SEC * 1000 && !lastMoving && !moving) d = 0;

  if (gap) account(state, p.t, 'OFFLINE', false, 0, 0, d, cfg, out);
  else account(state, p.t, kindOf(last, cfg), last.ign === true, last.speed, d / Math.max(dt, 1), 0, cfg, out);

  if (gap) {
    const stat = state.stat;
    if (stat && !moving && haversineMeters(stat.lat, stat.lng, p.lat, p.lng) <= SEG_RULES.STOP_GAP_RADIUS_M) {
      stat.ignOn = stat.ignOn && p.ign === true;
      if (state.trip && p.t - stat.start >= SEG_RULES.TRIP_SPLIT_STOP_SEC * 1000) closeTripAtStationary(state, out);
    } else {
      closeAll(state, last, out);
      startSegment(state, p, cfg);
    }
  } else {
    if (state.trip) state.trip.distM += d;
    if (state.stat) state.stat.distM += d;
    if (moving) {
      const stat = state.stat;
      if (stat) {
        const durMs = p.t - stat.start;
        emitStop(stat, p.t, out);
        if (state.trip) {
          if (durMs >= SEG_RULES.TRIP_SPLIT_STOP_SEC * 1000) closeTripAtStationary(state, out);
          else state.trip.idleMs += durMs;
        }
        state.stat = null;
      }
      if (!state.trip) state.trip = { start: p.t, lat: p.lat, lng: p.lng, distM: 0, idleMs: 0, maxSpeed: p.speed };
      state.trip.maxSpeed = Math.max(state.trip.maxSpeed, p.speed);
    } else if (state.stat) {
      state.stat.ignOn = state.stat.ignOn && p.ign === true;
      if (state.trip && p.t - state.stat.start >= SEG_RULES.TRIP_SPLIT_STOP_SEC * 1000) closeTripAtStationary(state, out);
    } else {
      state.stat = { start: p.t, lat: p.lat, lng: p.lng, ignOn: p.ign === true, distM: 0 };
    }
  }

  state.last = p;
  if (moving && state.day) state.day.maxSpeed = Math.max(state.day.maxSpeed, p.speed);
}

/**
 * Account a silent device as OFFLINE up to `until` (used to close out whole past days). Only applies when the last
 * point is older than the offline threshold; open trips/stops are left for the next point to decide.
 */
export function extendOffline(state: SegState, until: number, cfg: SegConfig, out: SegOutput): void {
  if (!state.last || state.at === null || until <= state.at) return;
  if (until - state.last.t <= cfg.offlineAfterSec * 1000) return;
  account(state, until, 'OFFLINE', false, 0, 0, 0, cfg, out);
  state.over = false;
}

/**
 * Provisional (still open) trip and stop at the end of the data — used by the history API for ranges the
 * summarizer has not closed yet. Does not modify the state.
 */
export function openSegments(state: SegState): { trip: TripOut | null; stop: StopOut | null } {
  const copy = cloneState(state);
  const out = emptyOutput();
  const last = copy.last;
  if (!last) return { trip: null, stop: null };
  closeAll(copy, last, out);
  return { trip: out.trips[0] ?? null, stop: out.stops[0] ?? null };
}

export interface DaySeconds {
  runningSec: number;
  idleSec: number;
  stopSec: number;
  offlineSec: number;
  overspeedSec: number;
  engineSec: number;
}

/** Whole seconds that add up exactly to the rounded accounted time (largest-remainder rounding). */
export function daySeconds(d: DayAcc): DaySeconds {
  const parts = [d.runningMs, d.idleMs, d.stopMs, d.offlineMs];
  const [runningSec, idleSec, stopSec, offlineSec] = apportion(parts);
  return {
    runningSec,
    idleSec,
    stopSec,
    offlineSec,
    overspeedSec: Math.min(runningSec, Math.round(d.overspeedMs / 1000)),
    engineSec: Math.round(d.engineMs / 1000),
  };
}

export function apportion(msParts: number[]): number[] {
  const total = Math.round(msParts.reduce((a, b) => a + b, 0) / 1000);
  const exact = msParts.map((ms) => ms / 1000);
  const floors = exact.map(Math.floor);
  let rest = total - floors.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (rest <= 0) break;
    floors[i]++;
    rest--;
  }
  return floors;
}

export function avgMovingSpeed(d: Pick<DayAcc, 'runningMs' | 'speedTimeSum'>): number {
  return d.runningMs > 0 ? round1(d.speedTimeSum / d.runningMs) : 0;
}

export const round1 = (v: number) => Math.round(v * 10) / 10;
export const round3 = (v: number) => Math.round(v * 1000) / 1000;
