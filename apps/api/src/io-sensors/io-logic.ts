import { evaluateIoReading, IO_SENSOR_KINDS, IoSensorKind, IoSensorSource } from '@veetracer/shared';
import { haversineMeters } from '../tracking/geo';

/** A configured, enabled AC / door sensor as the processor uses it. */
export interface IoSensorRuntime {
  kind: IoSensorKind;
  source: IoSensorSource;
  attribute: string;
  invert: boolean;
  minV: number | null;
  maxV: number | null;
  hysteresisV: number;
  debounceSec: number;
}

/** No data for this long closes the open session at the last point (device offline / switched off). */
export const IO_GAP_MS = 30 * 60_000;
/** An open session row is refreshed (duration, distance so far) at most this often. */
export const IO_OPEN_WRITE_MS = 5 * 60_000;

export interface IoOpenSession {
  id: string;
  on: boolean;
  start: number;
  lat: number | null;
  lng: number | null;
  km: number;
  /** ms of this period with the ignition off. */
  eoff: number;
  /** Last time the row was written (ms). */
  w: number;
}

/** Per kind detector state, persisted in `vt:io:<objectId>`. */
export interface IoKindState {
  /** Stable (debounced) state; null = unknown (no reading yet, or restarted after a gap). */
  s: boolean | null;
  /** Pending new state and since when / where. */
  p: boolean | null;
  ps: number;
  pLat: number | null;
  pLng: number | null;
  /** Last point time and last valid location. */
  t: number;
  lat: number | null;
  lng: number | null;
  sess: IoOpenSession | null;
}
export type IoState = Partial<Record<IoSensorKind, IoKindState>>;

export interface IoPoint {
  t: number;
  /** Sensor reading on this point (null = the point carries no reading). */
  raw: boolean | null;
  lat: number | null;
  lng: number | null;
  /** Location usable for distance (trusted fix). */
  valid: boolean;
  ignition: boolean | null;
}

/** Session row to upsert (endTime null = still open). */
export interface IoSessionWrite {
  id: string;
  kind: IoSensorKind;
  on: boolean;
  startTime: number;
  endTime: number | null;
  startLat: number | null;
  startLng: number | null;
  endLat: number | null;
  endLng: number | null;
  distanceKm: number;
  durationSec: number;
  engineOffSec: number;
}

export interface IoTransition {
  kind: IoSensorKind;
  on: boolean;
  at: number;
  /** How long the previous state lasted (seconds), null when unknown. */
  previousSec: number | null;
}

export interface IoStepResult {
  rows: IoSessionWrite[];
  transition: IoTransition | null;
}


/** Parse stored config rows; disabled rows and unknown kinds / sources are dropped. */
export function parseIoSensors(
  rows: { kind: string; enabled: boolean; source: string; attribute: string; invert: boolean; minV: number | null; maxV: number | null; hysteresisV: number; debounceSec: number }[],
): IoSensorRuntime[] {
  return rows
    .filter((r) => r.enabled && (IO_SENSOR_KINDS as readonly string[]).includes(r.kind) && (r.source === 'DIGITAL' || r.source === 'ANALOG'))
    .map((r) => ({
      kind: r.kind as IoSensorKind,
      source: r.source as IoSensorSource,
      attribute: r.attribute,
      invert: r.invert,
      minV: r.minV,
      maxV: r.maxV,
      hysteresisV: Math.max(0, r.hysteresisV),
      debounceSec: Math.max(0, r.debounceSec),
    }));
}

/**
 * Sensor reading on a point. DIGITAL: boolean (or 0/1) attribute, flipped by `invert`. ANALOG: ON while
 * minV ≤ value ≤ maxV; once ON (`prev` true) it stays ON until the value leaves [minV − h, maxV + h].
 * An analog sensor without bounds only reports its voltage (not calibrated yet).
 */
export function ioReading(attrs: Record<string, unknown>, cfg: IoSensorRuntime, prev: boolean | null): { on: boolean | null; voltage: number | null } {
  return evaluateIoReading(attrs[cfg.attribute], cfg, prev);
}

export const emptyIoKindState = (): IoKindState => ({ s: null, p: null, ps: 0, pLat: null, pLng: null, t: 0, lat: null, lng: null, sess: null });

function snapshot(kind: IoSensorKind, s: IoOpenSession, at: number, end: { lat: number | null; lng: number | null } | null): IoSessionWrite {
  return {
    id: s.id,
    kind,
    on: s.on,
    startTime: s.start,
    endTime: end ? at : null,
    startLat: s.lat,
    startLng: s.lng,
    endLat: end?.lat ?? null,
    endLng: end?.lng ?? null,
    distanceKm: Math.round(s.km * 1000) / 1000,
    durationSec: Math.max(0, Math.round((at - s.start) / 1000)),
    engineOffSec: Math.max(0, Math.round(s.eoff / 1000)),
  };
}

/**
 * One point through the AC / door detector of one kind (mutates `st`). A new state must hold `debounceSec` before it
 * counts; the change is dated when it started. Each state period is an IoSession row: opened on the first reading,
 * closed on a change, or at the last point when data stops for IO_GAP_MS (the next reading starts afresh).
 * Points older than the state are ignored.
 */
export function stepIo(st: IoKindState, pt: IoPoint, cfg: IoSensorRuntime, newId: () => string): IoStepResult {
  const rows: IoSessionWrite[] = [];
  if (st.t && pt.t < st.t) return { rows, transition: null };
  const kind = cfg.kind;
  if (st.sess && st.t && pt.t - st.t > IO_GAP_MS) {
    rows.push(snapshot(kind, st.sess, st.t, { lat: st.lat, lng: st.lng }));
    st.sess = null;
    st.s = null;
    st.p = null;
  }
  if (st.sess && st.t) {
    if (pt.valid && pt.lat !== null && pt.lng !== null && st.lat !== null && st.lng !== null) st.sess.km += haversineMeters(st.lat, st.lng, pt.lat, pt.lng) / 1000;
    if (st.sess.on && pt.ignition === false) st.sess.eoff += pt.t - st.t;
  }
  if (pt.valid && pt.lat !== null && pt.lng !== null) {
    st.lat = pt.lat;
    st.lng = pt.lng;
  }
  st.t = pt.t;
  const open = (on: boolean, at: number, lat: number | null, lng: number | null): IoOpenSession => ({ id: newId(), on, start: at, lat, lng, km: 0, eoff: 0, w: at });

  let transition: IoTransition | null = null;
  if (pt.raw !== null) {
    if (st.s === null) {
      st.s = pt.raw;
      st.p = null;
      st.sess = open(pt.raw, pt.t, st.lat, st.lng);
      rows.push(snapshot(kind, st.sess, pt.t, null));
    } else if (pt.raw === st.s) {
      st.p = null;
    } else {
      if (st.p !== pt.raw) {
        st.p = pt.raw;
        st.ps = pt.t;
        st.pLat = st.lat;
        st.pLng = st.lng;
      }
      if (pt.t - st.ps >= cfg.debounceSec * 1000) {
        const at = st.ps;
        const prev = st.sess;
        if (prev) rows.push(snapshot(kind, prev, Math.max(at, prev.start), { lat: st.pLat, lng: st.pLng }));
        transition = { kind, on: pt.raw, at, previousSec: prev ? Math.max(0, Math.round((at - prev.start) / 1000)) : null };
        st.s = pt.raw;
        st.p = null;
        st.sess = open(pt.raw, at, st.pLat, st.pLng);
        rows.push(snapshot(kind, st.sess, pt.t, null));
      }
    }
  }
  // Keep the open row's duration / distance roughly current for reports, without a write per point.
  if (st.sess && !rows.some((r) => r.id === st.sess!.id) && pt.t - st.sess.w >= IO_OPEN_WRITE_MS) {
    st.sess.w = pt.t;
    rows.push(snapshot(kind, st.sess, pt.t, null));
  }
  return { rows, transition };
}

export function parseIoState(json: string | null): IoState {
  if (!json) return {};
  try {
    const s = JSON.parse(json) as IoState;
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}
