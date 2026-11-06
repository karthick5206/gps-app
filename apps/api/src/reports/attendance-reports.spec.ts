import type { AttendanceRowDto } from '@veetracer/shared';
import { attendanceDailyReport, attendanceOutingsReport, attendancePayrollReport, attendanceSummaryReport } from './attendance-reports';
import type { ObjInfo } from './report-queries';

const objects = new Map<string, ObjInfo>([['p1', { name: 'Ravi', plateNumber: 'EMP-7', branchId: null, branchName: 'Chennai', type: 'PERSON', vehicleType: null, speedLimitKph: null }]]);
const day = (over: Partial<AttendanceRowDto>): AttendanceRowDto => ({
  objectId: 'p1', name: 'Ravi', day: '2026-11-02', status: 'PRESENT', halfDay: false, firstIn: null, lastOut: null, onSiteMin: 0, workedMin: 0, officialMin: 0, personalMin: 0, unexplainedMin: 0, noSignalMin: 0, site: null, lateMin: 0, earlyMin: 0, overtimeMin: 0, branch: 'Chennai', shift: 'Default', state: null, carriedOver: false, inFix: null, outFix: null, outings: [], corrected: false, correctionNote: null, ...over,
});

describe('attendanceSummaryReport', () => {
  const rows = [
    day({ day: '2026-11-02', status: 'PRESENT', workedMin: 480, selfieAt: '2026-11-02T04:00:00Z' }),
    day({ day: '2026-11-03', status: 'LATE', lateMin: 20, workedMin: 460 }),
    day({ day: '2026-11-04', status: 'LATE', halfDay: true, workedMin: 250, selfieMissing: true }),
    day({ day: '2026-11-05', status: 'ABSENT', corrected: true }),
    day({ day: '2026-11-08', status: 'DAY_OFF' }),
    day({ day: '2026-11-09', status: 'NOT_ARRIVED' }),
  ];

  it('counts each day once: a half day is not also present or late, and unfinished days are not due yet', () => {
    const r = attendanceSummaryReport(rows, objects, 100).rows[0];
    expect(r).toMatchObject({ employeeId: 'EMP-7', workingDays: 4, presentDays: 1, lateDays: 1, halfDays: 1, absentDays: 1, daysOff: 1, selfiesTaken: 1, selfiesMissing: 1, correctedDays: 1 });
  });

  it('attendance % counts a half day as half; the average is per day attended', () => {
    const r = attendanceSummaryReport(rows, objects, 100).rows[0];
    expect(r.attendancePct).toBe(62.5);
    expect(r.workedMin).toBe(1190);
    expect(r.avgWorkedMin).toBe(397);
  });

  it('nobody due: 0 %, not a division by zero', () => {
    expect(attendanceSummaryReport([day({ status: 'DAY_OFF' })], objects, 100).rows[0]).toMatchObject({ workingDays: 0, attendancePct: 0, avgWorkedMin: 0 });
  });
});

describe('attendancePayrollReport', () => {
  it('payable days = present (on time or late) + half of half days + weekly offs; LOP = absent + half of half days', () => {
    const rows = [
      day({ day: '2026-11-02', status: 'PRESENT', workedMin: 480, overtimeMin: 45 }),
      day({ day: '2026-11-03', status: 'LATE', lateMin: 20, workedMin: 460, earlyMin: 10 }),
      day({ day: '2026-11-04', status: 'LATE', halfDay: true, lateMin: 90, workedMin: 250 }),
      day({ day: '2026-11-05', status: 'ABSENT', corrected: true }),
      day({ day: '2026-11-08', status: 'DAY_OFF' }),
      day({ day: '2026-11-09', status: 'NOT_ARRIVED' }),
    ];
    const r = attendancePayrollReport(rows, objects, '2026-11-01', '2026-11-30', 100).rows[0];
    expect(r).toMatchObject({ employeeId: 'EMP-7', from: '2026-11-01', to: '2026-11-30', workingDays: 4, presentDays: 2, halfDays: 1, absentDays: 1, weeklyOffs: 1, payableDays: 3.5, lopDays: 1.5, lateDays: 2, lateMinutes: 110, earlyLeaveDays: 1, earlyLeaveMinutes: 10, workedHours: 19.83, overtimeHours: 0.75, correctedDays: 1 });
  });
});

describe('attendanceDailyReport', () => {
  it('shows a half day as the status, with location, selfie and correction in words', () => {
    const r = attendanceDailyReport([day({ status: 'LATE', halfDay: true, inFix: { lat: 13.05, lng: 80.25, accuracyM: 8 }, selfieMissing: true, corrected: true, correctionNote: 'Client visit' })], objects, 100).rows[0];
    expect(r).toMatchObject({ status: 'HALF_DAY', inLocation: '13.050000, 80.250000', outLocation: null, selfie: 'Missing', corrected: 'Yes: Client visit' });
  });

  it('totals cover every row even when the rows are cut', () => {
    const r = attendanceDailyReport([day({ workedMin: 100 }), day({ day: '2026-11-03', workedMin: 200 })], objects, 1);
    expect(r.rows).toHaveLength(1);
    expect(r).toMatchObject({ totalRows: 2, totals: { workedMin: 300 } });
  });
});

describe('attendanceOutingsReport', () => {
  it('names who decided, keeps what the employee said, and totals by kind', async () => {
    const leftAt = '2026-11-02T06:00:00.000Z';
    const prisma = {
      attendanceOuting: { findMany: jest.fn(async () => [{ objectId: 'p1', leftAt: new Date(leftAt), decidedById: 'u1' }]) },
      user: { findMany: jest.fn(async () => [{ id: 'u1', name: 'Meena' }]) },
    } as never;
    const outing = { leftAt, returnedAt: null, minutes: 45, kind: 'OFFICIAL' as const, note: 'Bank', site: 'HO', fix: { lat: 13, lng: 80, accuracyM: null }, employeeKind: 'PERSONAL' as const, employeeNote: 'Lunch', decidedByAdmin: true };
    const undecided = { ...outing, leftAt: '2026-11-02T09:00:00.000Z', minutes: 15, kind: 'UNEXPLAINED' as const, employeeKind: null, employeeNote: null, decidedByAdmin: false, note: null };
    const r = await attendanceOutingsReport(prisma, [day({ outings: [undecided, outing] })], objects, 100);
    expect(r.rows.map((x) => x.leftAt)).toEqual([leftAt, undecided.leftAt]);
    expect(r.rows[0]).toMatchObject({ decidedBy: 'Meena', employeeSaid: 'PERSONAL', employeeNote: 'Lunch', location: '13.000000, 80.000000' });
    expect(r.rows[1]).toMatchObject({ decidedBy: null, employeeSaid: '' });
    expect(r.totals).toMatchObject({ count: 2, minutes: 60, officialMin: 45, unexplainedMin: 15 });
  });
});
