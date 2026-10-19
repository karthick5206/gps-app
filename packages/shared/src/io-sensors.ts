/**
 * AC / door sensors: per-device input configuration (Devices → Advanced settings; the wiring is on the tracker), the sessions the processor records and the "AC / Door" reports.
 * A sensor reads one position attribute: a DIGITAL input (door, in1, in2 …; `invert` flips it) or an ANALOG voltage
 * (adc1, adc2 …) that means ON while minV ≤ value ≤ maxV (e.g. the Concox GT800 purple wire on the AC blower).
 */

export const IO_SENSOR_KINDS = ['AC', 'DOOR'] as const;
export type IoSensorKind = (typeof IO_SENSOR_KINDS)[number];

export const IO_SENSOR_SOURCES = ['DIGITAL', 'ANALOG'] as const;
export type IoSensorSource = (typeof IO_SENSOR_SOURCES)[number];

/** Attribute keys offered first in the settings dialog (any attribute key seen on the vehicle can be used). */
export const IO_DIGITAL_KEYS = ['in1', 'in2', 'in3', 'in4', 'door'] as const;
export const IO_ANALOG_KEYS = ['adc1', 'adc2'] as const;

/** Attribute keys must look like decoder keys (letters, digits, underscore). */
export const IO_ATTRIBUTE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

export interface IoSensorConfigDto {
  deviceId: string;
  kind: IoSensorKind;
  /** False = no sensor of this kind (never configured, or switched off). */
  enabled: boolean;
  source: IoSensorSource;
  attribute: string;
  /** DIGITAL: ON when the input is false (e.g. a door switch that opens the circuit). */
  invert: boolean;
  /** ANALOG: ON while minV ≤ value ≤ maxV (either bound may be empty = unbounded; at least one is needed). */
  minV: number | null;
  maxV: number | null;
  /** ANALOG: once ON, stays ON until the value leaves [minV − h, maxV + h] (avoids flicker at the threshold). */
  hysteresisV: number;
  /** A new state must hold this long before it counts (seconds). */
  debounceSec: number;
  updatedAt: string | null;
}

export type IoSensorConfigInput = Omit<IoSensorConfigDto, 'deviceId' | 'kind' | 'updatedAt'>;

/** Defaults: GT800 purple wire on the AC blower = analog adc1 (min / max set by the installer); door = digital `door`. */
export const IO_SENSOR_DEFAULTS: Record<IoSensorKind, IoSensorConfigInput> = {
  AC: { enabled: false, source: 'ANALOG', attribute: 'adc1', invert: false, minV: null, maxV: null, hysteresisV: 0.2, debounceSec: 10 },
  DOOR: { enabled: false, source: 'DIGITAL', attribute: 'door', invert: false, minV: null, maxV: null, hysteresisV: 0.2, debounceSec: 10 },
};

export interface IoSensorsDto {
  deviceId: string;
  /** Vehicle the device is fitted to now (null = unassigned). */
  objectId: string | null;
  sensors: IoSensorConfigDto[];
}

/** GET /devices/:id/recent-attributes: attribute keys seen on the device's recent positions with their last values. */
export interface RecentAttributeDto {
  key: string;
  value: string | number | boolean;
  /** Fix time of the newest position carrying the key. */
  at: string;
  /** How many of the scanned positions carried it. */
  count: number;
}

export interface RecentAttributesDto {
  deviceId: string;
  scanned: number;
  attributes: RecentAttributeDto[];
}

/** AC_DOOR report: one row per AC / door period (ON or OFF, open or closed). */
export interface IoSessionReportRow {
  id: string;
  objectId: string; objectName: string; plateNumber: string | null;
  kind: IoSensorKind;
  /** AC on / door open. */
  on: boolean;
  startTime: string;
  /** Null = still in this state. */
  endTime: string | null;
  durationSec: number;
  distanceKm: number;
  engineOffSec: number;
  startLat: number | null; startLng: number | null; endLat: number | null; endLng: number | null;
  startAddress: string | null; endAddress: string | null;
}

/** AC_DOOR_DAILY report: per vehicle per day totals. */
export interface IoDailyReportRow {
  objectId: string; objectName: string; plateNumber: string | null; day: string;
  acOnSec: number; acOnEngineOffSec: number; acOnCount: number; acDistanceKm: number;
  doorOpenCount: number; doorOpenSec: number;
}

/**
 * What one attribute value means for a sensor (same rule in the processor and the settings UI). DIGITAL: boolean or
 * 0/1, flipped by `invert`. ANALOG: ON while minV ≤ value ≤ maxV; once ON (`prev` true) it stays ON until the value
 * leaves [minV − h, maxV + h]. An analog sensor without bounds only reports its voltage (on = null: not calibrated).
 */
export function evaluateIoReading(
  value: unknown,
  cfg: Pick<IoSensorConfigInput, 'source' | 'invert' | 'minV' | 'maxV' | 'hysteresisV'>,
  prev: boolean | null = null,
): { on: boolean | null; voltage: number | null } {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : null;
  if (cfg.source === 'DIGITAL') {
    const b = typeof value === 'boolean' ? value : n !== null ? n !== 0 : null;
    return { on: b === null ? null : b !== cfg.invert, voltage: null };
  }
  if (n === null) return { on: null, voltage: null };
  if (cfg.minV === null && cfg.maxV === null) return { on: null, voltage: n };
  const h = prev === true ? Math.max(0, cfg.hysteresisV) : 0;
  const lo = cfg.minV === null ? Number.NEGATIVE_INFINITY : cfg.minV - h;
  const hi = cfg.maxV === null ? Number.POSITIVE_INFINITY : cfg.maxV + h;
  return { on: n >= lo && n <= hi, voltage: n };
}
