import type { AttendanceLiveState, AttendanceStatus, OutingKind } from '@veetracer/shared';

export const STATUS: Record<AttendanceStatus, { label: string; color: string }> = {
  PRESENT: { label: 'Present', color: '#059669' },
  LATE: { label: 'Late', color: '#d97706' },
  NOT_ARRIVED: { label: 'Not arrived', color: '#ea580c' },
  ABSENT: { label: 'Absent', color: '#e11d48' },
  DAY_OFF: { label: 'Day off', color: '#64748b' },
  UPCOMING: { label: 'Not started', color: '#64748b' },
};
export const HALF_DAY = { label: 'Half day', color: '#0284c7' };
export const LIVE: Record<AttendanceLiveState, { label: string; color: string }> = {
  INSIDE: { label: 'Inside', color: '#059669' },
  OUT: { label: 'Out now', color: '#e11d48' },
  NO_SIGNAL: { label: 'No signal', color: '#d97706' },
};
export const KINDS: Record<OutingKind, string> = { UNEXPLAINED: 'Unexplained', OFFICIAL: 'Official duty', PERSONAL: 'Personal' };
/** An outing's kind inside a sentence ("Counted as: Personal work"). */
export const OUTING_WORDS: Record<OutingKind, string> = { UNEXPLAINED: 'Not explained yet', OFFICIAL: 'Official duty', PERSONAL: 'Personal work' };

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
export const time = (iso: string | null | undefined) => (iso ? clock.format(Date.parse(iso)) : '—');
export const hours = (min: number) => (min ? `${Math.floor(min / 60)} h ${min % 60} min` : '—');
export const localToday = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
/** YYYY-MM-DD plus or minus days, without time-zone surprises. */
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
