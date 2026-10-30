/**
 * DMS dashboard: counts of driver-monitoring (cabin camera) and harsh-driving alerts per vehicle and per day.
 * Each column is one or more alert types; yawning and eyes closing share one column because the dashcam
 * protocol (JT/T 1078 Su standard) reports both as a single "fatigue" alarm.
 */
import type { AlertTypeCode } from './alerts';

export const DMS_COLUMNS = [
  { key: 'fatigue', label: 'Yawning / Eyes closing', types: ['DRIVER_FATIGUE'], color: '#e11d48' },
  { key: 'smoking', label: 'Smoking', types: ['DRIVER_SMOKING'], color: '#f59e0b' },
  { key: 'phone', label: 'Phone calling', types: ['DRIVER_PHONE'], color: '#8b5cf6' },
  { key: 'noFace', label: 'No face detected', types: ['DRIVER_ABSENT'], color: '#0ea5e9' },
  { key: 'distraction', label: 'Distraction', types: ['DRIVER_DISTRACTED'], color: '#14b8a6' },
  { key: 'cornering', label: 'Harsh cornering', types: ['HARSH_CORNERING'], color: '#f97316' },
  { key: 'acceleration', label: 'Harsh acceleration', types: ['HARSH_ACCELERATION'], color: '#6366f1' },
  { key: 'braking', label: 'Harsh braking', types: ['HARSH_BRAKING'], color: '#84cc16' },
] as const satisfies readonly { key: string; label: string; types: readonly AlertTypeCode[]; color: string }[];

export type DmsColumnKey = (typeof DMS_COLUMNS)[number]['key'];
export type DmsCounts = Record<DmsColumnKey, number>;

export const DMS_PERIODS = ['today', 'week', 'month', 'custom'] as const;
export type DmsPeriod = (typeof DMS_PERIODS)[number];
/** Longest custom range, days. */
export const DMS_MAX_DAYS = 92;

/** Alert type → column key. */
export const DMS_COLUMN_OF: Readonly<Record<string, DmsColumnKey>> = Object.fromEntries(DMS_COLUMNS.flatMap((c) => c.types.map((t) => [t, c.key])));

export const emptyDmsCounts = (): DmsCounts => Object.fromEntries(DMS_COLUMNS.map((c) => [c.key, 0])) as DmsCounts;

export interface DmsVehicleRow {
  objectId: string;
  name: string;
  plateNumber: string | null;
  counts: DmsCounts;
  total: number;
}

export interface DmsSummaryDto {
  /** Range used (ISO), the end capped at now. */
  from: string;
  to: string;
  /** Vehicles with at least one event, most events first. */
  rows: DmsVehicleRow[];
  totals: DmsCounts;
  /** Every day of the range (company time zone), for the trend chart. */
  daily: { day: string; counts: DmsCounts }[];
  /** Vehicles looked at (the selected one, or all in scope). */
  vehicles: number;
}

/** Sum of a counts record. */
export const dmsTotal = (c: DmsCounts): number => DMS_COLUMNS.reduce((s, col) => s + c[col.key], 0);
