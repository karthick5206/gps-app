/**
 * Pure calculations behind the derived reports (over-speed episodes, ignition changes, continuous driving, device
 * status). Kept free of Prisma so they can be unit-tested with plain arrays.
 */

export interface SpeedPoint {
  t: number; // fix time (ms)
  speedKph: number;
  lat: number;
  lng: number;
}

export interface OverspeedEpisode {
  start: number;
  end: number;
  maxSpeedKph: number;
  avgSpeedKph: number;
  points: number;
  lat: number;
  lng: number;
}

/**
 * Over-speed episodes from the points that exceeded the limit (time-ordered). A gap longer than `maxGapMs` between
 * two such points (i.e. the vehicle dropped below the limit or stopped reporting) ends the episode. Episodes shorter
 * than `minDurationSec` are dropped; a single point counts as a zero-length episode only when `minDurationSec` is 0.
 */
export function overspeedEpisodes(points: SpeedPoint[], opts: { maxGapMs?: number; minDurationSec?: number } = {}): OverspeedEpisode[] {
  const maxGap = opts.maxGapMs ?? 120_000;
  const minDuration = (opts.minDurationSec ?? 10) * 1000;
  const out: OverspeedEpisode[] = [];
  let cur: (OverspeedEpisode & { sum: number }) | null = null;
  const flush = () => {
    if (cur && cur.end - cur.start >= minDuration) {
      const { sum, ...ep } = cur;
      out.push({ ...ep, avgSpeedKph: Math.round((sum / ep.points) * 10) / 10 });
    }
    cur = null;
  };
  for (const p of points) {
    if (cur && p.t - cur.end > maxGap) flush();
    if (!cur) cur = { start: p.t, end: p.t, maxSpeedKph: p.speedKph, avgSpeedKph: 0, points: 0, sum: 0, lat: p.lat, lng: p.lng };
    cur.end = p.t;
    cur.points++;
    cur.sum += p.speedKph;
    if (p.speedKph > cur.maxSpeedKph) {
      cur.maxSpeedKph = p.speedKph;
      cur.lat = p.lat; // location of the peak speed
      cur.lng = p.lng;
    }
  }
  flush();
  return out;
}

export interface IgnitionPoint {
  t: number;
  ignition: boolean;
  lat: number;
  lng: number;
}

export interface IgnitionChange {
  t: number;
  state: 'ON' | 'OFF';
  previousStateSec: number | null;
  lat: number;
  lng: number;
}

/**
 * Ignition state changes from time-ordered points with a known ignition value. `before` is the state just before the
 * range (if known) so a change at the first point is reported, and its duration is unknown (null).
 */
export function ignitionChanges(points: IgnitionPoint[], before: boolean | null = null): IgnitionChange[] {
  const out: IgnitionChange[] = [];
  let state = before;
  let since: number | null = null;
  for (const p of points) {
    if (state === null) {
      state = p.ignition;
      since = p.t;
      continue;
    }
    if (p.ignition !== state) {
      out.push({ t: p.t, state: p.ignition ? 'ON' : 'OFF', previousStateSec: since === null ? null : Math.round((p.t - since) / 1000), lat: p.lat, lng: p.lng });
      state = p.ignition;
      since = p.t;
    }
  }
  return out;
}

export interface TripSpan {
  start: number;
  end: number;
  durationSec: number;
  distanceKm: number;
  startAddress: string | null;
  endAddress: string | null;
}

export interface DrivingStretch {
  start: number;
  end: number;
  drivingSec: number;
  spanSec: number;
  distanceKm: number;
  trips: number;
  longestBreakSec: number;
  startAddress: string | null;
  endAddress: string | null;
}

/**
 * Continuous driving (fatigue) stretches: consecutive trips whose breaks are all shorter than `breakMin` form one
 * stretch; stretches with at least `drivingMin` of driving are returned. This mirrors the usual "4 h driving / 15 min
 * break" rule used by fleet operators.
 */
export function continuousDriving(trips: TripSpan[], opts: { drivingMin?: number; breakMin?: number } = {}): DrivingStretch[] {
  const drivingMs = (opts.drivingMin ?? 240) * 60_000;
  const breakMs = (opts.breakMin ?? 15) * 60_000;
  const out: DrivingStretch[] = [];
  let cur: DrivingStretch | null = null;
  const flush = () => {
    if (cur && cur.drivingSec * 1000 >= drivingMs) out.push(cur);
    cur = null;
  };
  for (const t of [...trips].sort((a, b) => a.start - b.start)) {
    if (cur && t.start - cur.end >= breakMs) flush();
    if (!cur) {
      cur = { start: t.start, end: t.end, drivingSec: 0, spanSec: 0, distanceKm: 0, trips: 0, longestBreakSec: 0, startAddress: t.startAddress, endAddress: t.endAddress };
    } else {
      cur.longestBreakSec = Math.max(cur.longestBreakSec, Math.max(0, Math.round((t.start - cur.end) / 1000)));
    }
    cur.end = Math.max(cur.end, t.end);
    cur.drivingSec += t.durationSec;
    cur.distanceKm = Math.round((cur.distanceKm + t.distanceKm) * 1000) / 1000;
    cur.trips++;
    cur.spanSec = Math.round((cur.end - cur.start) / 1000);
    cur.endAddress = t.endAddress;
  }
  flush();
  return out;
}

export type DeviceStatus = 'ACTIVE' | 'INACTIVE' | 'NO_GPS' | 'NEVER_CONNECTED' | 'NO_DEVICE';

/**
 * Device health as fleet dashboards show it ("criticality"): no device fitted, never connected, inactive (no data for
 * longer than `inactiveAfterSec`), connected but without a valid GPS fix for longer than `noGpsAfterSec`, else active.
 */
export function deviceStatus(
  input: { hasDevice: boolean; lastSeenAt: number | null; lastFixAt: number | null },
  now: number,
  opts: { inactiveAfterSec: number; noGpsAfterSec?: number },
): DeviceStatus {
  if (!input.hasDevice) return 'NO_DEVICE';
  if (input.lastSeenAt === null) return 'NEVER_CONNECTED';
  if (now - input.lastSeenAt > opts.inactiveAfterSec * 1000) return 'INACTIVE';
  const noGps = (opts.noGpsAfterSec ?? 3600) * 1000;
  if (input.lastFixAt === null || now - input.lastFixAt > noGps) return 'NO_GPS';
  return 'ACTIVE';
}
