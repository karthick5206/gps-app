/** Pure helpers for the System Health page (no imports so node --test can run them). */

export type Status = 'OK' | 'WARN' | 'CRITICAL';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** 1536 → "1.5 KB" (binary steps). */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  let v = Math.max(0, n);
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)} ${UNITS[u]}`;
}

/** 12345 → "12.3k", 2_000_000 → "2M" (chart axes). */
export function compactNumber(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${+(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${+(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `${Math.round(n)}`;
}

/** Fraction 0..1 of a bar, clamped; null when either side is unknown or the cap is 0. */
export function fraction(value: number | null | undefined, max: number | null | undefined): number | null {
  if (value === null || value === undefined || !max) return null;
  return Math.min(1, Math.max(0, value / max));
}

/** Badge variant for a status. */
export function statusVariant(s: Status): 'success' | 'warning' | 'destructive' {
  return s === 'CRITICAL' ? 'destructive' : s === 'WARN' ? 'warning' : 'success';
}

/** Overall label: Healthy / Degraded / Critical. */
export function overallLabel(s: Status): string {
  return s === 'CRITICAL' ? 'Critical' : s === 'WARN' ? 'Degraded' : 'Healthy';
}

/** Round axis maximum: 1, 2, 5 × 10^n. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
