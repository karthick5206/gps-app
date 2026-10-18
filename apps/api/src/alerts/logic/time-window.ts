import { TimeWindow } from '@veetracer/shared';

/** Local wall-clock parts of an instant in a timezone. `day` is ISO 1–7 (Monday–Sunday), `minutes` since local midnight. */
export interface LocalParts {
  day: number;
  minutes: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    } catch {
      f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    }
    formatters.set(timeZone, f);
  }
  return f;
}

export function localParts(epochMs: number, timeZone: string): LocalParts {
  let day = 1;
  let hour = 0;
  let minute = 0;
  for (const part of formatter(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type === 'weekday') day = WEEKDAYS[part.value] ?? 1;
    else if (part.type === 'hour') hour = Number(part.value) % 24;
    else if (part.type === 'minute') minute = Number(part.value);
  }
  return { day, minutes: hour * 60 + minute };
}

/** "HH:mm" → minutes since midnight, or null when malformed. */
export function parseHhmm(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function isValidTimeWindow(w: unknown): w is TimeWindow {
  if (typeof w !== 'object' || w === null) return false;
  const tw = w as Record<string, unknown>;
  return (
    Array.isArray(tw.days) &&
    tw.days.every((d) => Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 7) &&
    parseHhmm(tw.from) !== null &&
    parseHhmm(tw.to) !== null
  );
}

/**
 * Is the local time inside the window? `from` > `to` wraps midnight and belongs to the day it started on
 * (Mon 22:00–06:00 covers Tuesday 02:00). `from` == `to` = the whole day. An empty `days` list never matches.
 */
export function inTimeWindow(window: TimeWindow, parts: LocalParts): boolean {
  const from = parseHhmm(window.from);
  const to = parseHhmm(window.to);
  if (from === null || to === null) return false;
  const days = new Set(window.days);
  const t = parts.minutes;
  if (from === to) return days.has(parts.day);
  if (from < to) return days.has(parts.day) && t >= from && t < to;
  // Wraps midnight.
  if (t >= from) return days.has(parts.day);
  if (t < to) return days.has(parts.day === 1 ? 7 : parts.day - 1);
  return false;
}

export function inAnyTimeWindow(windows: TimeWindow[] | null | undefined, epochMs: number, timeZone: string): boolean {
  if (!windows || windows.length === 0) return true;
  const parts = localParts(epochMs, timeZone);
  return windows.some((w) => inTimeWindow(w, parts));
}

/** Daily range "HH:mm"–"HH:mm" regardless of weekday (e.g. the overspeed night limit). */
export function inDailyRange(from: unknown, to: unknown, epochMs: number, timeZone: string): boolean {
  const f = parseHhmm(from);
  const t = parseHhmm(to);
  if (f === null || t === null) return false;
  return inTimeWindow({ days: [1, 2, 3, 4, 5, 6, 7], from: from as string, to: to as string }, localParts(epochMs, timeZone));
}

/** Human-friendly local timestamp, e.g. "18 Oct 2026, 14:05". */
export function formatLocal(epochMs: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(epochMs));
  } catch {
    return new Date(epochMs).toISOString();
  }
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}
