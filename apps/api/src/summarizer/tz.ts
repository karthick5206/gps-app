/**
 * Timezone helpers built on Intl (no extra dependency). Day keys are 'YYYY-MM-DD' strings in a company timezone.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function localParts(epochMs: number, tz: string): LocalParts {
  const out: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/** Offset of `tz` from UTC at the instant `epochMs`, in ms (IST = +19_800_000). */
export function tzOffsetMs(epochMs: number, tz: string): number {
  const p = localParts(epochMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function dayKeyOf(y: number, m: number, d: number): string {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** Local calendar day of an instant. */
export function localDayKey(epochMs: number, tz: string): string {
  const p = localParts(epochMs, tz);
  return dayKeyOf(p.year, p.month, p.day);
}

export function parseDayKey(day: string): { y: number; m: number; d: number } {
  const [y, m, d] = day.split('-').map(Number);
  return { y, m, d };
}

export function isDayKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const { y, m, d } = parseDayKey(value);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** UTC instant of a local wall-clock time in `tz`. */
export function zonedTimeToUtc(day: string, hour: number, minute: number, tz: string): number {
  const { y, m, d } = parseDayKey(day);
  const guess = Date.UTC(y, m - 1, d, hour, minute, 0);
  const first = guess - tzOffsetMs(guess, tz);
  const second = guess - tzOffsetMs(first, tz);
  return second;
}

/** UTC instant of local midnight starting `day`. */
export function localMidnight(day: string, tz: string): number {
  return zonedTimeToUtc(day, 0, 0, tz);
}

export function addDays(day: string, n: number): string {
  const { y, m, d } = parseDayKey(day);
  const date = new Date(Date.UTC(y, m - 1, d + n));
  return dayKeyOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  const pa = parseDayKey(a);
  const pb = parseDayKey(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000);
}

/** ISO weekday 1 = Monday … 7 = Sunday. */
export function isoWeekday(day: string): number {
  const { y, m, d } = parseDayKey(day);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/** Monday of the ISO week containing `day`. */
export function isoWeekStart(day: string): string {
  return addDays(day, 1 - isoWeekday(day));
}

/** ISO week key, e.g. '2026-W42' (the year is the ISO week-numbering year). */
export function isoWeekKey(day: string): string {
  const thursday = addDays(day, 4 - isoWeekday(day));
  const { y } = parseDayKey(thursday);
  const week = Math.floor(daysBetween(dayKeyOf(y, 1, 1), thursday) / 7) + 1;
  return `${y}-W${pad(week)}`;
}

export function monthKey(day: string): string {
  return day.slice(0, 7);
}

/** Local day range [start, end) in epoch ms. */
export function localDayRange(day: string, tz: string): { start: number; end: number } {
  return { start: localMidnight(day, tz), end: localMidnight(addDays(day, 1), tz) };
}

/** 'YYYY-MM-DD HH:mm:ss' local time. */
export function formatLocal(epochMs: number, tz: string): string {
  const p = localParts(epochMs, tz);
  return `${dayKeyOf(p.year, p.month, p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
