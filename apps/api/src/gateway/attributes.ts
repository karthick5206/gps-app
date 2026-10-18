/**
 * Normalised position attribute keys shared by every protocol decoder, so alerts and UI work across brands.
 * Vendor-specific extras are kept alongside under their own (documented) names.
 */

export const NORMALIZED_ALARMS = [
  'sos',
  'powerCut',
  'lowBattery',
  'vibration',
  'overspeed',
  'tamper',
  'harshAcceleration',
  'harshBraking',
  'harshCornering',
  'crash',
  'towing',
  'jamming',
  'geofenceEnter',
  'geofenceExit',
] as const;
export type NormalizedAlarm = (typeof NORMALIZED_ALARMS)[number];

/** Keys used by decoders (documentation + typo guard in tests). */
export const ATTR = {
  batteryLevel: 'batteryLevel', // %
  batteryVoltage: 'batteryVoltage', // V (internal backup battery)
  extVoltage: 'extVoltage', // V (vehicle supply)
  gsmSignal: 'gsmSignal', // 0..5
  charging: 'charging',
  alarm: 'alarm',
  odometerM: 'odometerM',
  hdop: 'hdop',
  pdop: 'pdop',
  driverId: 'driverId',
  iccid: 'iccid',
  mcc: 'mcc',
  mnc: 'mnc',
  lac: 'lac',
  cellId: 'cellId',
  commandResponse: 'commandResponse',
  event: 'event',
  motion: 'motion',
} as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** GSM signal on the normalised 0..5 scale from a 0..4 level (GT06). */
export function gsmFromLevel4(level: number): number {
  return Math.round((clamp(level, 0, 4) * 5) / 4);
}

/** GSM signal on the normalised 0..5 scale from a modem CSQ value (0..31, 99 = unknown). */
export function gsmFromCsq(csq: number): number | null {
  if (!Number.isFinite(csq) || csq < 0 || csq === 99 || csq > 31) return null;
  if (csq === 0) return 0;
  return clamp(Math.round((csq * 5) / 31), 1, 5);
}

/** Drop null/undefined/NaN values so stored attribute JSON stays small. */
export function compact(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    out[k] = v;
  }
  return out;
}

export const round = (value: number, digits = 2): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};
