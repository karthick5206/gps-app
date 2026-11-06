import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AttendanceRowDto } from '@veetracer/shared';
import { calendarDays, employeeStats } from './employee-stats.ts';

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
