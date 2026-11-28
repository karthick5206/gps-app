/**
 * Battery health (from the tracker's vehicle-supply voltage, `extVoltage`) and idle cost (fuel burnt with the engine on
 * and the vehicle standing). Pure; used by the API reports and shown in the web and VeeTrax apps.
 *
 * Battery: trackers send a point every 10–30 s, too slowly to catch the dip while the starter turns, so the verdict uses
 * two steadier readings: the **resting** voltage (engine off, at night when the battery has settled) and the
 * **charging** voltage (engine on and driving, i.e. the alternator's output).
 */
import type { VehicleType } from './tracking';

export const BATTERY_STATUSES = ['GOOD', 'WEAK', 'REPLACE', 'NOT_CHARGING', 'OVERCHARGING', 'NO_DATA'] as const;
export type BatteryStatus = (typeof BATTERY_STATUSES)[number];

export const BATTERY_STATUS_META: Record<BatteryStatus, { label: string; advice: string; tone: 'ok' | 'warn' | 'bad' | 'muted' }> = {
  GOOD: { label: 'Good', advice: 'Battery and charging look normal.', tone: 'ok' },
  WEAK: { label: 'Weak', advice: 'Battery is getting weak. Have it tested at the next service.', tone: 'warn' },
  REPLACE: { label: 'Replace soon', advice: 'Battery stays low overnight. It may fail to start the vehicle; test or replace it soon.', tone: 'bad' },
  NOT_CHARGING: { label: 'Not charging', advice: 'Voltage stays low while driving. Check the alternator, belt and battery terminals.', tone: 'bad' },
  OVERCHARGING: { label: 'Overcharging', advice: 'Voltage is too high while driving. Check the voltage regulator; it can damage the battery.', tone: 'bad' },
  NO_DATA: { label: 'No data', advice: 'This tracker has not sent the vehicle battery voltage in the period.', tone: 'muted' },
};

/** One day's readings (volts; null = no samples). */
export interface BatteryDay {
  day: string;
  /** Median engine-off voltage at night (01:00–05:00), else over the whole day. */
  restV: number | null;
  /** Median voltage while the engine is on and the vehicle is moving. */
  chargeV: number | null;
  /** Lowest engine-off reading of the day. */
  minRestV: number | null;
}

export interface BatteryVerdict {
  status: BatteryStatus;
  /** 12 or 24 V electrical system (null = unknown). */
  systemV: 12 | 24 | null;
  /** Latest resting voltage (median of the last 3 days with readings). */
  restV: number | null;
  /** Median charging voltage over the period. */
  chargeV: number | null;
  /** Lowest night resting voltage in the period. */
  lowestRestV: number | null;
  /** Change of the resting voltage from the first 3 to the last 3 days with readings (negative = falling). */
  trendV: number | null;
  /** Days with resting readings. */
  days: number;
}

/** Thresholds for a 12 V system; 24 V systems use twice these. */
export const BATTERY_LIMITS_12V = {
  /** Resting at or above: good. */
  restGood: 12.4,
  /** Resting below: replace soon (between the two: weak). */
  restReplace: 12.1,
  /** Charging below: not charging. */
  chargeMin: 13.0,
  /** Charging above: overcharging. */
  chargeMax: 15.0,
  /** Resting falling by this much over the period: weak even when still above restGood. */
  fallingBy: 0.3,
};

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round2 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);

/** 12 or 24 V from the readings (trucks / buses run 24 V). Below 9 V on average = not a vehicle battery reading. */
export function batterySystem(days: BatteryDay[]): 12 | 24 | null {
  const all = days.flatMap((d) => [d.chargeV, d.restV]).filter((v): v is number => v !== null && v > 0);
  const m = median(all);
  if (m === null || m < 9) return null;
  return m > 19 ? 24 : 12;
}

export function batteryVerdict(days: BatteryDay[]): BatteryVerdict {
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const systemV = batterySystem(sorted);
  const rest = sorted.filter((d) => d.restV !== null).map((d) => d.restV!);
  const charge = sorted.filter((d) => d.chargeV !== null).map((d) => d.chargeV!);
  const empty: BatteryVerdict = { status: 'NO_DATA', systemV, restV: null, chargeV: null, lowestRestV: null, trendV: null, days: rest.length };
  if (systemV === null) return empty;
  const k = systemV / 12;
  const L = BATTERY_LIMITS_12V;
  const restV = median(rest.slice(-3));
  const chargeV = median(charge);
  const trendV = rest.length >= 6 ? (median(rest.slice(-3)) ?? 0) - (median(rest.slice(0, 3)) ?? 0) : null;
  const lowestRestV = rest.length ? Math.min(...rest) : null;
  let status: BatteryStatus;
  if (chargeV !== null && chargeV > L.chargeMax * k) status = 'OVERCHARGING';
  else if (chargeV !== null && chargeV < L.chargeMin * k) status = 'NOT_CHARGING';
  else if (restV === null) status = chargeV === null ? 'NO_DATA' : 'GOOD';
  else if (restV < L.restReplace * k) status = 'REPLACE';
  else if (restV < L.restGood * k || (trendV !== null && trendV <= -L.fallingBy * k)) status = 'WEAK';
  else status = 'GOOD';
  return { status, systemV, restV: round2(restV), chargeV: round2(chargeV), lowestRestV: round2(lowestRestV), trendV: round2(trendV), days: rest.length };
}

/** Typical fuel burnt idling (litres per hour) by vehicle type; a report option can override it for all vehicles. */
export const IDLE_LITRES_PER_HOUR: Record<VehicleType, number> = {
  CAR: 0.8,
  VAN: 1.0,
  AUTO: 0.4,
  BIKE: 0.2,
  TRUCK: 2.5,
  BUS: 2.5,
  SCHOOL_BUS: 2.5,
  OTHER: 1.0,
};
/** Fuel price used when the vehicle has no fuel bill with litres in the last `FUEL_PRICE_LOOKBACK_DAYS` (₹ per litre). */
export const DEFAULT_FUEL_PRICE_PER_L = 100;
export const FUEL_PRICE_LOOKBACK_DAYS = 120;

export function idleLitres(idleSec: number, litresPerHour: number): number {
  return Math.round((idleSec / 3600) * litresPerHour * 100) / 100;
}
export function idleRupees(litres: number, pricePerL: number): number {
  return Math.round(litres * pricePerL);
}

/** BATTERY_HEALTH: one row per vehicle. */
export interface BatteryHealthReportRow {
  objectId: string; objectName: string; plateNumber: string | null; branchName: string | null;
  status: BatteryStatus; systemV: 12 | 24 | null;
  restV: number | null; lowestRestV: number | null; chargeV: number | null; trendV: number | null; days: number;
  advice: string;
}

/** IDLE_COST: idle time turned into fuel and money, per vehicle per period. */
export interface IdleCostReportRow {
  objectId: string; objectName: string; plateNumber: string | null; branchName: string | null; period: string;
  idleSec: number; idlePct: number; litresPerHour: number; litres: number; pricePerL: number;
  /** FUEL_LOG = the vehicle's latest fuel bill; DEFAULT = the report's price. */
  priceSource: 'FUEL_LOG' | 'DEFAULT';
  rupees: number;
}

/** GET /dashboard/fleet-health: batteries (last 14 days) and idle cost this month for the dashboard (cached 30 min). */
export interface DashboardFleetHealth {
  generatedAt: string;
  /** Battery period and idle-cost month, as report links use them. */
  batteryFrom: string; batteryTo: string; monthFrom: string; monthTo: string;
  battery: {
    vehicles: number;
    /** REPLACE + NOT_CHARGING + OVERCHARGING. */
    action: number;
    weak: number;
    good: number;
    noData: number;
    /** Worst first: action, then weak (at most 8). */
    list: BatteryHealthReportRow[];
  };
  idle: {
    rupees: number;
    litres: number;
    idleSec: number;
    /** Most idle ₹ this month (at most 5). */
    top: { objectId: string; objectName: string; plateNumber: string | null; idleSec: number; litres: number; rupees: number }[];
  };
}
