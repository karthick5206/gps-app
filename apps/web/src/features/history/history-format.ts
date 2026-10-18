import { TRACK_STATUS_CODES, type AlertSeverity, type MovementStatus } from '@veetracer/shared';

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const timeShortFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateTimeShortFmt = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

const dayFmt = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short' });
export function formatDay(t: number): string {
  return dayFmt.format(t);
}

/** Cached formatters (cheap enough for per-frame use). */
export function formatClock(t: number, withDate = false, withSeconds = true): string {
  const fmt = withDate ? (withSeconds ? dateTimeFmt : dateTimeShortFmt) : withSeconds ? timeFmt : timeShortFmt;
  return fmt.format(t);
}

export function trackStatus(code: number): MovementStatus {
  return TRACK_STATUS_CODES[code] ?? 'NO_DATA';
}

export function severityColor(severity: AlertSeverity): string {
  if (severity === 'CRITICAL') return 'var(--status-off)';
  if (severity === 'WARNING') return 'var(--status-idle)';
  return '#0ea5e9';
}

export function formatKm(km: number): string {
  return km >= 100 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
}

const MIN = 60_000;
const TICK_STEPS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 7200].map((m) => m * MIN);

/** Round tick times (local clock) between start and end, at most `maxTicks`. */
export function timeTicks(start: number, end: number, maxTicks: number): { t: number; step: number }[] {
  if (!(end > start) || maxTicks < 1) return [];
  const step = TICK_STEPS.find((s) => (end - start) / s <= maxTicks) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const anchor = new Date(start);
  anchor.setHours(0, 0, 0, 0);
  const a = anchor.getTime();
  const out: { t: number; step: number }[] = [];
  for (let t = a + Math.ceil((start - a) / step) * step; t <= end; t += step) out.push({ t, step });
  return out;
}
