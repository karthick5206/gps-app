import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AttendanceRowDto } from '@veetracer/shared';
import { calendarDays, employeeStats, employeeSummary } from '../../../../../packages/shared/src/attendance-insights.ts';

const row = (day: string, over: Partial<AttendanceRowDto>): AttendanceRowDto =>
  ({ objectId: 'p', name: 'Ravi', day, status: 'PRESENT', halfDay: false, firstIn: null, workedMin: 0, overtimeMin: 0, lateMin: 0, earlyMin: 0, unexplainedMin: 0, corrected: false, ...over }) as AttendanceRowDto;
const at = (day: string, hh: number, mm: number) => new Date(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`).toISOString();

test('counts, attendance % with half days as half, usual check-in and average hours on days attended', () => {
  const s = employeeStats([
    row('2026-11-02', { status: 'LATE', lateMin: 20, firstIn: at('2026-11-02', 10, 5), workedMin: 480 }), // Monday
    row('2026-11-03', { firstIn: at('2026-11-03', 9, 30), workedMin: 540, overtimeMin: 30 }),
    row('2026-11-04', { status: 'LATE', halfDay: true, lateMin: 90, firstIn: at('2026-11-04', 11, 35), workedMin: 300 }),
    row('2026-11-05', { status: 'ABSENT', corrected: true }),
    row('2026-11-08', { status: 'DAY_OFF' }),
    row('2026-11-09', { status: 'LATE', lateMin: 15, firstIn: at('2026-11-09', 10, 0), workedMin: 500 }), // Monday
  ]);
  assert.equal(s.dueDays, 5);
  assert.deepEqual([s.presentDays, s.lateDays, s.halfDays, s.absentDays, s.daysOff], [1, 2, 1, 1, 1]);
  assert.equal(s.attendancePct, 70);
  assert.equal(s.usualCheckInMin, 10 * 60 + 3); // median of 09:30, 10:00, 10:05, 11:35 = 10:02.5
  assert.equal(s.avgWorkedMin, 455);
  assert.equal(s.overtimeMin, 30);
  assert.equal(s.lateWeekday, 1); // 2 of 3 late days are Mondays
  assert.equal(s.correctedDays, 1);
});

test('nothing due: 0 %, no check-in, no pattern', () => {
  const s = employeeStats([row('2026-11-08', { status: 'DAY_OFF' })]);
  assert.equal(s.attendancePct, 0);
  assert.equal(s.usualCheckInMin, null);
  assert.equal(s.lateWeekday, null);
});

test('calendar: whole weeks, Monday first', () => {
  const c = calendarDays('2026-11-01', '2026-11-30'); // 1 Nov 2026 is a Sunday
  assert.equal(c.length % 7, 0);
  assert.equal(c.slice(0, 7).filter(Boolean).length, 1);
  assert.equal(c[6], '2026-11-01');
  assert.equal(c.filter(Boolean).length, 30);
});

test('summary: punctuality, late habit, hours against the shift, overtime, absences', () => {
  const rows = [
    row('2026-11-02', { status: 'LATE', lateMin: 20, firstIn: at('2026-11-02', 10, 5), workedMin: 600 }), // Monday
    row('2026-11-03', { firstIn: at('2026-11-03', 9, 30), workedMin: 600, overtimeMin: 60 }),
    row('2026-11-05', { status: 'ABSENT' }),
    row('2026-11-09', { status: 'LATE', lateMin: 10, firstIn: at('2026-11-09', 10, 0), workedMin: 600 }), // Monday
  ];
  const f = { duration: (m: number) => `${m}m`, weekday: (d: number) => ['Sun', 'Mon'][d] ?? String(d) };
  const s = employeeSummary(employeeStats(rows), rows, 540, f);
  assert.deepEqual(
    s.map((x) => [x.key, x.values]),
    [
      ['On time on {{n}} of {{due}} working days.', { n: 1, due: 4 }],
      ['Usually late on {{day}}, by {{min}} on average.', { day: 'Mon', min: '15m' }],
      ['Works {{diff}} a day more than the shift on average ({{avg}}).', { diff: '60m', avg: '600m' }],
      ['{{min}} overtime in this period.', { min: '60m' }],
      ['Absent on {{n}} days.', { n: 1 }],
    ],
  );
  assert.deepEqual(employeeSummary(employeeStats([row('2026-11-08', { status: 'DAY_OFF' })]), [], 540, f), []);
});

test('previous period: month to date ↔ same dates last month, whole month ↔ whole month, other ranges straight before', async () => {
  const { previousRange, trendRange, daysIn } = await import('../../../../../packages/shared/src/attendance-insights.ts');
  assert.deepEqual(previousRange('2026-11-01', '2026-11-08'), { from: '2026-10-01', to: '2026-10-08' });
  assert.deepEqual(previousRange('2026-10-01', '2026-10-31'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(previousRange('2026-03-01', '2026-03-31'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(previousRange('2026-03-01', '2026-03-30'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(previousRange('2026-10-10', '2026-11-08'), { from: '2026-09-10', to: '2026-10-09' });
  assert.equal(daysIn('2026-10-10', '2026-11-08'), 30);
  assert.deepEqual(trendRange('2026-11-08'), { from: '2025-12-01', to: '2026-11-08' });
});

test('monthly trend and team figures', async () => {
  const { monthlyTrend, teamFigures } = await import('../../../../../packages/shared/src/attendance-insights.ts');
  const t = monthlyTrend([row('2026-10-05', { workedMin: 480, firstIn: at('2026-10-05', 9, 0) }), row('2026-11-02', { status: 'ABSENT' }), row('2026-11-08', { status: 'DAY_OFF' })]);
  assert.deepEqual(t.map((m) => [m.month, m.stats.attendancePct]), [['2026-10', 100], ['2026-11', 0]]);
  const team = teamFigures([row('2026-11-02', { objectId: 'a', workedMin: 480 }), row('2026-11-02', { objectId: 'b', status: 'ABSENT' })]);
  assert.equal(team?.people, 2);
  assert.equal(team?.attendancePct, 50);
  assert.equal(teamFigures([row('2026-11-02', { objectId: 'a' })]), null);
});

test('today (still running) is left out of the average hours', () => {
  const s = employeeStats([row('2026-11-06', { firstIn: at('2026-11-06', 9, 0), workedMin: 540 }), row('2026-11-07', { firstIn: at('2026-11-07', 9, 0), workedMin: 120, state: 'INSIDE' } as Partial<AttendanceRowDto>)]);
  assert.equal(s.avgWorkedMin, 540);
  assert.equal(s.presentDays, 2);
});
