/** Date-range presets and parsing for the history page (pure; browser-local time). */

export type RangePreset = 'today' | 'yesterday' | 'last7' | 'custom';
export interface TimeRange {
  from: Date;
  to: Date;
}

export const MAX_RANGE_DAYS = 31;
const DAY_MS = 86_400_000;

export const PRESET_LABELS: Record<RangePreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last7: 'Last 7 days',
  custom: 'Custom',
};

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

export function presetRange(preset: Exclude<RangePreset, 'custom'>, now: Date = new Date()): TimeRange {
  switch (preset) {
    case 'today':
      return { from: startOfDay(now), to: endOfDay(now) };
    case 'yesterday': {
      const y = addDays(now, -1);
      return { from: startOfDay(y), to: endOfDay(y) };
    }
    case 'last7':
      return { from: startOfDay(addDays(now, -6)), to: endOfDay(now) };
  }
}

/** Longest custom range on the phone's History screen (days, inclusive). */
export const MOBILE_CUSTOM_MAX_DAYS = 7;

/**
 * Custom day range (YYYY-MM-DD, local days, inclusive). When one end is changed and the span goes past `maxDays`
 * (or the order flips), the other end moves along, so any 7 days can be chosen without an error.
 */
export function clampDayRange(fromYmd: string, toYmd: string, changed: 'from' | 'to', maxDays = MOBILE_CUSTOM_MAX_DAYS): { from: string; to: string } {
  const parse = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  let f = parse(fromYmd);
  let t = parse(toYmd);
  const span = Math.round((t.getTime() - f.getTime()) / DAY_MS) + 1;
  if (changed === 'from' && (span < 1 || span > maxDays)) t = addDays(f, span < 1 ? 0 : maxDays - 1);
  if (changed === 'to' && (span < 1 || span > maxDays)) f = addDays(t, span < 1 ? 0 : -(maxDays - 1));
  return { from: ymd(f), to: ymd(t) };
}

/** Custom day range → time range (start of the first day to end of the last). */
export function dayRange(fromYmd: string, toYmd: string): TimeRange {
  const [fy, fm, fd] = fromYmd.split('-').map(Number);
  const [ty, tm, td] = toYmd.split('-').map(Number);
  return { from: startOfDay(new Date(fy, fm - 1, fd)), to: endOfDay(new Date(ty, tm - 1, td)) };
}

/**
 * Custom range with times of day: `fromMin` / `toMin` are minutes after midnight (0–1439). The end minute is
 * inclusive (23:59 → 23:59:59.999). Returns null when the end is not after the start.
 */
export function dayTimeRange(fromYmd: string, fromMin: number, toYmd: string, toMin: number): TimeRange | null {
  const base = dayRange(fromYmd, toYmd);
  const from = new Date(base.from);
  from.setHours(Math.floor(fromMin / 60), fromMin % 60, 0, 0);
  const to = startOfDay(base.to);
  to.setHours(Math.floor(toMin / 60), toMin % 60, 59, 999);
  return to.getTime() > from.getTime() ? { from, to } : null;
}

/** Which preset a range corresponds to (minute precision), else 'custom'. */
export function detectPreset(range: TimeRange, now: Date = new Date()): RangePreset {
  const same = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) < 60_000;
  for (const p of ['today', 'yesterday', 'last7'] as const) {
    const r = presetRange(p, now);
    if (same(r.from, range.from) && same(r.to, range.to)) return p;
  }
  return 'custom';
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Value for `<input type="datetime-local">`: YYYY-MM-DDTHH:mm in local time. */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Returns an error message, or null when the range is usable. */
export function validateRange(range: TimeRange): string | null {
  const span = range.to.getTime() - range.from.getTime();
  if (!Number.isFinite(span)) return 'Choose a valid start and end';
  if (span <= 0) return 'End must be after start';
  if (span > MAX_RANGE_DAYS * DAY_MS) return `Choose at most ${MAX_RANGE_DAYS} days`;
  return null;
}

function parseDate(v: string | null): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Reads `?from=&to=` (ISO); falls back to Today. */
export function rangeFromParams(params: URLSearchParams, now: Date = new Date()): TimeRange {
  const from = parseDate(params.get('from'));
  const to = parseDate(params.get('to'));
  if (from && to && !validateRange({ from, to })) return { from, to };
  return presetRange('today', now);
}
