/**
 * Field staff attendance: people tracked by phone / ID card check in and out automatically when they enter and leave
 * a work-site geofence. Working days and hours are set per company (company time zone).
 */

export type AttendanceStatus = 'PRESENT' | 'LATE' | 'NOT_ARRIVED' | 'ABSENT' | 'DAY_OFF' | 'UPCOMING';

export interface AttendanceSettingsDto {
  enabled: boolean;
  /** Work-site geofences; a visit to any of them counts. */
  geofenceIds: string[];
  /** Staff (tracked objects) covered; empty = every person (phone / ID card) in the company. */
  objectIds: string[];
  /** Working days, 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** Working hours, minutes after midnight. */
  startMin: number;
  endMin: number;
  /** Arriving within this many minutes after the start is still on time. */
  graceMin: number;
}

export const DEFAULT_ATTENDANCE: AttendanceSettingsDto = { enabled: false, geofenceIds: [], objectIds: [], days: [1, 2, 3, 4, 5, 6], startMin: 9 * 60 + 30, endMin: 18 * 60 + 30, graceMin: 15 };

export interface AttendanceRowDto {
  objectId: string;
  name: string;
  day: string;
  status: AttendanceStatus;
  firstIn: string | null;
  lastOut: string | null;
  /** Time inside the work sites that day (minutes). */
  onSiteMin: number;
  site: string | null;
  /** Minutes after start + grace (late arrivals). */
  lateMin: number;
}

export interface AttendanceDayDto {
  day: string;
  enabled: boolean;
  workingDay: boolean;
  rows: AttendanceRowDto[];
  counts: Record<AttendanceStatus, number>;
}

export interface Visit {
  enter: number;
  /** null = still inside. */
  exit: number | null;
  site: string;
}

/**
 * Status of one person for one day: dayStart/dayEnd are that local day's midnight bounds; start / grace / end are the
 * working-hours instants. `now` decides whether the day is still running.
 */
export function attendanceOf(
  visits: Visit[],
  w: { workingDay: boolean; dayStart: number; dayEnd: number; start: number; grace: number; end: number },
  now: number,
): { status: AttendanceStatus; firstIn: number | null; lastOut: number | null; onSiteMin: number; site: string | null; lateMin: number } {
  const inDay = visits
    .map((v) => ({ enter: Math.max(v.enter, w.dayStart), exit: Math.min(v.exit ?? Math.min(now, w.dayEnd), w.dayEnd), site: v.site, open: v.exit === null }))
    .filter((v) => v.exit > v.enter)
    .sort((a, b) => a.enter - b.enter);
  const firstIn = inDay[0]?.enter ?? null;
  const last = inDay[inDay.length - 1];
  const lastOut = last ? (last.open && last.exit >= Math.min(now, w.dayEnd) ? null : last.exit) : null;
  const onSiteMin = Math.round(inDay.reduce((s, v) => s + (v.exit - v.enter), 0) / 60_000);
  const site = inDay[0]?.site ?? null;
  if (!w.workingDay) return { status: 'DAY_OFF', firstIn, lastOut, onSiteMin, site, lateMin: 0 };
  if (firstIn !== null) {
    const lateMin = firstIn > w.grace ? Math.round((firstIn - w.grace) / 60_000) : 0;
    return { status: lateMin > 0 ? 'LATE' : 'PRESENT', firstIn, lastOut, onSiteMin, site, lateMin };
  }
  if (now < w.grace) return { status: 'UPCOMING', firstIn, lastOut, onSiteMin, site, lateMin: 0 };
  if (now < w.end) return { status: 'NOT_ARRIVED', firstIn, lastOut, onSiteMin, site, lateMin: 0 };
  return { status: 'ABSENT', firstIn, lastOut, onSiteMin, site, lateMin: 0 };
}

export function attendanceSettingsError(s: AttendanceSettingsDto): string | null {
  if (s.enabled && !s.geofenceIds.length) return 'Choose at least one work-site geofence';
  if (s.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'Invalid day';
  if (![s.startMin, s.endMin].every((m) => Number.isInteger(m) && m >= 0 && m < 1440)) return 'Invalid time';
  if (s.endMin <= s.startMin) return 'The end time must be after the start time';
  if (!Number.isInteger(s.graceMin) || s.graceMin < 0 || s.graceMin > 180) return 'Grace must be 0–180 minutes';
  return null;
}
