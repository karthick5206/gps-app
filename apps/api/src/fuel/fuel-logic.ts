/**
 * Fuel monitoring logic (pure, unit-tested): sensor reading → calibrated litres, refill / drain detection with
 * smoothing, and daily consumption aggregation.
 */

import { FUEL_SOURCES, FuelSource } from '@veetracer/shared';

export { FUEL_SOURCES, FuelSource };

export interface FuelConfig {
  source: FuelSource;
  tankCapacityL: number | null;
  /** Calibration points [raw, litres] (LLS units or analog mV); piecewise linear between them. */
  calibration: [number, number][];
  /** Minimum rise counted as a refill (null = max(10 L, 5 % of the tank)). */
  refillMinL: number | null;
  /** Minimum drop counted as a drain / possible theft. */
  drainMinL: number;
  /** A drain is a drop of drainMinL within this window while stationary. */
  drainWindowMin: number;
  /** Median of the last N readings (spike / slosh filter). */
  smoothingWindow: number;
}

export const DEFAULT_FUEL_CONFIG: Omit<FuelConfig, 'source'> = {
  tankCapacityL: null,
  calibration: [],
  refillMinL: null,
  drainMinL: 8,
  drainWindowMin: 10,
  smoothingWindow: 5,
};

/** Below this speed the vehicle is stationary: only then are refills / drains detected (sloshing while moving). */
export const STATIONARY_KPH = 5;
/** An episode (refill / drain) ends when the level stopped rising / falling for this long. */
export const SETTLE_MS = 2 * 60_000;

export function refillThreshold(cfg: Pick<FuelConfig, 'refillMinL' | 'tankCapacityL'>): number {
  if (cfg.refillMinL !== null && cfg.refillMinL > 0) return cfg.refillMinL;
  return Math.max(10, cfg.tankCapacityL ? cfg.tankCapacityL * 0.05 : 0);
}

/** Piecewise-linear calibration; values outside the table clamp to its first / last litres. */
export function calibrate(raw: number, table: [number, number][]): number | null {
  if (!Number.isFinite(raw) || !table.length) return null;
  const t = [...table].filter(([r, l]) => Number.isFinite(r) && Number.isFinite(l)).sort((a, b) => a[0] - b[0]);
  if (!t.length) return null;
  if (raw <= t[0][0]) return t[0][1];
  const last = t[t.length - 1];
  if (raw >= last[0]) return last[1];
  for (let i = 1; i < t.length; i++) {
    const [r1, l1] = t[i];
    if (raw <= r1) {
      const [r0, l0] = t[i - 1];
      return r1 === r0 ? l1 : l0 + ((raw - r0) * (l1 - l0)) / (r1 - r0);
    }
  }
  return last[1];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Litres in the tank from the position attributes per the vehicle's fuel source, or null. */
export function fuelLitres(attrs: Record<string, unknown>, cfg: FuelConfig): number | null {
  let litres: number | null = null;
  switch (cfg.source) {
    case 'none':
      return null;
    case 'can_level_pct': {
      const pct = num(attrs.fuelLevelPct);
      litres = pct !== null && cfg.tankCapacityL ? (pct * cfg.tankCapacityL) / 100 : null;
      break;
    }
    case 'can_level_l':
      litres = num(attrs.fuelLevelL);
      break;
    case 'lls': {
      const raw = num(attrs.fuelSensorRaw);
      // Without a calibration table the sensor is assumed to report litres directly.
      litres = raw === null ? null : cfg.calibration.length >= 2 ? calibrate(raw, cfg.calibration) : raw;
      break;
    }
    case 'analog': {
      const v = num(attrs.adc1);
      litres = v === null || cfg.calibration.length < 2 ? null : calibrate(Math.round(v * 1000), cfg.calibration);
      break;
    }
  }
  if (litres === null || litres < 0) return null;
  if (cfg.tankCapacityL) litres = Math.min(litres, cfg.tankCapacityL * 1.05);
  return round1(litres);
}

export interface FuelReading {
  t: number;
  litres: number;
  speedKph: number;
  lat: number | null;
  lng: number | null;
}

export interface FuelEpisode {
  type: 'REFILL' | 'DRAIN';
  t0: number;
  before: number;
  extreme: number;
  tExt: number;
  lat: number | null;
  lng: number | null;
}

/** Persisted per vehicle between batches. */
export interface FuelState {
  /** Last raw readings (litres) for the median. */
  buf: number[];
  /** Smoothed stationary levels within the drain window. */
  hist: { t: number; l: number }[];
  ep?: FuelEpisode;
  /** Last smoothed level and time. */
  level?: number;
  t?: number;
}

export const emptyFuelState = (): FuelState => ({ buf: [], hist: [] });

export interface FuelEventOut {
  type: 'REFILL' | 'DRAIN';
  startTime: number;
  endTime: number;
  litresBefore: number;
  litresAfter: number;
  deltaL: number;
  lat: number | null;
  lng: number | null;
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function closeEpisode(ep: FuelEpisode, end: number): FuelEventOut {
  return {
    type: ep.type,
    startTime: ep.t0,
    endTime: end,
    litresBefore: round1(ep.before),
    litresAfter: round1(ep.extreme),
    deltaL: round1(Math.abs(ep.extreme - ep.before)),
    lat: ep.lat,
    lng: ep.lng,
  };
}

/**
 * One reading through the detector (mutates `state`). Readings are smoothed by a running median; refills and
 * drains are only looked for while stationary, as a rise of at least the refill threshold / a drop of at least
 * drainMinL within the drain window. An episode is reported once the level settled (no new high / low for
 * SETTLE_MS) or the vehicle moves off, with the level before and after.
 */
export function stepFuel(state: FuelState, r: FuelReading, cfg: FuelConfig): FuelEventOut | null {
  if (state.t !== undefined && r.t <= state.t) return null; // out of order / duplicate
  const n = Math.max(1, Math.min(cfg.smoothingWindow || 1, 15));
  state.buf.push(r.litres);
  if (state.buf.length > n) state.buf.splice(0, state.buf.length - n);
  const s = median(state.buf);
  state.level = round1(s);
  state.t = r.t;
  const refillMin = refillThreshold(cfg);
  const windowMs = Math.max(1, cfg.drainWindowMin) * 60_000;

  if (r.speedKph >= STATIONARY_KPH) {
    const ep = state.ep;
    delete state.ep;
    state.hist = [{ t: r.t, l: s }];
    return ep && Math.abs(ep.extreme - ep.before) >= (ep.type === 'REFILL' ? refillMin : cfg.drainMinL) ? closeEpisode(ep, ep.tExt) : null;
  }

  const ep = state.ep;
  if (ep) {
    if (ep.type === 'REFILL' ? s > ep.extreme : s < ep.extreme) {
      ep.extreme = s;
      ep.tExt = r.t;
      return null;
    }
    if (r.t - ep.tExt < SETTLE_MS) return null;
    delete state.ep;
    state.hist = [{ t: r.t, l: s }];
    return closeEpisode(ep, ep.tExt);
  }

  // Keep the drain window, but always at least the last level before a gap in the data (parked with the tracker asleep).
  state.hist.push({ t: r.t, l: s });
  while (state.hist.length > 2 && r.t - state.hist[0].t > windowMs) state.hist.shift();
  let lo = state.hist[0];
  let hi = state.hist[0];
  for (const h of state.hist) {
    if (h.l < lo.l) lo = h;
    if (h.l > hi.l) hi = h;
  }
  if (s - lo.l >= refillMin) {
    state.ep = { type: 'REFILL', t0: lo.t, before: lo.l, extreme: s, tExt: r.t, lat: r.lat, lng: r.lng };
  } else if (hi.l - s >= cfg.drainMinL) {
    state.ep = { type: 'DRAIN', t0: hi.t, before: hi.l, extreme: s, tExt: r.t, lat: r.lat, lng: r.lng };
  }
  return null;
}

// ───────────── daily aggregation ─────────────

export interface FuelDayInput {
  objectId: string;
  day: string;
  startL: number | null;
  endL: number | null;
  distanceKm: number;
}

export interface FuelDayEvent {
  objectId: string;
  day: string;
  type: 'REFILL' | 'DRAIN';
  deltaL: number;
}

export interface FuelDayRow {
  objectId: string;
  day: string;
  startL: number | null;
  endL: number | null;
  refills: number;
  refillL: number;
  drains: number;
  drainL: number;
  consumptionL: number | null;
  distanceKm: number;
  kmPerL: number | null;
  lPer100Km: number | null;
}

/** Consumption = start + refilled − drained − end (never negative); km/L and L/100 km when both are meaningful. */
export function aggregateFuelDays(days: FuelDayInput[], events: FuelDayEvent[]): FuelDayRow[] {
  const ev = new Map<string, FuelDayEvent[]>();
  for (const e of events) {
    const k = `${e.objectId}|${e.day}`;
    const list = ev.get(k);
    if (list) list.push(e);
    else ev.set(k, [e]);
  }
  return days.map((d) => {
    const list = ev.get(`${d.objectId}|${d.day}`) ?? [];
    const refills = list.filter((e) => e.type === 'REFILL');
    const drains = list.filter((e) => e.type === 'DRAIN');
    const refillL = round1(refills.reduce((s, e) => s + e.deltaL, 0));
    const drainL = round1(drains.reduce((s, e) => s + e.deltaL, 0));
    const consumptionL = d.startL !== null && d.endL !== null ? round1(Math.max(0, d.startL + refillL - drainL - d.endL)) : null;
    const useful = consumptionL !== null && consumptionL >= 0.5 && d.distanceKm >= 1;
    return {
      objectId: d.objectId,
      day: d.day,
      startL: d.startL,
      endL: d.endL,
      refills: refills.length,
      refillL,
      drains: drains.length,
      drainL,
      consumptionL,
      distanceKm: Math.round(d.distanceKm * 10) / 10,
      kmPerL: useful ? Math.round((d.distanceKm / consumptionL!) * 100) / 100 : null,
      lPer100Km: useful ? Math.round((consumptionL! / d.distanceKm) * 1000) / 10 : null,
    };
  });
}

/** Normalise a stored / submitted fuel configuration. */
export function parseFuelConfig(raw: Partial<FuelConfig> & { source?: string } | null | undefined): FuelConfig {
  const source = (FUEL_SOURCES as readonly string[]).includes(raw?.source ?? '') ? (raw!.source as FuelSource) : 'none';
  const cal = Array.isArray(raw?.calibration)
    ? raw!.calibration.filter((p): p is [number, number] => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map(([a, b]) => [Number(a), Number(b)] as [number, number])
    : [];
  return {
    source,
    tankCapacityL: num(raw?.tankCapacityL) ?? DEFAULT_FUEL_CONFIG.tankCapacityL,
    calibration: cal.sort((a, b) => a[0] - b[0]),
    refillMinL: num(raw?.refillMinL),
    drainMinL: num(raw?.drainMinL) ?? DEFAULT_FUEL_CONFIG.drainMinL,
    drainWindowMin: num(raw?.drainWindowMin) ?? DEFAULT_FUEL_CONFIG.drainWindowMin,
    smoothingWindow: num(raw?.smoothingWindow) ?? DEFAULT_FUEL_CONFIG.smoothingWindow,
  };
}
