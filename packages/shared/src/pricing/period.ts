/** Date-only helpers ('YYYY-MM-DD', UTC arithmetic) and document numbering (doc 19 §5.8, §9.3). */
import type { AvailabilityFrequency } from './types';

const DAY = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function ms(d: string): number {
  if (!DAY_RE.test(d)) throw new Error(`INVALID_DATE: "${d}"`);
  const t = Date.parse(`${d}T00:00:00.000Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== d) throw new Error(`INVALID_DATE: "${d}"`);
  return t;
}
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);

export function isYmd(d: unknown): d is string {
  try {
    return typeof d === 'string' && ms(d) >= 0;
  } catch {
    return false;
  }
}

/** Days from a to b, both included (a = b → 1; b before a → 0). */
export function daysBetweenInclusive(a: string, b: string): number {
  return Math.max(0, Math.round((ms(b) - ms(a)) / DAY) + 1);
}

export function addDaysYmd(d: string, n: number): string {
  return ymd(ms(d) + n * DAY);
}

/** DAILY = the day; WEEKLY = ISO week Monday–Sunday; MONTHLY = calendar month. */
export function periodBounds(frequency: AvailabilityFrequency, date: string): { start: string; end: string } {
  const t = ms(date);
  if (frequency === 'DAILY') return { start: date, end: date };
  if (frequency === 'WEEKLY') {
    const dow = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
    const start = ymd(t - dow * DAY);
    return { start, end: addDaysYmd(start, 6) };
  }
  const d = new Date(t);
  const start = ymd(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = ymd(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return { start, end };
}

export function daysInPeriod(frequency: AvailabilityFrequency, date: string): number {
  const b = periodBounds(frequency, date);
  return daysBetweenInclusive(b.start, b.end);
}

/** Fiscal year label: startMonth 1 → "2026"; startMonth 4 → "2026-27" (the year in which the fiscal year starts). */
export function fiscalYearLabel(dateYmd: string, startMonth: number): string {
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) throw new Error('INVALID_FISCAL_START');
  const d = new Date(ms(dateYmd));
  const y = d.getUTCMonth() + 1 >= startMonth ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return startMonth === 1 ? String(y) : `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

/** "<prefix>/<fy>/<seq:4+>" (prefix optional). */
export function formatDocumentNumber(prefix: string | null | undefined, fy: string, seq: number): string {
  return `${prefix ? `${prefix}/` : ''}${fy}/${String(seq).padStart(4, '0')}`;
}
