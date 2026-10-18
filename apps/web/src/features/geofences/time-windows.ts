/** Pure helpers for TimeWindow (days 1–7 = Mon–Sun, HH:mm, from > to wraps midnight). No imports: node --test friendly. */

export interface Window {
  days: number[];
  from: string;
  to: string;
}

export const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const DAY_LETTER = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Translator for UI text; the default fills `{{vars}}` into the English key (keeps this file import-free for tests). */
export type Translate = (key: string, vars?: Record<string, string>) => string;
const plain: Translate = (key, vars) => key.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars?.[k] ?? '');

export function isTime(v: string): boolean {
  return TIME_RE.test(v);
}

/** "Mon–Fri", "Every day", "Weekends", "Mon, Wed, Fri", "Sat–Mon"-style runs are not wrapped across Sunday. */
export function formatDays(days: number[], tr: Translate = plain): string {
  const set = Array.from(new Set(days.filter((d) => d >= 1 && d <= 7))).sort((a, b) => a - b);
  if (set.length === 0) return tr('No days');
  if (set.length === 7) return tr('Every day');
  if (set.length === 2 && set[0] === 6 && set[1] === 7) return tr('Weekends');
  if (set.length === 5 && set.join() === '1,2,3,4,5') return tr('Weekdays');
  const runs: string[] = [];
  let start = set[0];
  let prev = set[0];
  const day = (d: number) => tr(DAY_SHORT[d - 1]);
  const flush = () => {
    if (prev - start >= 2) runs.push(`${day(start)}–${day(prev)}`);
    else if (prev !== start) runs.push(day(start), day(prev));
    else runs.push(day(start));
  };
  for (const d of set.slice(1)) {
    if (d === prev + 1) prev = d;
    else {
      flush();
      start = prev = d;
    }
  }
  flush();
  return runs.join(', ');
}

export function wrapsMidnight(w: Pick<Window, 'from' | 'to'>): boolean {
  return w.from > w.to;
}

/** "Weekdays 08:00–18:00", "Every day 22:00–06:00 (overnight)", "Every day, all day". */
export function formatWindow(w: Window, tr: Translate = plain): string {
  const days = formatDays(w.days, tr);
  if (w.from === w.to) return tr('{{days}}, all day', { days });
  return `${days} ${w.from}–${w.to}${wrapsMidnight(w) ? ` ${tr('(overnight)')}` : ''}`;
}

export function formatWindows(ws: Window[], tr: Translate = plain): string {
  return ws.length ? ws.map((w) => formatWindow(w, tr)).join('; ') : tr('Always active');
}

/** Validation message or null. */
export function validateWindow(w: Window, tr: Translate = plain): string | null {
  if (!w.days.length) return tr('Pick at least one day');
  if (!isTime(w.from) || !isTime(w.to)) return tr('Use HH:mm times');
  return null;
}

/**
 * Whether local day-of-week (1–7) and minute-of-day fall inside the window. An overnight window
 * (from > to) belongs to the day it starts on, so Mon 22:00–06:00 covers Tue 03:00.
 */
export function inWindow(w: Window, day: number, minute: number): boolean {
  const f = toMinutes(w.from);
  const t = toMinutes(w.to);
  if (f === t) return w.days.includes(day);
  if (f < t) return w.days.includes(day) && minute >= f && minute < t;
  const prevDay = day === 1 ? 7 : day - 1;
  return (w.days.includes(day) && minute >= f) || (w.days.includes(prevDay) && minute < t);
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export const DEFAULT_WINDOW: Window = { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' };
