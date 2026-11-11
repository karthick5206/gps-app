/**
 * Schedule day / time helpers (pure, runs under node --test).
 * Values follow the API: 0 = Sunday … 6 = Saturday; start time = local minutes after midnight.
 * Display order is Monday first.
 */

/** Monday-first display order of day values. */
export const WEEK_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export interface DayWords {
  /** Short day names indexed by value (0 = Sunday). */
  names: string[];
  everyDay: string;
  weekdays: string;
  weekends: string;
}

/** Sorted (Sunday-first values), de-duplicated, only 0–6. */
export function cleanDays(days: number[]): number[] {
  return [...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
}

/** Adds or removes a day. */
export function toggleDay(days: number[], day: number): number[] {
  return cleanDays(days.includes(day) ? days.filter((d) => d !== day) : [...days, day]);
}

/**
 * Compact label in Monday-first order: "Every day", "Mon–Fri" → `weekdays`, "Sat, Sun" → `weekends`, runs of three
 * or more days as "Mon–Wed", others comma-separated ("Mon, Wed, Fri").
 */
export function formatDays(days: number[], words: DayWords): string {
  const set = new Set(cleanDays(days));
  if (set.size === 0) return '—';
  if (set.size === 7) return words.everyDay;
  const ordered = WEEK_DISPLAY_ORDER.filter((d) => set.has(d));
  const key = ordered.join(',');
  if (key === '1,2,3,4,5') return words.weekdays;
  if (key === '6,0') return words.weekends;
  // Group consecutive positions of the display order.
  const pos = ordered.map((d) => WEEK_DISPLAY_ORDER.indexOf(d as (typeof WEEK_DISPLAY_ORDER)[number]));
  const parts: string[] = [];
  for (let i = 0; i < pos.length; ) {
    let j = i;
    while (j + 1 < pos.length && pos[j + 1] === pos[j] + 1) j++;
    const run = j - i + 1;
    if (run >= 3) parts.push(`${words.names[ordered[i]]}–${words.names[ordered[j]]}`);
    else for (let k = i; k <= j; k++) parts.push(words.names[ordered[k]]);
    i = j + 1;
  }
  return parts.join(', ');
}

/** 540 → "09:00". */
export function minutesToTime(min: number): string {
  const m = Math.max(0, Math.min(1439, Math.round(min)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** "09:00" → 540; null when not a valid 24 h time. */
export function timeToMinutes(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Short weekday names (index 0 = Sunday) in `locale`, from a known Sunday (2026-01-04). */
export function weekdayNames(locale: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  return Array.from({ length: 7 }, (_, d) => fmt.format(new Date(Date.UTC(2026, 0, 4 + d))));
}
