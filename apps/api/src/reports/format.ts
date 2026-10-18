import { formatLocal } from '../summarizer/tz';

/** Seconds → 'hh:mm:ss' (hours may exceed 24). */
export function hhmmss(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '';
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

/** ISO string / Date → 'YYYY-MM-DD HH:mm:ss' in the company timezone ('' for null). */
export function localTime(value: string | Date | null | undefined, tz: string): string {
  if (!value) return '';
  const ms = typeof value === 'string' ? Date.parse(value) : value.getTime();
  return Number.isFinite(ms) ? formatLocal(ms, tz) : '';
}

export function fixed(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '' : value.toFixed(digits);
}
