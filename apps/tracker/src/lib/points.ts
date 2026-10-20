import * as Battery from 'expo-battery';
import type { LocationObject } from 'expo-location';
import type { Point } from './api';

/** Points less accurate than this are dropped on the phone; everything else is sent and judged by the server. */
export const MAX_LOCAL_ACCURACY_M = 500;

export interface BatteryInfo { bat: number | null; chg: boolean | null }

export async function readBattery(): Promise<BatteryInfo> {
  try {
    const [level, state] = await Promise.all([Battery.getBatteryLevelAsync(), Battery.getBatteryStateAsync()]);
    return {
      bat: level >= 0 ? Math.round(level * 100) : null,
      chg: state === Battery.BatteryState.UNKNOWN ? null : state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL,
    };
  } catch {
    return { bat: null, chg: null };
  }
}

const orNull = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? null : v);
const nonNegative = (v: number | null | undefined) => (v == null || Number.isNaN(v) || v < 0 ? null : v);

export function toPoint(loc: LocationObject, battery: BatteryInfo, sos = false): Point {
  const c = loc.coords;
  const p: Point = {
    t: Math.round(loc.timestamp),
    lat: c.latitude,
    lng: c.longitude,
    acc: orNull(c.accuracy),
    spd: nonNegative(c.speed),
    brg: nonNegative(c.heading),
    alt: orNull(c.altitude),
    bat: battery.bat,
    chg: battery.chg,
    mock: loc.mocked === true,
  };
  if (sos) p.sos = true;
  return p;
}

/** Usable for the queue: valid coordinates and accuracy within the local limit (unknown accuracy is kept). */
export function isUsable(p: Point): boolean {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || !Number.isFinite(p.t)) return false;
  if (Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) return false;
  return p.acc == null || p.acc <= MAX_LOCAL_ACCURACY_M;
}
