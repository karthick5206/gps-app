import type { AttendanceRowDto } from '@veetracer/shared';

export interface EmployeeStats {
  /** Days the person was due: present, late, half day, absent (today's unfinished day is not counted). */
  dueDays: number;
  presentDays: number;
  lateDays: number;
  halfDays: number;
  absentDays: number;
  daysOff: number;
  /** A half day counts as half. 0 when nothing was due. */
  attendancePct: number;
  /** Usual check-in time (median of first-in), minutes after local midnight; null when never checked in. */
  usualCheckInMin: number | null;
  /** Average worked minutes on the days they came. */
  avgWorkedMin: number;
  workedMin: number;
  overtimeMin: number;
  lateMin: number;
  earlyDays: number;
  earlyMin: number;
  unexplainedMin: number;
  correctedDays: number;
  /** Late days per weekday, Sunday = 0. */
  lateByWeekday: number[];
  /** The weekday most late days fall on, when it is a clear pattern (at least 2 days and 40 % of the late days). */
  lateWeekday: number | null;
}

const minutesOfDay = (iso: string) => {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
};
const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();

/** One person's figures for a period, from their timesheet rows. */
export function employeeStats(rows: AttendanceRowDto[]): EmployeeStats {
  const whole = (s: string) => rows.filter((r) => !r.halfDay && r.status === s).length;
  const presentDays = whole('PRESENT');
  const lateDays = whole('LATE');
  const halfDays = rows.filter((r) => r.halfDay).length;
  const absentDays = whole('ABSENT');
  const dueDays = presentDays + lateDays + halfDays + absentDays;
  const came = rows.filter((r) => r.firstIn && (r.halfDay || r.status === 'PRESENT' || r.status === 'LATE'));
  const ins = came.map((r) => minutesOfDay(r.firstIn!)).sort((a, b) => a - b);
  const median = ins.length ? (ins.length % 2 ? ins[(ins.length - 1) / 2] : Math.round((ins[ins.length / 2 - 1] + ins[ins.length / 2]) / 2)) : null;
  const sum = (f: (r: AttendanceRowDto) => number) => rows.reduce((n, r) => n + f(r), 0);
  const lateByWeekday = [0, 0, 0, 0, 0, 0, 0];
  for (const r of rows) if (r.lateMin > 0) lateByWeekday[weekday(r.day)]++;
  const lateTotal = lateByWeekday.reduce((a, b) => a + b, 0);
  const top = lateByWeekday.indexOf(Math.max(...lateByWeekday));
  return {
    dueDays,
    presentDays,
    lateDays,
    halfDays,
    absentDays,
    daysOff: whole('DAY_OFF'),
    attendancePct: dueDays ? Math.round(((presentDays + lateDays + halfDays / 2) / dueDays) * 1000) / 10 : 0,
    usualCheckInMin: median,
    avgWorkedMin: came.length ? Math.round(came.reduce((n, r) => n + r.workedMin, 0) / came.length) : 0,
    workedMin: sum((r) => r.workedMin),
    overtimeMin: sum((r) => r.overtimeMin),
    lateMin: sum((r) => r.lateMin),
    earlyDays: rows.filter((r) => r.earlyMin > 0).length,
    earlyMin: sum((r) => r.earlyMin),
    unexplainedMin: sum((r) => r.unexplainedMin),
    correctedDays: rows.filter((r) => r.corrected).length,
    lateByWeekday,
    lateWeekday: lateTotal && lateByWeekday[top] >= 2 && lateByWeekday[top] / lateTotal >= 0.4 ? top : null,
  };
}

/** Days of the calendar grid for [from, to]: whole weeks, Monday first; null = outside the period. */
export function calendarDays(from: string, to: string): (string | null)[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const lead = (new Date(start).getUTCDay() + 6) % 7; // Monday = 0
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let t = start; t <= end; t += 86_400_000) cells.push(new Date(t).toISOString().slice(0, 10));
  while (cells.length % 7) cells.push(null);
  return cells;
}

/** One sentence of the plain-language summary: a translation key (English text) and its values. */
export interface SummaryFact {
  key: string;
  values: Record<string, string | number>;
}
/** How a sentence shows durations / weekdays (kept outside so this file stays free of formatting and i18n). */
export interface SummaryFormat {
  duration: (min: number) => string;
  weekday: (sundayZero: number) => string;
}

/**
 * The plain-language summary at the top of Employee insights, most useful facts first: punctuality, the late habit,
 * hours against the shift, overtime, absences. `shiftMin` = shift length (end - start); null when unknown.
 * Hours count as "about the full shift" within 15 minutes.
 */
export function employeeSummary(st: EmployeeStats, rows: AttendanceRowDto[], shiftMin: number | null, f: SummaryFormat): SummaryFact[] {
  const out: SummaryFact[] = [];
  if (!st.dueDays) return out;
  const lateRows = rows.filter((r) => r.lateMin > 0);
  const onTime = st.dueDays - st.absentDays - lateRows.length;
  out.push({ key: 'On time on {{n}} of {{due}} working days.', values: { n: Math.max(0, onTime), due: st.dueDays } });
  if (lateRows.length) {
    const avg = Math.round(st.lateMin / lateRows.length);
    out.push(
      st.lateWeekday !== null
        ? { key: 'Usually late on {{day}}, by {{min}} on average.', values: { day: f.weekday(st.lateWeekday), min: f.duration(avg) } }
        : { key: 'Late {{n}} times, by {{min}} on average.', values: { n: lateRows.length, min: f.duration(avg) } },
    );
  }
  if (st.avgWorkedMin && shiftMin) {
    const diff = st.avgWorkedMin - shiftMin;
    if (diff >= 15) out.push({ key: 'Works {{diff}} a day more than the shift on average ({{avg}}).', values: { diff: f.duration(diff), avg: f.duration(st.avgWorkedMin) } });
    else if (diff <= -15) out.push({ key: 'Works {{diff}} a day less than the shift on average ({{avg}}).', values: { diff: f.duration(-diff), avg: f.duration(st.avgWorkedMin) } });
    else out.push({ key: 'Works about the full shift on average ({{avg}} a day).', values: { avg: f.duration(st.avgWorkedMin) } });
  }
  if (st.overtimeMin) out.push({ key: '{{min}} overtime in this period.', values: { min: f.duration(st.overtimeMin) } });
  if (st.absentDays) out.push({ key: 'Absent on {{n}} days.', values: { n: st.absentDays } });
  return out;
}

/** Minutes after local midnight of an ISO time (charts and stats use the viewer's local clock). */
export const minutesOfDayLocal = minutesOfDay;
