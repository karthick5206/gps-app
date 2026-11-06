import { PrismaClient } from '@prisma/client';
import type { AttendanceRowDto, OutingKind } from '@veetracer/shared';
import { ObjInfo } from './report-queries';

export interface AttendanceDailyRow {
  objectId: string;
  name: string;
  employeeId: string | null;
  branch: string | null;
  day: string;
  shift: string;
  status: string;
  firstIn: string | null;
  lastOut: string | null;
  workedMin: number;
  onSiteMin: number;
  officialMin: number;
  personalMin: number;
  unexplainedMin: number;
  noSignalMin: number;
  lateMin: number;
  earlyMin: number;
  overtimeMin: number;
  site: string | null;
  inLocation: string | null;
  outLocation: string | null;
  selfie: string;
  selfieLocation: string | null;
  video: string;
  corrected: string;
}

export interface AttendanceSummaryRow {
  objectId: string;
  name: string;
  employeeId: string | null;
  branch: string | null;
  workingDays: number;
  presentDays: number;
  lateDays: number;
  halfDays: number;
  absentDays: number;
  daysOff: number;
  attendancePct: number;
  workedMin: number;
  avgWorkedMin: number;
  officialMin: number;
  personalMin: number;
  unexplainedMin: number;
  noSignalMin: number;
  lateMin: number;
  earlyMin: number;
  overtimeMin: number;
  selfiesTaken: number;
  selfiesMissing: number;
  correctedDays: number;
}

export interface AttendanceOutingRow {
  objectId: string;
  name: string;
  employeeId: string | null;
  branch: string | null;
  day: string;
  site: string | null;
  leftAt: string;
  returnedAt: string | null;
  minutes: number;
  kind: OutingKind;
  employeeSaid: string;
  employeeNote: string | null;
  decidedBy: string | null;
  note: string | null;
  location: string | null;
}

export interface AttendanceCorrectionRow {
  objectId: string;
  name: string;
  employeeId: string | null;
  branch: string | null;
  day: string;
  calculated: string;
  correctedTo: string;
  note: string | null;
  correctedBy: string | null;
  correctedAt: string | null;
}

type Report<R> = { rows: R[]; totals: Record<string, number>; totalRows: number };

const coords = (f: { lat: number; lng: number } | null | undefined) => (f ? `${f.lat.toFixed(6)}, ${f.lng.toFixed(6)}` : null);
/** A half day is a flag next to the status (see AttendanceRowDto.halfDay); a report shows it as the status. */
const statusOf = (r: Pick<AttendanceRowDto, 'status' | 'halfDay'>) => (r.halfDay ? 'HALF_DAY' : r.status);
const sum = <T>(rows: T[], f: (r: T) => number) => rows.reduce((n, r) => n + f(r), 0);
const byNameThenDay = (a: { name: string; day: string }, b: { name: string; day: string }) => a.name.localeCompare(b.name) || a.day.localeCompare(b.day);

const who = (objects: Map<string, ObjInfo>, id: string) => ({ employeeId: objects.get(id)?.plateNumber ?? null });

export function attendanceDailyReport(rows: AttendanceRowDto[], objects: Map<string, ObjInfo>, maxRows: number): Report<AttendanceDailyRow> {
  const all: AttendanceDailyRow[] = rows.map((r) => ({
    objectId: r.objectId,
    name: r.name,
    ...who(objects, r.objectId),
    branch: r.branch,
    day: r.day,
    shift: r.shift,
    status: statusOf(r),
    firstIn: r.firstIn,
    lastOut: r.lastOut,
    workedMin: r.workedMin,
    onSiteMin: r.onSiteMin,
    officialMin: r.officialMin,
    personalMin: r.personalMin,
    unexplainedMin: r.unexplainedMin,
    noSignalMin: r.noSignalMin,
    lateMin: r.lateMin,
    earlyMin: r.earlyMin,
    overtimeMin: r.overtimeMin,
    site: r.site,
    inLocation: coords(r.inFix),
    outLocation: coords(r.outFix),
    selfie: r.selfieAt ? 'Taken' : r.selfieMissing ? 'Missing' : '',
    selfieLocation: coords(r.selfieFix),
    video: r.videoAt ? 'Recorded' : r.videoMissing ? 'Missing' : '',
    corrected: r.corrected ? `Yes${r.correctionNote ? `: ${r.correctionNote}` : ''}` : '',
  }));
  all.sort(byNameThenDay);
  const totals = {
    count: all.length,
    workedMin: sum(all, (r) => r.workedMin),
    onSiteMin: sum(all, (r) => r.onSiteMin),
    officialMin: sum(all, (r) => r.officialMin),
    personalMin: sum(all, (r) => r.personalMin),
    unexplainedMin: sum(all, (r) => r.unexplainedMin),
    noSignalMin: sum(all, (r) => r.noSignalMin),
    lateMin: sum(all, (r) => r.lateMin),
    earlyMin: sum(all, (r) => r.earlyMin),
    overtimeMin: sum(all, (r) => r.overtimeMin),
  };
  return { rows: all.slice(0, maxRows), totals, totalRows: all.length };
}

/**
 * One line per person for the period. Today's unfinished states (upcoming, not arrived) aren't counted yet.
 * Attendance % counts a half day as half, over the days the person was due: present, late, half day and absent.
 */
export function attendanceSummaryReport(rows: AttendanceRowDto[], objects: Map<string, ObjInfo>, maxRows: number): Report<AttendanceSummaryRow> {
  const people = new Map<string, AttendanceRowDto[]>();
  for (const r of rows) people.set(r.objectId, [...(people.get(r.objectId) ?? []), r]);
  const all: AttendanceSummaryRow[] = [...people.entries()].map(([objectId, days]) => {
    const whole = (s: string) => days.filter((d) => !d.halfDay && d.status === s).length;
    const presentDays = whole('PRESENT');
    const lateDays = whole('LATE');
    const halfDays = days.filter((d) => d.halfDay).length;
    const absentDays = whole('ABSENT');
    const workingDays = presentDays + lateDays + halfDays + absentDays;
    const workedMin = sum(days, (d) => d.workedMin);
    const attended = presentDays + lateDays + halfDays;
    return {
      objectId,
      name: days[0].name,
      ...who(objects, objectId),
      branch: days[0].branch,
      workingDays,
      presentDays,
      lateDays,
      halfDays,
      absentDays,
      daysOff: whole('DAY_OFF'),
      attendancePct: workingDays ? Math.round(((presentDays + lateDays + halfDays / 2) / workingDays) * 1000) / 10 : 0,
      workedMin,
      avgWorkedMin: attended ? Math.round(workedMin / attended) : 0,
      officialMin: sum(days, (d) => d.officialMin),
      personalMin: sum(days, (d) => d.personalMin),
      unexplainedMin: sum(days, (d) => d.unexplainedMin),
      noSignalMin: sum(days, (d) => d.noSignalMin),
      lateMin: sum(days, (d) => d.lateMin),
      earlyMin: sum(days, (d) => d.earlyMin),
      overtimeMin: sum(days, (d) => d.overtimeMin),
      selfiesTaken: days.filter((d) => d.selfieAt).length,
      selfiesMissing: days.filter((d) => d.selfieMissing).length,
      correctedDays: days.filter((d) => d.corrected).length,
    };
  });
  all.sort((a, b) => a.name.localeCompare(b.name));
  const totals = {
    count: all.length,
    workingDays: sum(all, (r) => r.workingDays),
    presentDays: sum(all, (r) => r.presentDays),
    lateDays: sum(all, (r) => r.lateDays),
    halfDays: sum(all, (r) => r.halfDays),
    absentDays: sum(all, (r) => r.absentDays),
    daysOff: sum(all, (r) => r.daysOff),
    workedMin: sum(all, (r) => r.workedMin),
    officialMin: sum(all, (r) => r.officialMin),
    personalMin: sum(all, (r) => r.personalMin),
    unexplainedMin: sum(all, (r) => r.unexplainedMin),
    noSignalMin: sum(all, (r) => r.noSignalMin),
    lateMin: sum(all, (r) => r.lateMin),
    earlyMin: sum(all, (r) => r.earlyMin),
    overtimeMin: sum(all, (r) => r.overtimeMin),
    selfiesTaken: sum(all, (r) => r.selfiesTaken),
    selfiesMissing: sum(all, (r) => r.selfiesMissing),
    correctedDays: sum(all, (r) => r.correctedDays),
  };
  return { rows: all.slice(0, maxRows), totals, totalRows: all.length };
}

async function userNames(prisma: PrismaClient, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

/** Every time outside during a shift: how long, what it counts as, what the employee said, who decided. */
export async function attendanceOutingsReport(prisma: PrismaClient, rows: AttendanceRowDto[], objects: Map<string, ObjInfo>, maxRows: number): Promise<Report<AttendanceOutingRow>> {
  const withOutings = rows.filter((r) => r.outings.length);
  const decisions = withOutings.length
    ? await prisma.attendanceOuting.findMany({
        where: { objectId: { in: [...new Set(withOutings.map((r) => r.objectId))] }, decidedById: { not: null } },
        select: { objectId: true, leftAt: true, decidedById: true },
      })
    : [];
  const names = await userNames(prisma, decisions.map((d) => d.decidedById));
  const decidedBy = new Map(decisions.map((d) => [`${d.objectId}:${d.leftAt.toISOString()}`, names.get(d.decidedById!) ?? null]));
  const all: AttendanceOutingRow[] = withOutings.flatMap((r) =>
    r.outings.map((o) => ({
      objectId: r.objectId,
      name: r.name,
      ...who(objects, r.objectId),
      branch: r.branch,
      day: r.day,
      site: o.site,
      leftAt: o.leftAt,
      returnedAt: o.returnedAt,
      minutes: o.minutes,
      kind: o.kind,
      employeeSaid: o.employeeKind ?? '',
      employeeNote: o.employeeNote ?? null,
      decidedBy: o.decidedByAdmin ? (decidedBy.get(`${r.objectId}:${new Date(o.leftAt).toISOString()}`) ?? '') : null,
      note: o.note,
      location: coords(o.fix),
    })),
  );
  all.sort((a, b) => byNameThenDay(a, b) || a.leftAt.localeCompare(b.leftAt));
  const of = (k: OutingKind) => sum(all.filter((r) => r.kind === k), (r) => r.minutes);
  const totals = { count: all.length, minutes: sum(all, (r) => r.minutes), officialMin: of('OFFICIAL'), personalMin: of('PERSONAL'), unexplainedMin: of('UNEXPLAINED') };
  return { rows: all.slice(0, maxRows), totals, totalRows: all.length };
}

/** Days changed by hand: what was calculated, what it became, who changed it and why. */
export async function attendanceCorrectionsReport(prisma: PrismaClient, companyId: string, objects: Map<string, ObjInfo>, from: string, to: string, maxRows: number): Promise<Report<AttendanceCorrectionRow>> {
  const days = await prisma.attendanceDay.findMany({
    where: { companyId, objectId: { in: [...objects.keys()] }, day: { gte: from, lte: to }, overrideStatus: { not: null } },
    select: { objectId: true, day: true, row: true, overrideStatus: true, overrideNote: true, overrideById: true, overrideAt: true },
  });
  const names = await userNames(prisma, days.map((d) => d.overrideById));
  const all: AttendanceCorrectionRow[] = days.map((d) => {
    const saved = d.row as unknown as Pick<AttendanceRowDto, 'status' | 'halfDay'> | null;
    return {
      objectId: d.objectId,
      name: objects.get(d.objectId)?.name ?? '',
      ...who(objects, d.objectId),
      branch: objects.get(d.objectId)?.branchName ?? null,
      day: d.day,
      calculated: saved ? statusOf(saved) : '',
      correctedTo: d.overrideStatus!,
      note: d.overrideNote,
      correctedBy: d.overrideById ? (names.get(d.overrideById) ?? null) : null,
      correctedAt: d.overrideAt?.toISOString() ?? null,
    };
  });
  all.sort(byNameThenDay);
  return { rows: all.slice(0, maxRows), totals: { count: all.length }, totalRows: all.length };
}
