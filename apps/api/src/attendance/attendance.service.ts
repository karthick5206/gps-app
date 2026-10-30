import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  attendanceOf,
  attendanceSettingsError,
  DEFAULT_ATTENDANCE,
  type AttendanceDayDto,
  type AttendanceRowDto,
  type AttendanceSettingsDto,
  type AttendanceStatus,
} from '@veetracer/shared';
import { randomUUID } from 'node:crypto';
import { allCompaniesOr, objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { NOTIFY_STREAM_MAXLEN } from '../alerts/alert-dto';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { pendingToDto } from '../processor/rules/rules-engine';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { addDays, isDayKey, localDayKey, localMidnight, zonedTimeToUtc } from '../summarizer/tz';

const JOB_LOCK = 'vt:attendance:lock';
const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const MAX_TIMESHEET_DAYS = 62;

type Settings = AttendanceSettingsDto;
interface Staff {
  id: string;
  name: string;
  plateNumber: string | null;
  branchId: string | null;
  deviceId: string | null;
  lat: number | null;
  lng: number | null;
}

/**
 * Field staff attendance from work-site geofence visits (GeofenceVisit): today's board, a timesheet, and a job that
 * raises ATTENDANCE_NOT_ARRIVED (grace over, nobody arrived) and ATTENDANCE_ABSENT (working day ended) once per person
 * per day through the normal alert pipeline.
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
    return r ? { enabled: r.enabled, geofenceIds: r.geofenceIds, objectIds: r.objectIds, days: r.days, startMin: r.startMin, endMin: r.endMin, graceMin: r.graceMin } : { ...DEFAULT_ATTENDANCE };
  }

  async saveSettings(ctx: AuthContext, s: Settings): Promise<Settings> {
    const error = attendanceSettingsError(s);
    if (error) throw new BadRequestException(error);
    const before = await this.settings(ctx.companyId);
    const data = { enabled: s.enabled, geofenceIds: [...new Set(s.geofenceIds)], objectIds: [...new Set(s.objectIds)], days: [...new Set(s.days)].sort(), startMin: s.startMin, endMin: s.endMin, graceMin: s.graceMin, updatedById: ctx.userId };
    await this.prisma.attendanceSettings.upsert({ where: { companyId: ctx.companyId }, create: { companyId: ctx.companyId, ...data }, update: data });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'AttendanceSettings', entityId: ctx.companyId, before: { ...before }, after: { ...data } });
    return this.settings(ctx.companyId);
  }

  private async tz(companyId: string): Promise<string> {
    return (await this.prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } }))?.timezone ?? 'Asia/Kolkata';
  }

  /** Staff covered: the chosen people, else every active person (phone / ID card) — limited to the caller's scope. */
  private async staff(companyId: string, s: Settings, ctx?: AuthContext): Promise<Staff[]> {
    const rows = await this.prisma.trackedObject.findMany({
      where: { AND: [ctx ? allCompaniesOr(ctx, objectScopeWhere(ctx)) : {}, { companyId, isActive: true }, s.objectIds.length ? { id: { in: s.objectIds } } : { type: 'PERSON' }] },
      select: { id: true, name: true, plateNumber: true, branchId: true, assignments: { where: { toTime: null }, take: 1, select: { deviceId: true } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((o) => ({ id: o.id, name: o.name, plateNumber: o.plateNumber, branchId: o.branchId, deviceId: o.assignments[0]?.deviceId ?? null, lat: null, lng: null }));
  }

  /** Attendance of every staff member for one local day. */
  private async compute(companyId: string, s: Settings, staff: Staff[], day: string, tz: string, now: number): Promise<AttendanceRowDto[]> {
    const dayStart = localMidnight(day, tz);
    const dayEnd = localMidnight(addDays(day, 1), tz);
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    const w = {
      workingDay: s.days.includes(dow),
      dayStart,
      dayEnd,
      start: zonedTimeToUtc(day, Math.floor(s.startMin / 60), s.startMin % 60, tz),
      grace: zonedTimeToUtc(day, Math.floor((s.startMin + s.graceMin) / 60), (s.startMin + s.graceMin) % 60, tz),
      end: zonedTimeToUtc(day, Math.floor(s.endMin / 60), s.endMin % 60, tz),
    };
    const [visits, sites] = await Promise.all([
      s.geofenceIds.length && staff.length
        ? this.prisma.geofenceVisit.findMany({
            where: { companyId, objectId: { in: staff.map((x) => x.id) }, geofenceId: { in: s.geofenceIds }, enterTime: { lt: new Date(dayEnd) }, OR: [{ exitTime: null }, { exitTime: { gt: new Date(dayStart) } }] },
            select: { objectId: true, geofenceId: true, enterTime: true, exitTime: true },
          })
        : [],
      this.prisma.geofence.findMany({ where: { id: { in: s.geofenceIds } }, select: { id: true, name: true } }),
    ]);
    const siteName = new Map(sites.map((g) => [g.id, g.name]));
    return staff.map((p) => {
      const mine = visits.filter((v) => v.objectId === p.id).map((v) => ({ enter: v.enterTime.getTime(), exit: v.exitTime?.getTime() ?? null, site: siteName.get(v.geofenceId) ?? '' }));
      const r = attendanceOf(mine, w, now);
      return {
        objectId: p.id,
        name: p.plateNumber && p.plateNumber !== p.name ? `${p.name} (${p.plateNumber})` : p.name,
        day,
        status: r.status,
        firstIn: r.firstIn ? new Date(r.firstIn).toISOString() : null,
        lastOut: r.lastOut ? new Date(r.lastOut).toISOString() : null,
        onSiteMin: r.onSiteMin,
        site: r.site,
        lateMin: r.lateMin,
      };
    });
  }

  async day(ctx: AuthContext, dayParam?: string, now = Date.now()): Promise<AttendanceDayDto> {
    const s = await this.settings(ctx.companyId);
    const tz = await this.tz(ctx.companyId);
    const day = dayParam && isDayKey(dayParam) ? dayParam : localDayKey(now, tz);
    const rows = s.enabled ? await this.compute(ctx.companyId, s, await this.staff(ctx.companyId, s, ctx), day, tz, now) : [];
    const counts = { PRESENT: 0, LATE: 0, NOT_ARRIVED: 0, ABSENT: 0, DAY_OFF: 0, UPCOMING: 0 } as Record<AttendanceStatus, number>;
    for (const r of rows) counts[r.status]++;
    return { day, enabled: s.enabled, workingDay: s.days.includes(new Date(`${day}T12:00:00Z`).getUTCDay()), rows, counts };
  }

  /** Timesheet rows (person × day) for a date range (at most 62 days). */
  async timesheet(ctx: AuthContext, from: string, to: string, now = Date.now()): Promise<AttendanceRowDto[]> {
    if (!isDayKey(from) || !isDayKey(to) || from > to) throw new BadRequestException('Choose a valid date range');
    const s = await this.settings(ctx.companyId);
    if (!s.enabled) return [];
    const tz = await this.tz(ctx.companyId);
    const staff = await this.staff(ctx.companyId, s, ctx);
    const out: AttendanceRowDto[] = [];
    for (let d = from, n = 0; d <= to && n < MAX_TIMESHEET_DAYS; d = addDays(d, 1), n++) out.push(...(await this.compute(ctx.companyId, s, staff, d, tz, now)));
    return out;
  }

  // ───────────── alerts job ─────────────

  @Interval(5 * 60_000)
  async tick(): Promise<void> {
    if (this.running || (process.env.ATTENDANCE_JOB ?? 'on').toLowerCase() === 'off') return;
    this.running = true;
    let locked = false;
    try {
      locked = (await this.redis.client.set(JOB_LOCK, this.instance, 'PX', 4 * 60_000, 'NX')) === 'OK';
      if (locked) await this.run(Date.now());
    } catch (error) {
      this.logger.error(`Attendance job failed: ${(error as Error).message}`);
    } finally {
      if (locked) await this.redis.client.eval(RELEASE_LOCK, 1, JOB_LOCK, this.instance).catch(() => undefined);
      this.running = false;
    }
  }

  /** Raises "not arrived" after the grace period and "absent" after the working day, once per person per day. */
  async run(now: number): Promise<number> {
    const companies = await this.prisma.attendanceSettings.findMany({ where: { enabled: true }, select: { companyId: true } });
    let raised = 0;
    for (const { companyId } of companies) {
      const s = await this.settings(companyId);
      const tz = await this.tz(companyId);
      const day = localDayKey(now, tz);
      const staff = await this.staff(companyId, s);
      const rows = await this.compute(companyId, s, staff, day, tz, now);
      for (const r of rows) {
        const type = r.status === 'NOT_ARRIVED' ? 'ATTENDANCE_NOT_ARRIVED' : r.status === 'ABSENT' ? 'ATTENDANCE_ABSENT' : null;
        if (!type) continue;
        const claimed = await this.redis.client.set(`vt:attendance:${type}:${r.objectId}:${day}`, '1', 'EX', 2 * 86_400, 'NX');
        if (claimed !== 'OK') continue;
        const p = staff.find((x) => x.id === r.objectId)!;
        await this.raise(companyId, p, type, type === 'ATTENDANCE_ABSENT' ? 'Did not come to any work site today' : `Not at a work site ${s.graceMin} min after the start time`, now);
        raised++;
      }
    }
    if (raised) this.logger.log(`Attendance: ${raised} alert(s) raised`);
    return raised;
  }

  private async raise(companyId: string, p: Staff, type: 'ATTENDANCE_NOT_ARRIVED' | 'ATTENDANCE_ABSENT', message: string, now: number): Promise<void> {
    const id = randomUUID();
    await this.prisma.alert.create({ data: { id, companyId, objectId: p.id, deviceId: p.deviceId, type, severity: 'WARNING', message, data: {}, occurredAt: new Date(now), ackRequired: false } });
    const dto = pendingToDto({
      id,
      type,
      severity: 'WARNING',
      message,
      occurredAt: now,
      lat: null,
      lng: null,
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
