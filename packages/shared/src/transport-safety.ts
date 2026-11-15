/**
 * Night-shift safety (v1.16.7, Daily transport). Company settings `etms.nightSafety` (on), `etms.nightFrom` /
 * `etms.nightTo` ("HH:MM", company time zone; a window past midnight is fine) and `etms.reachedHomeMin`.
 * - Escort check: on a trip inside the night window, the first pickup (IN) or the last drop (OUT) rides alone with the
 *   driver; the desk sees who, before publishing and on the trip card.
 * - Reached-home watch: a passenger dropped inside the window who has not confirmed the drop in the app within
 *   `reachedHomeMin` minutes appears on GET /transport/safety-watch (Needs attention).
 */

export const DEFAULT_NIGHT_FROM = '20:00';
export const DEFAULT_NIGHT_TO = '06:00';
export const DEFAULT_REACHED_HOME_MIN = 20;
export const REACHED_HOME_BOUNDS_MIN = { min: 5, max: 180 } as const;
export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface NightSafetySettings {
  on: boolean;
  from: string;
  to: string;
  reachedHomeMin: number;
}

/** Night safety settings from Company.settings (defaults when unset). */
export function nightSafetyOf(settings: unknown): NightSafetySettings {
  const s = typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>).etms : undefined;
  const e = typeof s === 'object' && s !== null ? (s as Record<string, unknown>) : {};
  const hhmm = (v: unknown, d: string) => (typeof v === 'string' && HHMM_RE.test(v) ? v : d);
  const min = typeof e.reachedHomeMin === 'number' && e.reachedHomeMin >= REACHED_HOME_BOUNDS_MIN.min && e.reachedHomeMin <= REACHED_HOME_BOUNDS_MIN.max ? e.reachedHomeMin : DEFAULT_REACHED_HOME_MIN;
  return { on: e.nightSafety === true, from: hhmm(e.nightFrom, DEFAULT_NIGHT_FROM), to: hhmm(e.nightTo, DEFAULT_NIGHT_TO), reachedHomeMin: min };
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Whether a wall-clock time (minutes after midnight) falls in the window (from inclusive, to exclusive; may wrap). */
export function inNightWindow(minuteOfDay: number, from: string, to: string): boolean {
  const f = toMin(from);
  const t = toMin(to);
  return f <= t ? minuteOfDay >= f && minuteOfDay < t : minuteOfDay >= f || minuteOfDay < t;
}

/** Minutes after midnight of an instant in a time zone. */
export function minuteOfDayIn(iso: string | number | Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

/** GET /api/transport/safety-watch — night drops waiting for the passenger's confirmation. */
export interface SafetyWatchDto {
  nightSafety: NightSafetySettings;
  reachedHomePending: { passengerTripId: string; tripId: string; tripName: string; vehicleName: string | null; passenger: string; droppedAt: string; minutesAgo: number }[];
}
