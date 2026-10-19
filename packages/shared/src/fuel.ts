/** Fuel monitoring: per-vehicle sensor configuration, refill / drain events and the fuel reports. */

export const FUEL_SOURCES = ['none', 'can_level_pct', 'can_level_l', 'lls', 'analog'] as const;
export type FuelSource = (typeof FUEL_SOURCES)[number];

export const FUEL_SOURCE_LABELS: Record<FuelSource, string> = {
  none: 'No fuel sensor',
  can_level_pct: 'CAN bus fuel level (%)',
  can_level_l: 'CAN bus fuel level (litres)',
  lls: 'LLS fuel level sensor',
  analog: 'Analog fuel sensor (AIN1)',
};

/** Unit of the calibration table's raw column per source. */
export const FUEL_RAW_UNIT: Partial<Record<FuelSource, string>> = { lls: 'sensor value', analog: 'mV' };

export interface FuelConfigDto {
  objectId: string;
  source: FuelSource;
  tankCapacityL: number | null;
  /** [raw, litres] points, ascending by raw. */
  calibration: [number, number][];
  /** null = default max(10 L, 5 % of the tank). */
  refillMinL: number | null;
  drainMinL: number;
  drainWindowMin: number;
  smoothingWindow: number;
  updatedAt: string | null;
}

export type FuelConfigInput = Omit<FuelConfigDto, 'objectId' | 'updatedAt'>;

export const FUEL_CONFIG_DEFAULTS: FuelConfigInput = {
  source: 'none',
  tankCapacityL: null,
  calibration: [],
  refillMinL: null,
  drainMinL: 8,
  drainWindowMin: 10,
  smoothingWindow: 5,
};

export type FuelEventType = 'REFILL' | 'DRAIN';

export interface FuelEventDto {
  id: string;
  objectId: string;
  objectName: string;
  plateNumber: string | null;
  type: FuelEventType;
  startTime: string;
  endTime: string;
  litresBefore: number;
  litresAfter: number;
  deltaL: number;
  lat: number | null;
  lng: number | null;
  /** Reverse-geocoded address of the event (reports only). */
  address?: string | null;
}

/** FUEL report: one row per vehicle per day. */
export interface FuelReportRow {
  objectId: string; objectName: string; plateNumber: string | null; day: string;
  startL: number | null; endL: number | null;
  refills: number; refillL: number; drains: number; drainL: number;
  consumptionL: number | null; distanceKm: number; kmPerL: number | null; lPer100Km: number | null;
}

/** Fuel level over time for history playback: [epochMs, litres]. */
export type FuelPoint = [number, number];
