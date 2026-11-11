import { PLANNED_TRIP_TIMING, PlannedStopStatus, PlannedTripLiveUpdate, PlannedTripStatus, RoutePath } from '@veetracer/shared';
import { distanceToRoad } from '../../point-quality/road-match';
import { haversineMeters } from '../../tracking/geo';

/**
 * Planned-trip live tracking (docs/routes-trips/SPEC.md §4.3): a pure, deterministic per-fix state machine. The
 * processor's `PlannedTripTracker` feeds it the valid live fixes of a batch with the vehicle's open trips (from its
 * cache) and the per-object state (`vt:ptrip:<objectId>`), and turns the effects into DB statements, alerts and
 * socket pushes. Times are epoch ms; nothing here reads the clock or does I/O.
 */

const MIN = 60_000;

export const TRACKER = {
  /** Consecutive fixes outside the corridor before a deviation opens. */
  deviationFixes: 2,
  /** Below this speed the vehicle counts as standing still. */
  stillKph: 3,
  /** Standing still outside every stop radius this long = unscheduled stop. */
  stillMs: 5 * MIN,
  /** ETA / delay are recomputed at most this often per trip (and whenever the next stop changes). */
  etaEveryMs: MIN,
  /** Floor of the average speed used for the ETA. */
  minEtaKph: 20,
  /** Window of the "recent average speed". */
  speedWindowMs: 5 * MIN,
  /** A start without having been seen inside the start radius: last fix within this × radius, now moving away. */
  startNearFactor: 2,
  /** Recently finished trip ids kept so a stale cache never picks them again. */
  closedKeep: 10,
  /** Alert cooldown marks older than this are dropped. */
  cooldownKeepMs: 24 * 3600_000,
} as const;

/** Leaving a radius needs a little more than the radius itself, so GPS jitter at the edge doesn't flap. */
export const leaveRadiusM = (radiusM: number): number => radiusM + Math.max(10, radiusM * 0.1);

const OPEN: readonly PlannedTripStatus[] = ['SCHEDULED', 'STARTED', 'IN_PROGRESS'];
const RANK: Partial<Record<PlannedTripStatus, number>> = { SCHEDULED: 0, STARTED: 1, IN_PROGRESS: 2 };

// ───────────── inputs ─────────────

export interface TripStopSnap {
  seq: number;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
  plannedArrival: number;
  plannedDeparture: number;
  status: PlannedStopStatus;
  actualArrival: number | null;
  actualDeparture: number | null;
  delaySec: number | null;
}

/** An open trip as loaded from the database (the route snapshot plus its stored progress). */
export interface TripSnap {
  id: string;
  routeName: string;
  corridorM: number;
  path: RoutePath | null;
  plannedStart: number;
  plannedEnd: number;
  status: PlannedTripStatus;
  actualStart: number | null;
  deviationCount: number;
  maxDeviationM: number | null;
  distanceKm: number | null;
  /** Ordered by seq. */
  stops: TripStopSnap[];
}

/** A trip with its geometry pre-computed once per cache load. */
export interface PreparedTrip extends TripSnap {
  /** [lng, lat] line used for deviation / remaining distance: the road path, else straight legs between stops. */
  line: [number, number][];
  /** Cumulative length (m) of `line` at each vertex. */
  cum: number[];
  /** Distance along `line` (m) of each stop. */
  stopAlong: number[];
}

export interface TrackerFix {
  t: number;
  lat: number;
  lng: number;
  speedKph: number;
}

export interface TrackOptions {
  /** TRIP_STOP_LATE threshold (alert setting `lateMin`, default 10). */
  lateMin: number;
  /** ROUTE_DEVIATION threshold (alert setting `minDistanceM`); null = the trip's corridor. */
  deviationAlertM: number | null;
  /** Road travel time to the next stop from the routing engine, when it answered for this trip / stop. */
  routeEta?: { tripId: string; seq: number; sec: number } | null;
  newId: () => string;
}

// ───────────── state (persisted as JSON in vt:ptrip:<objectId>) ─────────────

export interface StopState {
  s: PlannedStopStatus;
  /** actualArrival / actualDeparture / delaySec */
  a: number | null;
  d: number | null;
  dl: number | null;
}

export interface TripState {
  id: string;
  status: PlannedTripStatus;
  start: number | null;
  stops: StopState[];
  /** Index of the stop the vehicle is inside (arrived, not yet left). */
  at: number | null;
  /** SCHEDULED: distance to the start stop at the previous fix. */
  near: number | null;
  /** Segment index of the last match on `line` (search hint). */
  hint: number;
  /** Consecutive fixes outside the corridor, and the first of them. */
  out: number;
  of: { t: number; lat: number; lng: number; d: number } | null;
  /** Open deviation event. */
  dev: { id: string; t: number; max: number; alerted: boolean } | null;
  devN: number;
  devMax: number | null;
  /** Standing-still episode outside stops; `id` once the UNSCHEDULED_STOP event is open. */
  still: { t: number; lat: number; lng: number; id: string | null } | null;
  /** Recent [t, km/h] samples. */
  spd: [number, number][];
  km: number;
  last: { t: number; lat: number; lng: number } | null;
  /** Last ETA computation. */
  eta: { t: number; seq: number | null; at: number | null; delay: number | null } | null;
}

export interface ObjectTripState {
  v: 1;
  trip: TripState | null;
  closed: string[];
  /** Alert cooldown marks (key → time), checked by the engine with the alert settings. */
  cd: Record<string, number>;
}

export const emptyObjectTripState = (): ObjectTripState => ({ v: 1, trip: null, closed: [], cd: {} });

export function parseObjectTripState(json: string | null): ObjectTripState | null {
  if (!json) return null;
  try {
    const s = JSON.parse(json) as ObjectTripState;
    return s && s.v === 1 && Array.isArray(s.closed) && typeof s.cd === 'object' && s.cd !== null ? s : null;
  } catch {
    return null;
  }
}

// ───────────── effects ─────────────

export type TripAlertType = 'ROUTE_DEVIATION' | 'TRIP_STOP_LATE' | 'TRIP_STOP_SKIPPED' | 'TRIP_COMPLETED';

export interface TripRowUpdate {
  status?: PlannedTripStatus;
  actualStart?: number;
  actualEnd?: number;
  closedBy?: 'AUTO' | 'TIMEOUT';
  nextStopSeq?: number | null;
  etaNextStop?: number | null;
  delaySec?: number | null;
  deviationCount?: number;
  maxDeviationM?: number | null;
  distanceKm?: number;
}

export interface StopRowUpdate {
  tripId: string;
  seq: number;
  status: PlannedStopStatus;
  actualArrival?: number;
  actualDeparture?: number;
  delaySec?: number | null;
}

export interface TripEventOpen {
  id: string;
  tripId: string;
  kind: 'UNSCHEDULED_STOP' | 'DEVIATION';
  startAt: number;
  lat: number;
  lng: number;
}

export interface TripEventClose {
  id: string;
  endAt: number;
  data: Record<string, number>;
}

export interface TripAlert {
  type: TripAlertType;
  tripId: string;
  at: number;
  lat: number;
  lng: number;
  message: string;
  data: Record<string, unknown>;
  /** Per trip (deviation, completion) or per trip stop. */
  cooldownKey: string;
}

export interface TrackEffects {
  trips: { id: string; data: TripRowUpdate }[];
  stops: StopRowUpdate[];
  eventOpens: TripEventOpen[];
  eventCloses: TripEventClose[];
  alerts: TripAlert[];
  live: PlannedTripLiveUpdate[];
  /** A trip changed status (caches holding trip lists should reload). */
  statusChanged: boolean;
}

export const emptyEffects = (): TrackEffects => ({ trips: [], stops: [], eventOpens: [], eventCloses: [], alerts: [], live: [], statusChanged: false });

// ───────────── geometry ─────────────

const distM = (fix: { lat: number; lng: number }, p: { lat: number; lng: number }) => haversineMeters(fix.lat, fix.lng, p.lat, p.lng);

/** Projection of a point on segment k of a [lng, lat] line (local flat approximation): distance (m) and fraction. */
function projectOnSegment(line: [number, number][], k: number, lat: number, lng: number): { d: number; u: number } {
  const mLat = 111_320;
  const mLng = 111_320 * Math.cos((lat * Math.PI) / 180);
  const ax = (line[k][0] - lng) * mLng;
  const ay = (line[k][1] - lat) * mLat;
  const dx = (line[k + 1][0] - line[k][0]) * mLng;
  const dy = (line[k + 1][1] - line[k][1]) * mLat;
  const len2 = dx * dx + dy * dy;
  const u = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return { d: Math.hypot(ax + u * dx, ay + u * dy), u };
}

/** Distance along the line (m) of a point projected on segment k. */
function alongAt(line: [number, number][], cum: number[], k: number, lat: number, lng: number): number {
  if (line.length < 2) return 0;
  const i = Math.max(0, Math.min(line.length - 2, k));
  return cum[i] + projectOnSegment(line, i, lat, lng).u * (cum[i + 1] - cum[i]);
}

/** Line, cumulative lengths and the along-line position of each stop (searched forward, so stops stay in order). */
export function prepareTrip(snap: TripSnap): PreparedTrip {
  const stops = [...snap.stops].sort((a, b) => a.seq - b.seq);
  const path = Array.isArray(snap.path) && snap.path.length >= 2 ? snap.path : null;
  const line: [number, number][] = path ?? stops.map((s) => [s.lng, s.lat] as [number, number]);
  const cum = [0];
  for (let k = 1; k < line.length; k++) cum.push(cum[k - 1] + haversineMeters(line[k - 1][1], line[k - 1][0], line[k][1], line[k][0]));
  const stopAlong: number[] = [];
  let from = 0;
  for (const s of stops) {
    if (line.length < 2) {
      stopAlong.push(0);
      continue;
    }
    let best = { k: from, d: Number.POSITIVE_INFINITY };
    for (let k = from; k < line.length - 1; k++) {
      const p = projectOnSegment(line, k, s.lat, s.lng);
      if (p.d < best.d) best = { k, d: p.d };
    }
    stopAlong.push(Math.max(alongAt(line, cum, best.k, s.lat, s.lng), stopAlong[stopAlong.length - 1] ?? 0));
    from = best.k;
  }
  return { ...snap, stops, line, cum, stopAlong };
}

// ───────────── selection ─────────────

const inWindow = (t: TripSnap, at: number) =>
  at >= t.plannedStart - PLANNED_TRIP_TIMING.candidateBeforeMin * MIN && at <= t.plannedEnd + PLANNED_TRIP_TIMING.incompleteAfterMin * MIN;
const insideStart = (t: TripSnap, fix: TrackerFix) => !!t.stops[0] && distM(fix, t.stops[0]) <= t.stops[0].radiusM;

/** State of a trip as stored in the database (first time the tracker sees it, or after a manual change). */
export function initTripState(trip: TripSnap): TripState {
  let at: number | null = null;
  trip.stops.forEach((s, i) => {
    if (s.status === 'ARRIVED') at = i;
  });
  return {
    id: trip.id,
    status: trip.status,
    start: trip.actualStart,
    stops: trip.stops.map((s) => ({ s: s.status, a: s.actualArrival, d: s.actualDeparture, dl: s.delaySec })),
    at: trip.status === 'SCHEDULED' ? null : at,
    near: null,
    hint: 0,
    out: 0,
    of: null,
    dev: null,
    devN: trip.deviationCount,
    devMax: trip.maxDeviationM,
    still: null,
    spd: [],
    km: trip.distanceKm ?? 0,
    last: null,
    eta: null,
  };
}

/** SCHEDULED candidate to watch: one whose start radius the vehicle is in, else the current one, else the nearest in time. */
function chooseCandidate(cands: PreparedTrip[], watched: string | null, fix: TrackerFix): PreparedTrip | null {
  if (!cands.length) return null;
  const byTime = (a: PreparedTrip, b: PreparedTrip) => Math.abs(a.plannedStart - fix.t) - Math.abs(b.plannedStart - fix.t) || a.plannedStart - b.plannedStart;
  const inside = cands.filter((t) => insideStart(t, fix)).sort(byTime);
  if (inside.length) return inside[0];
  const current = watched ? cands.find((t) => t.id === watched) : undefined;
  return current ?? [...cands].sort(byTime)[0];
}

/**
 * One fix of one vehicle. `trips` are the vehicle's open trips (any of SCHEDULED / STARTED / IN_PROGRESS, from the
 * cache, possibly a little stale: the state is ahead of it for the trip being tracked). At most one trip is active.
 */
export function trackFix(trips: PreparedTrip[], prev: ObjectTripState | null, fix: TrackerFix, opts: TrackOptions): { state: ObjectTripState; effects: TrackEffects } {
  const st: ObjectTripState = prev ? (JSON.parse(JSON.stringify(prev)) as ObjectTripState) : emptyObjectTripState();
  const eff = emptyEffects();
  const usable = trips.filter((t) => !st.closed.includes(t.id) && OPEN.includes(t.status));
  const byId = new Map(usable.map((t) => [t.id, t]));

  let cur = st.trip ? byId.get(st.trip.id) : undefined;
  if (st.trip && !cur) st.trip = null; // cancelled, closed elsewhere or out of the cache window
  // Changed in the database beyond what the tracker knows (manual start): take the stored progress.
  if (st.trip && cur && (RANK[cur.status] ?? 0) > (RANK[st.trip.status] ?? 0)) st.trip = initTripState(cur);
  if (st.trip?.status === 'SCHEDULED' && cur && !inWindow(cur, fix.t)) st.trip = null;

  if (!st.trip || st.trip.status === 'SCHEDULED') {
    const dbActive = usable.filter((t) => t.status !== 'SCHEDULED').sort((a, b) => b.plannedStart - a.plannedStart)[0];
    if (dbActive) {
      cur = dbActive;
      st.trip = initTripState(dbActive);
    } else {
      const pick = chooseCandidate(usable.filter((t) => t.status === 'SCHEDULED' && inWindow(t, fix.t)), st.trip?.id ?? null, fix);
      cur = pick ?? undefined;
      st.trip = !pick ? null : pick.id === st.trip?.id ? st.trip : initTripState(pick);
    }
  }

  if (st.trip && cur) {
    const finished = evaluateTrip(cur, st.trip, fix, opts, eff);
    if (finished) {
      closeTrip(st, cur.id);
    } else if (st.trip.status === 'STARTED' || st.trip.status === 'IN_PROGRESS') {
      // A newer trip of the same vehicle starts: the current one is closed as INCOMPLETE (SPEC "Incomplete").
      const newer = usable
        .filter((t) => t.id !== cur!.id && t.status === 'SCHEDULED' && t.plannedStart > cur!.plannedStart && inWindow(t, fix.t) && insideStart(t, fix))
        .sort((a, b) => a.plannedStart - b.plannedStart)[0];
      if (newer) {
        closeIncomplete(cur, st.trip, fix, eff);
        closeTrip(st, cur.id);
        st.trip = initTripState(newer);
        if (evaluateTrip(newer, st.trip, fix, opts, eff)) closeTrip(st, newer.id);
      }
    }
  }

  for (const [k, at] of Object.entries(st.cd)) if (fix.t - at > TRACKER.cooldownKeepMs) delete st.cd[k];
  return { state: st, effects: eff };
}

function closeTrip(st: ObjectTripState, id: string): void {
  st.trip = null;
  st.closed = [...st.closed.filter((x) => x !== id), id].slice(-TRACKER.closedKeep);
}

// ───────────── per-trip rules ─────────────

const round = (n: number) => Math.round(n);
const km1 = (m: number) => Math.round(m * 10) / 10;

interface Ctx {
  trip: PreparedTrip;
  ts: TripState;
  fix: TrackerFix;
  eff: TrackEffects;
  upd: TripRowUpdate;
  stopsChanged: boolean;
}

function setStop(c: Ctx, i: number, next: Partial<StopState>): void {
  const s = c.ts.stops[i];
  Object.assign(s, next);
  const row: StopRowUpdate = { tripId: c.trip.id, seq: c.trip.stops[i].seq, status: s.s };
  if (next.a !== undefined && next.a !== null) row.actualArrival = next.a;
  if (next.d !== undefined && next.d !== null) row.actualDeparture = next.d;
  if (next.dl !== undefined) row.delaySec = next.dl;
  c.eff.stops.push(row);
  c.stopsChanged = true;
}

function setStatus(c: Ctx, status: PlannedTripStatus): void {
  c.ts.status = status;
  c.upd.status = status;
  c.eff.statusChanged = true;
}

function alert(c: Ctx, type: TripAlertType, message: string, data: Record<string, unknown>, cooldownKey: string): void {
  c.eff.alerts.push({
    type,
    tripId: c.trip.id,
    at: c.fix.t,
    lat: c.fix.lat,
    lng: c.fix.lng,
    message,
    data: { tripId: c.trip.id, routeName: c.trip.routeName, ...data },
    cooldownKey,
  });
}

const delayText = (sec: number) => {
  const min = Math.round(Math.abs(sec) / 60);
  return sec >= 0 ? `${min} min late` : `${min} min early`;
};

/** Vehicle leaves the start radius: IN_PROGRESS, actualStart, start stop departed (its delay = start delay). */
function depart(c: Ctx): void {
  const t = c.fix.t;
  setStatus(c, 'IN_PROGRESS');
  c.ts.start = t;
  c.upd.actualStart = t;
  setStop(c, 0, { s: 'DEPARTED', d: t, dl: round((t - c.trip.stops[0].plannedDeparture) / 1000) });
  c.ts.at = null;
}

/** Index of the last stop that is no longer PENDING (−1 when none). */
function lastReached(ts: TripState): number {
  for (let i = ts.stops.length - 1; i >= 0; i--) if (ts.stops[i].s !== 'PENDING') return i;
  return -1;
}

function nextPending(ts: TripState): number {
  for (let i = lastReached(ts) + 1; i < ts.stops.length; i++) if (ts.stops[i].s === 'PENDING') return i;
  return -1;
}

function closeEvents(c: Ctx): void {
  const t = c.fix.t;
  if (c.ts.dev) {
    c.eff.eventCloses.push({ id: c.ts.dev.id, endAt: t, data: { maxM: round(c.ts.dev.max) } });
    c.ts.dev = null;
  }
  if (c.ts.still?.id) c.eff.eventCloses.push({ id: c.ts.still.id, endAt: t, data: { durationSec: round((t - c.ts.still.t) / 1000) } });
  c.ts.still = null;
  c.ts.out = 0;
  c.ts.of = null;
}

/** Returns true when the trip finished (COMPLETED) on this fix. */
function evaluateTrip(trip: PreparedTrip, ts: TripState, fix: TrackerFix, opts: TrackOptions, eff: TrackEffects): boolean {
  if (ts.last && fix.t <= ts.last.t) return false;
  if (!trip.stops.length) return false;
  const c: Ctx = { trip, ts, fix, eff, upd: {}, stopsChanged: false };
  const sig = liveSignature(ts);
  const wasMoving = ts.status === 'IN_PROGRESS';
  const start = trip.stops[0];
  const d0 = distM(fix, start);
  let finished = false;

  // ── Start ──
  if (ts.status === 'SCHEDULED') {
    if (d0 <= start.radiusM) {
      setStatus(c, 'STARTED');
      setStop(c, 0, { s: 'ARRIVED', a: fix.t });
      ts.at = 0;
    } else if (ts.near !== null && ts.near <= TRACKER.startNearFactor * start.radiusM && d0 > ts.near && fix.speedKph >= TRACKER.stillKph) {
      // Never seen inside (first fix already outside), moving away from near the start: it started.
      depart(c);
    }
    ts.near = d0;
  } else if (ts.status === 'STARTED' && d0 > leaveRadiusM(start.radiusM)) {
    depart(c);
  }

  // Match on the line (deviation, remaining distance).
  let match = { d: 0, idx: ts.hint };
  if (ts.status === 'STARTED' || ts.status === 'IN_PROGRESS') {
    match = distanceToRoad(fix.lat, fix.lng, trip.line, ts.hint);
    if (match.d > trip.corridorM) {
      const full = distanceToRoad(fix.lat, fix.lng, trip.line, 0, trip.line.length);
      if (full.d < match.d) match = full;
    }
    ts.hint = match.idx;
  }

  if (ts.status === 'IN_PROGRESS') {
    if (wasMoving && ts.last) ts.km += distM(fix, ts.last) / 1000;

    // ── Stop departure / arrival (in order; reaching a later stop skips the PENDING ones before it) ──
    if (ts.at !== null && distM(fix, trip.stops[ts.at]) > leaveRadiusM(trip.stops[ts.at].radiusM)) {
      setStop(c, ts.at, { s: 'DEPARTED', d: fix.t });
      ts.at = null;
    }
    if (ts.at === null) {
      const from = lastReached(ts) + 1;
      for (let j = from; j < trip.stops.length; j++) {
        const s = trip.stops[j];
        if (ts.stops[j].s !== 'PENDING' || distM(fix, s) > s.radiusM) continue;
        for (let k = from; k < j; k++) {
          if (ts.stops[k].s !== 'PENDING') continue;
          setStop(c, k, { s: 'SKIPPED' });
          const sk = trip.stops[k];
          alert(c, 'TRIP_STOP_SKIPPED', `Skipped stop ${sk.name} (${trip.routeName})`, { stopName: sk.name, stopSeq: sk.seq }, `TRIP_STOP_SKIPPED:${trip.id}:${sk.seq}`);
        }
        const delay = round((fix.t - s.plannedArrival) / 1000);
        setStop(c, j, { s: 'ARRIVED', a: fix.t, dl: delay });
        ts.at = j;
        if (delay > opts.lateMin * 60) {
          alert(
            c,
            'TRIP_STOP_LATE',
            `Late at ${s.name} (${trip.routeName}): ${Math.round(delay / 60)} min behind plan`,
            { stopName: s.name, stopSeq: s.seq, delayMin: Math.round(delay / 60), delaySec: delay },
            `TRIP_STOP_LATE:${trip.id}:${s.seq}`,
          );
        }
        // ── Complete ──
        if (j === trip.stops.length - 1) {
          closeEvents(c);
          setStatus(c, 'COMPLETED');
          Object.assign(c.upd, {
            actualEnd: fix.t,
            closedBy: 'AUTO' as const,
            nextStopSeq: null,
            etaNextStop: null,
            delaySec: delay,
            distanceKm: km1(ts.km),
            deviationCount: ts.devN,
            maxDeviationM: ts.devMax,
          });
          ts.eta = { t: fix.t, seq: null, at: null, delay };
          alert(
            c,
            'TRIP_COMPLETED',
            `Completed ${trip.routeName} (${delayText(delay)})`,
            { stopName: s.name, stopSeq: s.seq, delayMin: Math.round(delay / 60), delaySec: delay, distanceKm: km1(ts.km) },
            `TRIP_COMPLETED:${trip.id}`,
          );
          finished = true;
        }
        break;
      }
    }

    if (!finished) {
      // ── Deviation ──
      if (match.d > trip.corridorM) {
        ts.out++;
        if (!ts.of) ts.of = { t: fix.t, lat: fix.lat, lng: fix.lng, d: match.d };
        if (ts.dev) {
          ts.dev.max = Math.max(ts.dev.max, match.d);
        } else if (ts.out >= TRACKER.deviationFixes) {
          const id = opts.newId();
          ts.dev = { id, t: ts.of.t, max: Math.max(ts.of.d, match.d), alerted: false };
          ts.devN++;
          eff.eventOpens.push({ id, tripId: trip.id, kind: 'DEVIATION', startAt: ts.of.t, lat: ts.of.lat, lng: ts.of.lng });
          c.upd.deviationCount = ts.devN;
        }
        if (ts.dev) {
          const maxM = round(ts.dev.max);
          if (ts.devMax === null || maxM > ts.devMax) {
            ts.devMax = maxM;
            c.upd.maxDeviationM = maxM;
          }
          const threshold = Math.max(trip.corridorM, opts.deviationAlertM ?? trip.corridorM);
          if (!ts.dev.alerted && ts.dev.max > threshold) {
            ts.dev.alerted = true;
            alert(c, 'ROUTE_DEVIATION', `Off route ${trip.routeName}: ${maxM} m from the planned path`, { distanceM: maxM, corridorM: trip.corridorM }, `ROUTE_DEVIATION:${trip.id}`);
          }
        }
      } else {
        ts.out = 0;
        ts.of = null;
        if (ts.dev) {
          eff.eventCloses.push({ id: ts.dev.id, endAt: fix.t, data: { maxM: round(ts.dev.max) } });
          c.upd.maxDeviationM = ts.devMax;
          ts.dev = null;
        }
      }

      // ── Unscheduled stop ──
      const inAnyStop = trip.stops.some((s) => distM(fix, s) <= s.radiusM);
      if (fix.speedKph < TRACKER.stillKph && !inAnyStop) {
        if (!ts.still) {
          ts.still = { t: fix.t, lat: fix.lat, lng: fix.lng, id: null };
        } else if (!ts.still.id && fix.t - ts.still.t >= TRACKER.stillMs) {
          ts.still.id = opts.newId();
          eff.eventOpens.push({ id: ts.still.id, tripId: trip.id, kind: 'UNSCHEDULED_STOP', startAt: ts.still.t, lat: ts.still.lat, lng: ts.still.lng });
        }
      } else if (ts.still) {
        if (ts.still.id) eff.eventCloses.push({ id: ts.still.id, endAt: fix.t, data: { durationSec: round((fix.t - ts.still.t) / 1000) } });
        ts.still = null;
      }
    }
  }

  // Recent speed samples (ETA).
  ts.spd = [...ts.spd.filter(([t]) => fix.t - t < TRACKER.speedWindowMs), [fix.t, fix.speedKph] as [number, number]].slice(-60);

  // ── ETA / delay (throttled; forced when the next stop or the status changed) ──
  if (!finished && (ts.status === 'STARTED' || ts.status === 'IN_PROGRESS')) {
    const ni = nextPending(ts);
    const nextSeq = ni >= 0 ? trip.stops[ni].seq : null;
    const due = !ts.eta || ts.eta.seq !== nextSeq || fix.t - ts.eta.t >= TRACKER.etaEveryMs || c.upd.status !== undefined;
    if (due) {
      let at: number | null = null;
      let delay: number | null = null;
      if (ni >= 0) {
        const stop = trip.stops[ni];
        const straight = distM(fix, stop);
        const rest = trip.stopAlong[ni] - alongAt(trip.line, trip.cum, match.idx, fix.lat, fix.lng);
        const remaining = Math.max(straight, rest > 0 ? rest : 0);
        const avg = ts.spd.reduce((sum, [, v]) => sum + v, 0) / ts.spd.length;
        let travelSec = remaining / (Math.max(avg, TRACKER.minEtaKph) / 3.6);
        const r = opts.routeEta;
        if (r && r.tripId === trip.id && r.seq === nextSeq && Number.isFinite(r.sec) && r.sec >= 0) travelSec = Math.min(travelSec, r.sec);
        // Waiting at a stop: leaves at its planned departure at the earliest.
        const leaveAt = ts.at !== null ? Math.max(fix.t, trip.stops[ts.at].plannedDeparture) : fix.t;
        at = round(leaveAt + travelSec * 1000);
        delay = round((at - stop.plannedArrival) / 1000);
      }
      ts.eta = { t: fix.t, seq: nextSeq, at, delay };
      Object.assign(c.upd, { nextStopSeq: nextSeq, etaNextStop: at, delaySec: delay, deviationCount: ts.devN, maxDeviationM: ts.devMax });
      if (ts.status === 'IN_PROGRESS') c.upd.distanceKm = km1(ts.km);
    }
  }

  ts.last = { t: fix.t, lat: fix.lat, lng: fix.lng };
  if (Object.keys(c.upd).length) eff.trips.push({ id: trip.id, data: c.upd });
  if (c.stopsChanged || liveSignature(ts) !== sig) eff.live.push(liveUpdate(trip, ts, c.stopsChanged));
  return finished;
}

/** Closed because a newer trip of the vehicle started: INCOMPLETE (TIMEOUT), PENDING stops skipped (no alerts, like the sweeper). */
function closeIncomplete(trip: PreparedTrip, ts: TripState, fix: TrackerFix, eff: TrackEffects): void {
  const c: Ctx = { trip, ts, fix, eff, upd: {}, stopsChanged: false };
  closeEvents(c);
  ts.stops.forEach((s, i) => {
    if (s.s === 'PENDING') setStop(c, i, { s: 'SKIPPED' });
  });
  setStatus(c, 'INCOMPLETE');
  ts.eta = { t: fix.t, seq: null, at: null, delay: ts.eta?.delay ?? null };
  Object.assign(c.upd, { closedBy: 'TIMEOUT' as const, nextStopSeq: null, etaNextStop: null, distanceKm: km1(ts.km), deviationCount: ts.devN, maxDeviationM: ts.devMax });
  eff.trips.push({ id: trip.id, data: c.upd });
  eff.live.push(liveUpdate(trip, ts, true));
}

function liveSignature(ts: TripState): string {
  return JSON.stringify([ts.status, ts.eta?.seq ?? null, ts.eta?.at ?? null, ts.eta?.delay ?? null, ts.start]);
}

const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

export function liveUpdate(trip: PreparedTrip, ts: TripState, withStops: boolean): PlannedTripLiveUpdate {
  const terminal = ts.status === 'COMPLETED' || ts.status === 'INCOMPLETE';
  const lastStop = ts.stops[ts.stops.length - 1];
  return {
    id: trip.id,
    status: ts.status,
    nextStopSeq: terminal ? null : (ts.eta?.seq ?? null),
    etaNextStop: terminal ? null : iso(ts.eta?.at),
    delaySec: ts.eta?.delay ?? null,
    actualStart: iso(ts.start),
    actualEnd: ts.status === 'COMPLETED' ? iso(lastStop?.a) : null,
    deviationCount: ts.devN,
    maxDeviationM: ts.devMax,
    ...(withStops
      ? { stops: trip.stops.map((s, i) => ({ seq: s.seq, status: ts.stops[i].s, actualArrival: iso(ts.stops[i].a), actualDeparture: iso(ts.stops[i].d), delaySec: ts.stops[i].dl })) }
      : {}),
  };
}
