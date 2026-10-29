import { isEmergencyAlert } from './alerts';
/**
 * Parking mode (spy mode): weekly windows per vehicle. While a window is open the vehicle is "armed": any movement or
 * ignition raises PARKING_BREACH, and every alert of the vehicle rings as an alarm (siren that breaks through Do Not
 * Disturb on the phone, looping siren on the web) for everyone who can see the vehicle.
 */

/** Days as JavaScript getDay(): 0 = Sunday … 6 = Saturday. */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;
export const WEEKDAY_SHORT: Record<number, string> = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };

/** Moving farther than this from where it was parked (m), or faster than PARKING_SPEED_KPH, is a breach. */
export const PARKING_MOVE_M = 150;
export const PARKING_SPEED_KPH = 8;

export interface ParkingWindowDto {
  /** Days the window starts on (0 = Sunday). An overnight window (end ≤ start) ends the next morning. */
  days: number[];
  /** Minutes after local midnight, 0–1439. end ≤ start = ends the next day (equal = 24 hours). */
  startMin: number;
  endMin: number;
}

export interface ParkingScheduleDto {
  objectId: string;
  enabled: boolean;
  windows: ParkingWindowDto[];
  /** Ring the alarm for every alert of the vehicle while armed (else only for the parking breach itself). */
  alarmAllAlerts: boolean;
  /** Reserved: later escalation when nobody acknowledges (SMS, IVR voice call). Not used yet. */
  escalation: { sms?: boolean; voiceCall?: boolean; afterMin?: number };
  updatedAt: string | null;
  updatedByName: string | null;
}

/** Parking mode page row: the vehicle, its schedule and whether it is armed now / when next. */
export interface ParkingRowDto {
  objectId: string;
  name: string;
  plateNumber: string | null;
  companyId: string;
  schedule: ParkingScheduleDto | null;
  /** Open window now (ISO), or null. */
  armedUntil: string | null;
  nextStart: string | null;
}

export interface ParkingScheduleInput {
  enabled: boolean;
  windows: ParkingWindowDto[];
  alarmAllAlerts: boolean;
}

/** Windows from stored JSON (anything malformed is dropped). */
export function readParkingWindows(json: unknown): ParkingWindowDto[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((w) => {
    const o = w as Partial<ParkingWindowDto> | null;
    return o && Array.isArray(o.days) && typeof o.startMin === 'number' && typeof o.endMin === 'number'
      ? [{ days: o.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6), startMin: o.startMin, endMin: o.endMin }]
      : [];
  });
}

/** Local weekday and minute of the day of an instant in a time zone. */
function localParts(ms: number, tz: string): { dow: number; min: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { dow, min: Number(get('hour')) * 60 + Number(get('minute')) };
}

const lengthMin = (w: ParkingWindowDto) => (w.endMin > w.startMin ? w.endMin - w.startMin : 1440 - w.startMin + w.endMin);

/**
 * The window open at `now` (start and end as epoch ms, to the minute), or null. A window counts from the day it starts
 * on, so "Fri 22:00–06:00" also covers Saturday until 06:00.
 */
export function parkingArmedWindow(windows: ParkingWindowDto[], now: number, tz: string): { start: number; end: number } | null {
  const { dow, min } = localParts(now, tz);
  const minuteStart = now - (now % 60_000);
  let best: { start: number; end: number } | null = null;
  for (const w of windows) {
    for (const back of [0, 1]) {
      const day = (dow - back + 7) % 7;
      if (!w.days.includes(day)) continue;
      const sinceStart = min + back * 1440 - w.startMin;
      if (sinceStart < 0 || sinceStart >= lengthMin(w)) continue;
      const start = minuteStart - sinceStart * 60_000;
      const end = start + lengthMin(w) * 60_000;
      if (!best || end > best.end) best = { start, end };
    }
  }
  return best;
}

/** Next window start after `now` within a week (epoch ms), or null when no window is set. */
export function nextParkingStart(windows: ParkingWindowDto[], now: number, tz: string): number | null {
  if (!windows.some((w) => w.days.length)) return null;
  const { dow, min } = localParts(now, tz);
  const minuteStart = now - (now % 60_000);
  let best: number | null = null;
  for (const w of windows) {
    for (let ahead = 0; ahead <= 7; ahead++) {
      const day = (dow + ahead) % 7;
      if (!w.days.includes(day)) continue;
      const inMin = ahead * 1440 + w.startMin - min;
      if (inMin <= 0) continue;
      const at = minuteStart + inMin * 60_000;
      if (best === null || at < best) best = at;
      break;
    }
  }
  return best;
}

/** Validation message for a schedule, or null when it is fine. */
export function parkingScheduleError(s: ParkingScheduleInput): string | null {
  if (s.windows.length > 10) return 'At most 10 time windows per vehicle';
  for (const w of s.windows) {
    if (!w.days.length) return 'Choose at least one day for each time window';
    if (w.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'Invalid day';
    if (![w.startMin, w.endMin].every((m) => Number.isInteger(m) && m >= 0 && m < 1440)) return 'Invalid time';
  }
  if (s.enabled && !s.windows.length) return 'Add a time window, or switch parking mode off';
  return null;
}

/** "22:00" from minutes after midnight. */
export function formatMinutes(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * Rings as an alarm (SOS screen, siren through Do Not Disturb): emergencies, and every alert raised while the vehicle
 * was in parking mode (`data.parkingAlarm`).
 */
export function isParkingAlarm(data: Record<string, unknown> | null | undefined): boolean {
  return data?.parkingAlarm === true;
}

/** Opens the full-screen alarm (siren until acknowledged): emergencies, and parking mode alarms. */
export function isAlarmAlert(type: string | null | undefined, data: Record<string, unknown> | null | undefined): boolean {
  return isEmergencyAlert(type) || isParkingAlarm(data);
}
