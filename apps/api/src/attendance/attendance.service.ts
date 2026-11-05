import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, StreamableFile } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import {
  attendanceOf,
  ATTENDANCE_SELFIE_KEEP_DAYS,
  attendanceSettingsError,
  DEFAULT_ATTENDANCE,
  phoneAttention,
  shiftOf,
  signalGaps,
  siteCountsFor,
  type AttendanceDayDto,
  type AttendanceFix,
  type AttendanceOverride,
  type AttendanceRowDto,
  type AttendanceSettingsDto,
  type AttendanceShiftDto,
  type AttendanceStatus,
  type AttendanceWindow,
  type OutingKind,
  type PhoneAttendanceDto,
  type PhoneAttention,
  type TimeSpan,
} from '@veetracer/shared';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { allCompaniesOr, objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { NOTIFY_STREAM_MAXLEN } from '../alerts/alert-dto';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { pendingToDto } from '../processor/rules/rules-engine';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { addDays, isDayKey, localDayKey, localMidnight, zonedTimeToUtc } from '../summarizer/tz';
import { APP_ROOT } from '../config/env';

const JOB_LOCK = 'vt:attendance:lock';
const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const MAX_TIMESHEET_DAYS = 62;
/** Finished days are saved hourly and refreshed this long, so phones that upload late are still counted. */
const SAVE_DAYS_BACK = 3;
const ALERT_CLAIM_SEC = 2 * 86_400;

const SELFIE_DIR = join(APP_ROOT, 'var', 'selfies');
const SELFIE_MAX_BYTES = 8 * 1024 * 1024;
const SELFIE_TYPES: Record<string, { ext: string; sig: (b: Buffer) => boolean }> = {
  'image/jpeg': { ext: 'jpg', sig: (b) => b[0] === 0xff && b[1] === 0xd8 },
  'image/png': { ext: 'png', sig: (b) => b.subarray(0, 4).toString('hex') === '89504e47' },
  'image/webp': { ext: 'webp', sig: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
};
const OFF: PhoneAttendanceDto = { enabled: false, firstIn: null, state: null, site: null, outings: [], selfieNeeded: false, selfieAt: null };

type Settings = AttendanceSettingsDto;
interface Staff {
  id: string;
  name: string;
  plateNumber: string | null;
  branchId: string | null;
  deviceId: string | null;
}

/** The shift and limits a person's day is worked out with; saved with the day. */
interface DayRules {
  shift: string;
  days: number[];
  startMin: number;
  endMin: number;
  graceMin: number;
  shortExitMin: number;
  noSignalMin: number;
  halfDayMin: number;
  fullDayMin: number;
}

interface SavedDay {
  objectId: string;
  row: unknown;
  rules: unknown;
  overrideStatus: string | null;
  overrideNote: string | null;
}

type AlertType = 'ATTENDANCE_NOT_ARRIVED' | 'ATTENDANCE_ABSENT' | 'ATTENDANCE_LEFT_SITE' | 'ATTENDANCE_STILL_OUT';

const rulesFor = (s: Settings, p: Pick<Staff, 'id' | 'branchId'>): DayRules => {
  const shift = shiftOf(s, p.id, p.branchId);
  return { shift: shift.name, days: shift.days, startMin: shift.startMin, endMin: shift.endMin, graceMin: s.graceMin, shortExitMin: s.shortExitMin, noSignalMin: s.noSignalMin, halfDayMin: s.halfDayMin, fullDayMin: s.fullDayMin };
};

function windowOf(r: DayRules, day: string, tz: string): AttendanceWindow {
  const at = (min: number) => zonedTimeToUtc(day, Math.floor(min / 60), min % 60, tz);
  return {
    workingDay: r.days.includes(new Date(`${day}T12:00:00Z`).getUTCDay()),
    dayStart: localMidnight(day, tz),
    dayEnd: localMidnight(addDays(day, 1), tz),
    start: at(r.startMin),
    grace: at(r.startMin + r.graceMin),
    end: at(r.endMin),
    shortExitMin: r.shortExitMin,
    halfDayMin: r.halfDayMin,
    fullDayMin: r.fullDayMin,
  };
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const fix = (lat: number | null, lng: number | null, accuracyM: number | null): AttendanceFix | null => (lat === null || lng === null ? null : { lat, lng, accuracyM });

/** A saved or computed row with the manual correction on top. */
function withOverride(row: AttendanceRowDto, saved: SavedDay | undefined): AttendanceRowDto {
  const o = saved?.overrideStatus as AttendanceOverride | null | undefined;
  const base = { ...row, corrected: false, correctionNote: null };
  if (!o) return base;
  const status: AttendanceStatus = o === 'HALF_DAY' ? 'PRESENT' : o;
  return { ...base, status, halfDay: o === 'HALF_DAY', corrected: true, correctionNote: saved?.overrideNote ?? null };
}

/**
 * Staff attendance from work-site geofence visits (GeofenceVisit): today's board, a timesheet, admin decisions on time
 * outside the site, saved days, and a job raising ATTENDANCE_NOT_ARRIVED (grace over, nobody arrived),
 * ATTENDANCE_ABSENT (working day ended), ATTENDANCE_LEFT_SITE (outside during the shift, past the short-exit limit) and
 * ATTENDANCE_STILL_OUT (still outside after the reminder time) through the normal alert pipeline, once each.
 */
@Injectable()
export class AttendanceService {
  private readonly logger = new Logger('Attendance');
  private readonly instance = randomUUID();
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  async settings(companyId: string): Promise<Settings> {
    const r = await this.prisma.attendanceSettings.findUnique({ where: { companyId } });
    if (!r) return { ...DEFAULT_ATTENDANCE };
    return {
      enabled: r.enabled,
      geofenceIds: r.geofenceIds,
      objectIds: r.objectIds,
      days: r.days,
      startMin: r.startMin,
      endMin: r.endMin,
      graceMin: r.graceMin,
      shifts: r.shifts as unknown as AttendanceShiftDto[],
      shortExitMin: r.shortExitMin,
      noSignalMin: r.noSignalMin,
      halfDayMin: r.halfDayMin,
      fullDayMin: r.fullDayMin,
      outReminderMin: r.outReminderMin,
      anyBranchObjectIds: r.anyBranchObjectIds,
      selfieRequired: r.selfieRequired,
    };
  }

  async saveSettings(ctx: AuthContext, s: Settings): Promise<Settings> {
    const error = attendanceSettingsError(s);
    if (error) throw new BadRequestException(error);
    const before = await this.settings(ctx.companyId);
    if (s.graceMin !== before.graceMin && !ctx.isSuperAdmin) throw new ForbiddenException('Only Super Admin can change the grace period');
    const shifts = s.shifts.map((x) => ({ id: x.id || randomUUID(), name: x.name.trim(), days: [...new Set(x.days)].sort(), startMin: x.startMin, endMin: x.endMin, branchIds: [...new Set(x.branchIds)], objectIds: [...new Set(x.objectIds)] }));
    const data = {
      enabled: s.enabled,
      geofenceIds: [...new Set(s.geofenceIds)],
      objectIds: [...new Set(s.objectIds)],
      days: [...new Set(s.days)].sort(),
      startMin: s.startMin,
      endMin: s.endMin,
      graceMin: s.graceMin,
      shifts: shifts as unknown as Prisma.InputJsonValue,
      shortExitMin: s.shortExitMin,
      noSignalMin: s.noSignalMin,
      halfDayMin: s.halfDayMin,
      fullDayMin: s.fullDayMin,
      outReminderMin: s.outReminderMin,
      anyBranchObjectIds: [...new Set(s.anyBranchObjectIds)],
      selfieRequired: s.selfieRequired,
      updatedById: ctx.userId,
    };
    await this.prisma.attendanceSettings.upsert({ where: { companyId: ctx.companyId }, create: { companyId: ctx.companyId, ...data }, update: data });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'AttendanceSettings', entityId: ctx.companyId, before: { ...before }, after: { ...data } });
    return this.settings(ctx.companyId);
  }

  private async tz(companyId: string): Promise<string> {
    return (await this.prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } }))?.timezone ?? 'Asia/Kolkata';
  }

  /** Staff covered: the chosen people, else every active person (phone / ID card) — limited to the caller's scope. */
  private async staff(companyId: string, s: Settings, ctx?: AuthContext, branchId?: string): Promise<Staff[]> {
    const rows = await this.prisma.trackedObject.findMany({
      where: { AND: [ctx ? allCompaniesOr(ctx, objectScopeWhere(ctx)) : {}, { companyId, isActive: true }, s.objectIds.length ? { id: { in: s.objectIds } } : { type: 'PERSON' }, branchId ? { branchId } : {}] },
      select: { id: true, name: true, plateNumber: true, branchId: true, assignments: { where: { toTime: null }, take: 1, select: { deviceId: true } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((o) => ({ id: o.id, name: o.name, plateNumber: o.plateNumber, branchId: o.branchId, deviceId: o.assignments[0]?.deviceId ?? null }));
  }

  private async savedDays(staff: Staff[], day: string): Promise<Map<string, SavedDay>> {
    if (!staff.length) return new Map();
    const rows = await this.prisma.attendanceDay.findMany({ where: { objectId: { in: staff.map((p) => p.id) }, day }, select: { objectId: true, row: true, rules: true, overrideStatus: true, overrideNote: true } });
    return new Map(rows.map((r) => [r.objectId, r]));
  }

  /**
   * Periods without phone data per person, between `from` and `to`. Fake (mock) locations don't count as data: such a
   * phone's position is unknown, and it would otherwise look inside for as long as it keeps reporting.
   */
  private async dataPauses(ids: string[], from: number, to: number, minMin: number): Promise<Map<string, { first: number | null; last: number | null; pauses: TimeSpan[] }>> {
    const out = new Map<string, { first: number | null; last: number | null; pauses: TimeSpan[] }>();
    if (!ids.length || to <= from) return out;
    const fromIso = new Date(from).toISOString();
    const toIso = new Date(to).toISOString();
    const [bounds, pauses] = await Promise.all([
      this.prisma.$queryRaw<{ id: string; first: Date; last: Date }[]>`
        SELECT "objectId"::text AS id, min("fixTime") AS first, max("fixTime") AS last FROM "Position"
        WHERE "objectId" = ANY(${ids}::text[]::uuid[]) AND "fixTime" >= ${fromIso}::text::timestamptz AND "fixTime" < ${toIso}::text::timestamptz
          AND COALESCE("attributes"->>'mock', '') <> 'true'
        GROUP BY 1`,
      this.prisma.$queryRaw<{ id: string; prev: Date; at: Date }[]>`
        SELECT id, prev, at FROM (
          SELECT "objectId"::text AS id, "fixTime" AS at, lag("fixTime") OVER (PARTITION BY "objectId" ORDER BY "fixTime") AS prev FROM "Position"
          WHERE "objectId" = ANY(${ids}::text[]::uuid[]) AND "fixTime" >= ${fromIso}::text::timestamptz AND "fixTime" < ${toIso}::text::timestamptz
            AND COALESCE("attributes"->>'mock', '') <> 'true'
        ) q WHERE at - prev >= ${minMin}::int * interval '1 minute'`,
    ]);
    for (const b of bounds) out.set(b.id, { first: b.first.getTime(), last: b.last.getTime(), pauses: [] });
    for (const p of pauses) out.get(p.id)?.pauses.push({ from: p.prev.getTime(), to: p.at.getTime() });
    return out;
  }

  /**
   * Works out the day of the given people from visits, phone data and decisions, using the rules saved with the day
   * when there are any. Without `withSignal` no-signal periods are skipped (the alert job needs no figures).
   */
  private async workOut(companyId: string, s: Settings, staff: Staff[], day: string, tz: string, now: number, saved: Map<string, SavedDay>, withSignal = true): Promise<Map<string, { row: AttendanceRowDto; rules: DayRules }>> {
    const out = new Map<string, { row: AttendanceRowDto; rules: DayRules }>();
    if (!staff.length) return out;
    const dayStart = localMidnight(day, tz);
    const dayEnd = localMidnight(addDays(day, 1), tz);
    const ids = staff.map((x) => x.id);
    const branchIds = [...new Set(staff.map((p) => p.branchId).filter((b): b is string => !!b))];
    const [visits, sites, decisions, branches, signal, selfies] = await Promise.all([
      s.geofenceIds.length
        ? this.prisma.geofenceVisit.findMany({
            where: { companyId, objectId: { in: ids }, geofenceId: { in: s.geofenceIds }, enterTime: { lt: new Date(dayEnd) }, OR: [{ exitTime: null }, { exitTime: { gt: new Date(dayStart) } }] },
            select: { objectId: true, geofenceId: true, enterTime: true, exitTime: true, enterLat: true, enterLng: true, enterAccM: true, exitLat: true, exitLng: true, exitAccM: true },
          })
        : [],
      this.prisma.geofence.findMany({ where: { id: { in: s.geofenceIds } }, select: { id: true, name: true, branchId: true } }),
      this.prisma.attendanceOuting.findMany({ where: { objectId: { in: ids }, leftAt: { gte: new Date(dayStart), lt: new Date(dayEnd) } }, select: { objectId: true, leftAt: true, kind: true, note: true, employeeKind: true, employeeNote: true, decidedById: true } }),
      branchIds.length ? this.prisma.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, name: true } }) : [],
      withSignal ? this.dataPauses(ids, dayStart, Math.min(now, dayEnd), Math.min(s.noSignalMin, ...[...saved.values()].map((x) => (x.rules as DayRules | null)?.noSignalMin ?? s.noSignalMin))) : null,
      this.prisma.attendanceSelfie.findMany({ where: { objectId: { in: ids }, day }, select: { objectId: true, takenAt: true } }),
    ]);
    const selfieAt = new Map(selfies.map((x) => [x.objectId, x.takenAt]));
    const siteOf = new Map(sites.map((g) => [g.id, g]));
    const branchName = new Map(branches.map((b) => [b.id, b.name]));
    for (const p of staff) {
      const rules = (saved.get(p.id)?.rules as DayRules | null | undefined) ?? rulesFor(s, p);
      const mine = visits
        .filter((v) => v.objectId === p.id && siteCountsFor(s, p.id, p.branchId, siteOf.get(v.geofenceId)?.branchId ?? null))
        .map((v) => ({
          enter: v.enterTime.getTime(),
          exit: v.exitTime?.getTime() ?? null,
          site: siteOf.get(v.geofenceId)?.name ?? '',
          enterFix: fix(v.enterLat, v.enterLng, v.enterAccM),
          exitFix: fix(v.exitLat, v.exitLng, v.exitAccM),
        }));
      const taken = new Map(decisions.filter((d) => d.objectId === p.id).map((d) => [d.leftAt.getTime(), { kind: d.kind as OutingKind, note: d.note, employeeKind: d.employeeKind as OutingKind | null, employeeNote: d.employeeNote, decidedByAdmin: !!d.decidedById }]));
      const mineSignal = signal?.get(p.id);
      const gaps = signal ? signalGaps(mineSignal?.pauses ?? [], mineSignal?.first ?? null, mineSignal?.last ?? null, dayStart, Math.min(now, dayEnd), rules.noSignalMin * 60_000) : [];
      const r = attendanceOf(mine, windowOf(rules, day, tz), now, gaps, taken);
      out.set(p.id, {
        rules,
        row: {
          objectId: p.id,
          name: p.plateNumber && p.plateNumber !== p.name ? `${p.name} (${p.plateNumber})` : p.name,
          day,
          status: r.status,
          halfDay: r.halfDay,
          firstIn: iso(r.firstIn),
          lastOut: iso(r.lastOut),
          onSiteMin: r.onSiteMin,
          workedMin: r.workedMin,
          officialMin: r.officialMin,
          personalMin: r.personalMin,
          unexplainedMin: r.unexplainedMin,
          noSignalMin: r.noSignalMin,
          site: r.site,
          lateMin: r.lateMin,
          earlyMin: r.earlyMin,
          overtimeMin: r.overtimeMin,
          branch: p.branchId ? (branchName.get(p.branchId) ?? null) : null,
          shift: rules.shift,
          state: r.state,
          carriedOver: r.carriedOver,
          inFix: r.inFix,
          outFix: r.outFix,
          outings: r.outings.map((o) => ({ ...o, leftAt: new Date(o.leftAt).toISOString(), returnedAt: iso(o.returnedAt) })),
          corrected: false,
          correctionNote: null,
          selfieAt: iso(selfieAt.get(p.id)?.getTime() ?? null),
          selfieMissing: s.selfieRequired && !!r.firstIn && r.status !== 'DAY_OFF' && !selfieAt.has(p.id),
        },
      });
    }
    return out;
  }

  /** Attendance of every staff member for one local day: saved figures for past days, worked out otherwise. */
  private async compute(companyId: string, s: Settings, staff: Staff[], day: string, tz: string, now: number): Promise<AttendanceRowDto[]> {
    const saved = await this.savedDays(staff, day);
    const past = day < localDayKey(now, tz);
    const fresh = await this.workOut(companyId, s, staff.filter((p) => !(past && saved.get(p.id)?.row)), day, tz, now, saved);
    return staff.map((p) => {
      const mine = saved.get(p.id);
      const row = fresh.get(p.id)?.row ?? (mine?.row as unknown as AttendanceRowDto);
      return withOverride(row, mine);
    });
  }

  async day(ctx: AuthContext, dayParam?: string, branchId?: string, now = Date.now()): Promise<AttendanceDayDto> {
    const s = await this.settings(ctx.companyId);
    const tz = await this.tz(ctx.companyId);
    const day = dayParam && isDayKey(dayParam) ? dayParam : localDayKey(now, tz);
    const rows = s.enabled ? await this.compute(ctx.companyId, s, await this.staff(ctx.companyId, s, ctx, branchId), day, tz, now) : [];
    const counts = { PRESENT: 0, LATE: 0, NOT_ARRIVED: 0, ABSENT: 0, DAY_OFF: 0, UPCOMING: 0 } as Record<AttendanceStatus, number>;
    let halfDays = 0;
    for (const r of rows) {
      if (r.halfDay) halfDays++;
      else counts[r.status]++;
    }
    return { day, enabled: s.enabled, workingDay: s.days.includes(new Date(`${day}T12:00:00Z`).getUTCDay()), rows, counts, halfDays };
  }

  /** Timesheet rows (person × day) for a date range (at most 62 days). */
  async timesheet(ctx: AuthContext, from: string, to: string, branchId?: string, now = Date.now()): Promise<AttendanceRowDto[]> {
    if (!isDayKey(from) || !isDayKey(to) || from > to) throw new BadRequestException('Choose a valid date range');
    const s = await this.settings(ctx.companyId);
    if (!s.enabled) return [];
    const tz = await this.tz(ctx.companyId);
    const staff = await this.staff(ctx.companyId, s, ctx, branchId);
    const out: AttendanceRowDto[] = [];
    for (let d = from, n = 0; d <= to && n < MAX_TIMESHEET_DAYS; d = addDays(d, 1), n++) out.push(...(await this.compute(ctx.companyId, s, staff, d, tz, now)));
    return out;
  }

  // ───────────── admin decisions ─────────────

  private async person(ctx: AuthContext, s: Settings, objectId: string): Promise<Staff> {
    const p = (await this.staff(ctx.companyId, s, ctx)).find((x) => x.id === objectId);
    if (!p) throw new NotFoundException('Staff member not found');
    return p;
  }

  private async saveDay(companyId: string, objectId: string, day: string, row: AttendanceRowDto, rules: DayRules): Promise<void> {
    const data = { row: row as unknown as Prisma.InputJsonValue, rules: rules as unknown as Prisma.InputJsonValue };
    await this.prisma.attendanceDay.upsert({ where: { objectId_day: { objectId, day } }, create: { companyId, objectId, day, ...data }, update: data });
  }

  /** Official duty / personal time for an outing; UNEXPLAINED takes the decision back. */
  async decideOuting(ctx: AuthContext, b: { objectId: string; leftAt: string; kind: OutingKind; note?: string }, now = Date.now()): Promise<AttendanceRowDto> {
    const leftAt = new Date(b.leftAt);
    if (Number.isNaN(leftAt.getTime())) throw new BadRequestException('Invalid time');
    const s = await this.settings(ctx.companyId);
    const tz = await this.tz(ctx.companyId);
    const p = await this.person(ctx, s, b.objectId);
    const day = localDayKey(leftAt.getTime(), tz);
    const saved = await this.savedDays([p], day);
    const current = (await this.workOut(ctx.companyId, s, [p], day, tz, now, saved)).get(p.id)!;
    // Past days whose visits were already removed by data retention can't be worked out again.
    if (!current.row.outings.some((o) => o.leftAt === leftAt.toISOString())) throw new BadRequestException('This outing is no longer in the tracking data');
    const note = b.note?.trim() || null;
    const key = { objectId_leftAt: { objectId: p.id, leftAt } };
    const previous = await this.prisma.attendanceOuting.findUnique({ where: key });
    // Taking back a decision with no answer from the employee leaves nothing to keep.
    if (b.kind === 'UNEXPLAINED' && !previous?.employeeKind) await this.prisma.attendanceOuting.deleteMany({ where: { objectId: p.id, leftAt } });
    else {
      const data = { kind: b.kind, note, decidedById: ctx.userId };
      await this.prisma.attendanceOuting.upsert({ where: key, create: { companyId: ctx.companyId, objectId: p.id, leftAt, ...data }, update: data });
    }
    const after = (await this.workOut(ctx.companyId, s, [p], day, tz, now, saved)).get(p.id)!;
    if (saved.get(p.id)?.row) await this.saveDay(ctx.companyId, p.id, day, after.row, after.rules);
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'AttendanceOuting', entityId: p.id, before: { leftAt: leftAt.toISOString(), kind: previous?.kind ?? 'UNEXPLAINED', note: previous?.note ?? null }, after: { leftAt: leftAt.toISOString(), kind: b.kind, note } });
    return withOverride(after.row, saved.get(p.id));
  }

  /** Corrects a day by hand; a null status takes the correction back. The figures stay as they are. */
  async correctDay(ctx: AuthContext, b: { objectId: string; day: string; status: AttendanceOverride | null; note?: string }, now = Date.now()): Promise<AttendanceRowDto> {
    if (!isDayKey(b.day)) throw new BadRequestException('Choose a valid date');
    const s = await this.settings(ctx.companyId);
    const tz = await this.tz(ctx.companyId);
    if (b.day > localDayKey(now, tz)) throw new BadRequestException('Future days cannot be corrected');
    const p = await this.person(ctx, s, b.objectId);
    const saved = await this.savedDays([p], b.day);
    const mine = saved.get(p.id);
    const note = b.note?.trim() || null;
    const data = b.status ? { overrideStatus: b.status, overrideNote: note, overrideById: ctx.userId, overrideAt: new Date(now) } : { overrideStatus: null, overrideNote: null, overrideById: null, overrideAt: null };
    await this.prisma.attendanceDay.upsert({ where: { objectId_day: { objectId: p.id, day: b.day } }, create: { companyId: ctx.companyId, objectId: p.id, day: b.day, ...data }, update: data });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'AttendanceDay', entityId: p.id, before: { day: b.day, status: mine?.overrideStatus ?? null, note: mine?.overrideNote ?? null }, after: { day: b.day, status: b.status, note } });
    return (await this.compute(ctx.companyId, s, [p], b.day, tz, now))[0];
  }

  // ───────────── the employee's phone ─────────────

  /** The person a phone tracks, when attendance covers them. */
  private async coveredPerson(deviceId: string): Promise<{ s: Settings; p: Staff; companyId: string; tz: string; day: string; now: number } | null> {
    const a = await this.prisma.deviceAssignment.findFirst({ where: { deviceId, toTime: null }, select: { object: { select: { id: true, name: true, plateNumber: true, branchId: true, companyId: true, type: true, isActive: true } } } });
    const o = a?.object;
    if (!o?.isActive) return null;
    const s = await this.settings(o.companyId);
    if (!s.enabled) return null;
    if (s.objectIds.length ? !s.objectIds.includes(o.id) : o.type !== 'PERSON') return null;
    const now = Date.now();
    const tz = await this.tz(o.companyId);
    return { s, p: { id: o.id, name: o.name, plateNumber: o.plateNumber, branchId: o.branchId, deviceId }, companyId: o.companyId, tz, day: localDayKey(now, tz), now };
  }

  private async phoneRow(c: NonNullable<Awaited<ReturnType<AttendanceService['coveredPerson']>>>): Promise<AttendanceRowDto> {
    return (await this.workOut(c.companyId, c.s, [c.p], c.day, c.tz, c.now, new Map(), false)).get(c.p.id)!.row;
  }

  /** What the employee's Tracker app shows. */
  async phoneStatus(deviceId: string): Promise<PhoneAttendanceDto> {
    const c = await this.coveredPerson(deviceId);
    if (!c) return OFF;
    const r = await this.phoneRow(c);
    if (r.status === 'DAY_OFF') return OFF;
    const shift = shiftOf(c.s, c.p.id, c.p.branchId);
    return {
      enabled: true,
      firstIn: r.firstIn,
      state: r.state,
      site: r.site,
      outings: r.outings.filter((o) => !o.employeeKind && !o.decidedByAdmin).map((o) => ({ leftAt: o.leftAt, returnedAt: o.returnedAt, minutes: o.minutes, site: o.site })).reverse(),
      selfieNeeded: !!r.selfieMissing && r.state === 'INSIDE',
      selfieAt: r.selfieAt ?? null,
      shiftStartMin: shift.startMin,
      shiftEndMin: shift.endMin,
    };
  }

  /** The notification today's state calls for, for the answer to a position upload. */
  async phoneNotice(deviceId: string): Promise<PhoneAttention | null> {
    const c = await this.coveredPerson(deviceId);
    return c ? phoneAttention(await this.phoneStatus(deviceId), c.day) : null;
  }

  /** The employee's answer about today's time outside. It counts until an admin decides otherwise. */
  async phoneAnswer(deviceId: string, b: { leftAt: string; kind: 'OFFICIAL' | 'PERSONAL'; note?: string }): Promise<PhoneAttendanceDto> {
    const leftAt = new Date(b.leftAt);
    if (Number.isNaN(leftAt.getTime())) throw new BadRequestException('Invalid time');
    const c = await this.coveredPerson(deviceId);
    if (!c) throw new NotFoundException('Attendance is off for this phone');
    const r = await this.phoneRow(c);
    if (!r.outings.some((o) => o.leftAt === leftAt.toISOString())) throw new BadRequestException('This time outside is no longer listed');
    const key = { objectId_leftAt: { objectId: c.p.id, leftAt } };
    const existing = await this.prisma.attendanceOuting.findUnique({ where: key });
    if (existing?.decidedById) throw new ConflictException('Your administrator has already decided this');
    const data = { kind: b.kind, employeeKind: b.kind, employeeNote: b.note?.trim() || null, employeeAt: new Date(c.now) };
    await this.prisma.attendanceOuting.upsert({ where: key, create: { companyId: c.companyId, objectId: c.p.id, leftAt, ...data }, update: data });
    return this.phoneStatus(deviceId);
  }

  /** Today's check-in selfie. Only while inside the work site, so it shows the person there. */
  async phoneSelfie(deviceId: string, file: { buffer: Buffer; mimetype?: string } | undefined): Promise<PhoneAttendanceDto> {
    const c = await this.coveredPerson(deviceId);
    if (!c?.s.selfieRequired) throw new BadRequestException('A selfie is not needed');
    if (!file?.buffer?.length) throw new BadRequestException('Take a photo');
    if (file.buffer.length > SELFIE_MAX_BYTES) throw new BadRequestException('The photo is larger than 8 MB');
    const mime = (file.mimetype ?? '').toLowerCase();
    const type = SELFIE_TYPES[mime];
    if (!type || !type.sig(file.buffer)) throw new BadRequestException('Upload a photo (JPEG, PNG, WebP)');
    const r = await this.phoneRow(c);
    if (r.state !== 'INSIDE') throw new BadRequestException('Take the selfie at your work site');
    const dir = join(SELFIE_DIR, c.companyId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${c.p.id}-${c.day}-${randomUUID()}.${type.ext}`);
    await writeFile(path, file.buffer);
    const key = { objectId_day: { objectId: c.p.id, day: c.day } };
    const previous = await this.prisma.attendanceSelfie.findUnique({ where: key, select: { path: true } });
    const data = { takenAt: new Date(c.now), path, type: mime };
    await this.prisma.attendanceSelfie.upsert({ where: key, create: { companyId: c.companyId, objectId: c.p.id, day: c.day, ...data }, update: data });
    if (previous) await unlink(previous.path).catch(() => undefined);
    return this.phoneStatus(deviceId);
  }

  /** The selfie of a day, for those who can see that person's attendance. */
  async selfie(ctx: AuthContext, objectId: string, day: string): Promise<StreamableFile> {
    if (!isDayKey(day)) throw new BadRequestException('Choose a valid date');
    const s = await this.settings(ctx.companyId);
    await this.person(ctx, s, objectId);
    const row = await this.prisma.attendanceSelfie.findUnique({ where: { objectId_day: { objectId, day } } });
    const info = row ? await stat(row.path).catch(() => null) : null;
    if (!row || !info) throw new NotFoundException('No selfie for this day');
    return new StreamableFile(createReadStream(row.path), { type: row.type, length: info.size, disposition: 'inline' });
  }

  /** Selfies are personal data: older ones are deleted, file and row. */
  async removeOldSelfies(now: number): Promise<number> {
    const rows = await this.prisma.attendanceSelfie.findMany({ where: { takenAt: { lt: new Date(now - ATTENDANCE_SELFIE_KEEP_DAYS * 86_400_000) } }, select: { objectId: true, day: true, path: true }, take: 500 });
    for (const r of rows) {
      await unlink(r.path).catch(() => undefined);
      await this.prisma.attendanceSelfie.delete({ where: { objectId_day: { objectId: r.objectId, day: r.day } } });
    }
    return rows.length;
  }

  // ───────────── job ─────────────

  @Interval(60_000)
  async tick(): Promise<void> {
    if (this.running || (process.env.ATTENDANCE_JOB ?? 'on').toLowerCase() === 'off') return;
    this.running = true;
    let locked = false;
    try {
      locked = (await this.redis.client.set(JOB_LOCK, this.instance, 'PX', 4 * 60_000, 'NX')) === 'OK';
      if (locked) {
        const now = Date.now();
        await this.run(now);
        // Hourly, across instances and restarts.
        const hour = Math.floor(now / 3_600_000);
        if ((await this.redis.client.set(`vt:attendance:saved:${hour}`, '1', 'EX', 7200, 'NX')) === 'OK') {
          await this.saveFinishedDays(now);
          await this.removeOldSelfies(now);
        }
      }
    } catch (error) {
      this.logger.error(`Attendance job failed: ${(error as Error).message}`);
    } finally {
      if (locked) await this.redis.client.eval(RELEASE_LOCK, 1, JOB_LOCK, this.instance).catch(() => undefined);
      this.running = false;
    }
  }

  /** Saves the figures of the last few finished days with the rules that applied. */
  async saveFinishedDays(now: number): Promise<number> {
    const companies = await this.prisma.attendanceSettings.findMany({ where: { enabled: true }, select: { companyId: true } });
    let saved = 0;
    for (const { companyId } of companies) {
      const s = await this.settings(companyId);
      const tz = await this.tz(companyId);
      const staff = await this.staff(companyId, s);
      const today = localDayKey(now, tz);
      for (let back = 1; back <= SAVE_DAYS_BACK; back++) {
        const day = addDays(today, -back);
        const rows = await this.workOut(companyId, s, staff, day, tz, now, await this.savedDays(staff, day));
        for (const [objectId, { row, rules }] of rows) {
          await this.saveDay(companyId, objectId, day, row, rules);
          saved++;
        }
      }
    }
    return saved;
  }

  /** Raises the attendance alerts of the running day, once per person per day (per outing for those about leaving). */
  async run(now: number): Promise<number> {
    const companies = await this.prisma.attendanceSettings.findMany({ where: { enabled: true }, select: { companyId: true } });
    let raised = 0;
    for (const { companyId } of companies) {
      const s = await this.settings(companyId);
      const tz = await this.tz(companyId);
      const day = localDayKey(now, tz);
      const staff = await this.staff(companyId, s);
      const rows = await this.workOut(companyId, s, staff, day, tz, now, await this.savedDays(staff, day), false);
      const clock = new Intl.DateTimeFormat('en-IN', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
      for (const p of staff) {
        const r = rows.get(p.id)?.row;
        if (!r) continue;
        const claim = async (key: string) => (await this.redis.client.set(key, '1', 'EX', ALERT_CLAIM_SEC, 'NX')) === 'OK';
        if (r.status === 'NOT_ARRIVED' || (r.status === 'ABSENT' && !r.firstIn)) {
          const type = r.status === 'NOT_ARRIVED' ? 'ATTENDANCE_NOT_ARRIVED' : 'ATTENDANCE_ABSENT';
          if (!(await claim(`vt:attendance:${type}:${r.objectId}:${day}`))) continue;
          await this.raise(companyId, p, type, type === 'ATTENDANCE_ABSENT' ? 'Did not come to any work site today' : `Not at a work site ${s.graceMin} min after the start time`, now, null);
          raised++;
          continue;
        }
        // Time outside only matters on a working day while the shift runs, and not once it is approved.
        const out = r.outings[r.outings.length - 1];
        if (r.status === 'DAY_OFF' || r.state !== 'OUT' || !out || out.returnedAt !== null || out.kind === 'OFFICIAL') continue;
        const left = clock.format(new Date(out.leftAt));
        const where = out.site ?? 'the work site';
        if (await claim(`vt:attendance:ATTENDANCE_LEFT_SITE:${r.objectId}:${out.leftAt}`)) {
          await this.raise(companyId, p, 'ATTENDANCE_LEFT_SITE', `Left ${where} at ${left} during the shift`, now, out.fix);
          raised++;
        }
        if (s.outReminderMin > 0 && out.kind === 'UNEXPLAINED' && out.minutes >= s.outReminderMin && (await claim(`vt:attendance:ATTENDANCE_STILL_OUT:${r.objectId}:${out.leftAt}`))) {
          await this.raise(companyId, p, 'ATTENDANCE_STILL_OUT', `Still away from ${where} since ${left} (${out.minutes} min)`, now, out.fix);
          raised++;
        }
      }
    }
    if (raised) this.logger.log(`Attendance: ${raised} alert(s) raised`);
    return raised;
  }

  private async raise(companyId: string, p: Staff, type: AlertType, message: string, now: number, at: AttendanceFix | null): Promise<void> {
    const id = randomUUID();
    const lat = at?.lat ?? null;
    const lng = at?.lng ?? null;
    await this.prisma.alert.create({ data: { id, companyId, objectId: p.id, deviceId: p.deviceId, type, severity: 'WARNING', message, lat, lng, data: {}, occurredAt: new Date(now), ackRequired: false } });
    const dto = pendingToDto({
      id,
      type,
      severity: 'WARNING',
      message,
      occurredAt: now,
      lat,
      lng,
      geofenceId: null,
      geofenceName: null,
      data: {},
      ackRequired: false,
      object: { objectId: p.id, companyId, branchId: p.branchId, name: p.name, plateNumber: p.plateNumber, deviceId: p.deviceId, speedLimitKph: null },
    });
    await this.redis.client
      .pipeline()
      .publish(RedisKeys.alertsChannel, JSON.stringify({ companyId, alert: dto }))
      .xadd(RedisKeys.notifyStream, 'MAXLEN', '~', NOTIFY_STREAM_MAXLEN, '*', 'alertId', id, 'companyId', companyId)
      .exec();
  }
}
