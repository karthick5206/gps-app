/**
 * Sample calculation inputs (contract screen, doc 19 §6) → POST /contracts/:id/preview body. People type km, hours and
 * minutes; the API takes metres, seconds and minor units. Pure module: unit-tested with node --test.
 */
import { hoursToSeconds, kmToMetres, parseMajorToMinor, type AvailabilityFrequency, type PeriodFacts, type PreviewTripFacts } from '@veetracer/shared';

export interface TripPreviewForm {
  serviceDate: string;
  km: string;
  actualHours: string;
  reservedHours: string;
  waitingMinutes: string;
  stops: string;
  passengers: string;
  startTime: string;
  tolls: string;
  cancelledMinutesBefore: string;
  onDedicatedVehicle: boolean;
  vehicleCategory: string;
}

export interface PeriodPreviewForm {
  frequency: AvailabilityFrequency;
  periodStart: string;
  periodEnd: string;
  attachedDays: string;
  downtimeDays: string;
  suspensionDays: string;
  holidayDaysWorked: string;
  usedKm: string;
  usedHours: string;
  overtimeHours: string;
  tripCount: string;
}

const intOrNull = (s: string): number | null => (/^\d{1,9}$/.test(s.trim()) ? Number(s.trim()) : null);
const intOr0 = (s: string): number => intOrNull(s) ?? 0;

/** Throws Error('INVALID: <field>') for a value that cannot be converted. */
export function tripFactsFromForm(f: TripPreviewForm, currency: string): PreviewTripFacts {
  const facts: PreviewTripFacts = { serviceDate: f.serviceDate, billableDistanceM: null, onDedicatedVehicle: f.onDedicatedVehicle };
  const guard = <T>(field: string, fn: () => T): T => {
    try {
      return fn();
    } catch {
      throw new Error(`INVALID: ${field}`);
    }
  };
  if (f.km.trim()) facts.billableDistanceM = guard('km', () => kmToMetres(f.km.trim()));
  if (f.actualHours.trim()) facts.actualDurationS = guard('actualHours', () => hoursToSeconds(f.actualHours.trim()));
  if (f.reservedHours.trim()) facts.reservedDurationS = guard('reservedHours', () => hoursToSeconds(f.reservedHours.trim()));
  if (f.waitingMinutes.trim()) facts.waitingS = guard('waitingMinutes', () => {
    const n = intOrNull(f.waitingMinutes);
    if (n === null) throw new Error();
    return n * 60;
  });
  for (const [k, v] of [
    ['stops', f.stops],
    ['passengers', f.passengers],
    ['cancelledMinutesBefore', f.cancelledMinutesBefore],
  ] as const) {
    if (!v.trim()) continue;
    const n = intOrNull(v);
    if (n === null) throw new Error(`INVALID: ${k}`);
    facts[k] = n;
  }
  if (f.startTime.trim()) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(f.startTime.trim());
    if (!m) throw new Error('INVALID: startTime');
    facts.startMinuteOfDay = Number(m[1]) * 60 + Number(m[2]);
  }
  if (f.tolls.trim()) {
    const minor = guard('tolls', () => parseMajorToMinor(f.tolls.trim(), currency));
    if (minor < 0n) throw new Error('INVALID: tolls');
    facts.tollsMinor = minor.toString();
  }
  if (f.vehicleCategory.trim()) facts.vehicleCategory = f.vehicleCategory.trim();
  return facts;
}

export function periodFactsFromForm(f: PeriodPreviewForm): PeriodFacts {
  const guard = <T>(field: string, fn: () => T): T => {
    try {
      return fn();
    } catch {
      throw new Error(`INVALID: ${field}`);
    }
  };
  return {
    frequency: f.frequency,
    periodStart: f.periodStart,
    periodEnd: f.periodEnd,
    attachedDays: intOr0(f.attachedDays),
    downtimeDays: intOr0(f.downtimeDays),
    suspensionDays: intOr0(f.suspensionDays),
    holidayDaysWorked: intOr0(f.holidayDaysWorked),
    usedDistanceM: f.usedKm.trim() ? guard('usedKm', () => kmToMetres(f.usedKm.trim())) : 0,
    usedDurationS: f.usedHours.trim() ? guard('usedHours', () => hoursToSeconds(f.usedHours.trim())) : 0,
    overtimeS: f.overtimeHours.trim() ? guard('overtimeHours', () => hoursToSeconds(f.overtimeHours.trim())) : 0,
    tripCount: intOr0(f.tripCount),
  };
}

/** Days in an inclusive YYYY-MM-DD range (0 when invalid). */
export function daysInclusive(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}
