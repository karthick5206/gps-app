import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  TRANSPORT_E3_LIMITS,
  type CreateTransportSchedulesResult,
  type TransportScheduleDto,
  type TransportScheduleExceptionDto,
  type TransportSchedulePreviewDto,
  type TransportShiftDto,
} from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { iso } from '../../common/dto';
import { CsvSpec, ListSpec, listResult, planList } from '../../common/list-query';
import { PrismaService } from '../../prisma/prisma.service';
import { isValidTimezone } from '../../summarizer/tz';
import { activeRoutingConsents } from '../people/people.service';
import { BookingGeneratorService, overrideOf, SCHEDULE_ARCHIVED_REASON, SKIPPED_REASON, UNSEATED_STATUSES } from './booking-generator.service';
import { conflict, dateOnly, dayKeyOf, forbidden, inProfileBranch, invalid, isUniqueViolation, notFound, parseInstant, profileBranchWhere, round, serviceDate, versionConflict } from './e3-common';
import { preciseFor, SHIFT_INCLUDE, toShiftDto } from './e3-mapping';
import { CreateExceptionDto, CreateSchedulesDto, CreateShiftDto, ScheduleListQuery, SchedulePreviewQuery, ShiftListQuery, UpdateScheduleDto, UpdateShiftDto } from './e3.dto';

export const SHIFT_ENTITY = 'TransportShift';
export const SCHEDULE_ENTITY = 'TransportSchedule';
const H = 3_600_000;

const SHIFT_LIST: ListSpec = { search: ['name'], sort: { name: 'name', startMin: 'startMin', createdAt: 'createdAt' }, defaultSort: 'name' };
const SHIFT_CSV: CsvSpec<TransportShiftDto> = {
  name: 'transport-shifts',
  columns: [
    { header: 'Name', value: (s) => s.name },
    { header: 'Site', value: (s) => s.site?.name ?? '' },
    { header: 'Login', value: (s) => hhmm(s.startMin) },
    { header: 'Logout', value: (s) => hhmm(s.endMin) },
    { header: 'Overnight', value: (s) => (s.overnight ? 'yes' : 'no') },
    { header: 'Days', value: (s) => s.days.join(' ') },
    { header: 'Time zone', value: (s) => s.timeZone },
    { header: 'Active', value: (s) => (s.isActive ? 'yes' : 'no') },
    { header: 'Schedules', value: (s) => s.scheduleCount },
  ],
};
const SCHEDULE_LIST: ListSpec = {
  search: (q) => ({ OR: [{ profile: { displayName: { contains: q, mode: 'insensitive' } } }, { profile: { employeeCode: { contains: q, mode: 'insensitive' } } }] }),
  sort: { createdAt: 'createdAt', validFrom: 'validFrom', passenger: 'profile.displayName' },
  defaultSort: 'createdAt',
  defaultOrder: 'desc',
};
const SCHEDULE_CSV: CsvSpec<TransportScheduleDto> = {
  name: 'transport-schedules',
  columns: [
    { header: 'Employee code', value: (s) => s.passenger.employeeCode },
    { header: 'Name', value: (s) => s.passenger.displayName },
    { header: 'Shift', value: (s) => s.shiftName },
    { header: 'Direction', value: (s) => s.direction },
    { header: 'Days', value: (s) => s.days.join(' ') },
    { header: 'Pickup', value: (s) => s.pickupMode },
    { header: 'Stop', value: (s) => s.stop?.name ?? '' },
    { header: 'Valid from', value: (s) => s.validFrom },
    { header: 'Valid to', value: (s) => s.validTo ?? '' },
    { header: 'Active', value: (s) => (s.isActive ? 'yes' : 'no') },
    { header: 'Needs location', value: (s) => (s.needsLocation ? 'yes' : 'no') },
  ],
};

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const sortedDays = (d: number[]) => [...new Set(d)].sort((a, b) => a - b);

const SCHEDULE_INCLUDE = {
  profile: { select: { id: true, displayName: true, employeeCode: true, branchId: true, homeLat: true, homeLng: true, defaultStopPoiId: true } },
  shift: { select: { name: true, timeZone: true, days: true } },
  stopPoi: { select: { id: true, name: true, lat: true, lng: true } },
} satisfies Prisma.TransportScheduleInclude;
type ScheduleRow = Prisma.TransportScheduleGetPayload<{ include: typeof SCHEDULE_INCLUDE }>;

/**
 * Shifts and recurring schedules (05 §2.4, 15 §5.1–5.3; 12 WP 3.2). Customer-owned rows of the caller's own company;
 * schedules of ASSIGNED (site / branch) users are limited to passengers of their branches. Every write is audited in
 * its transaction. Saving a schedule generates its bookings for the next 72 h at once and re-times the future
 * unseated ones (BookingGeneratorService.resync); seated bookings are never moved by a schedule edit.
 */
@Injectable()
export class SchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly generator: BookingGeneratorService,
  ) {}

  // ───────────────────────────── Shifts ─────────────────────────────

  async listShifts(ctx: AuthContext, q: ShiftListQuery) {
    const plan = planList<Prisma.TransportShiftWhereInput, Prisma.TransportShiftOrderByWithRelationInput>(q, SHIFT_LIST);
    const where: Prisma.TransportShiftWhereInput = { AND: [{ companyId: ctx.companyId }, plan.where, ...(q.siteId ? [{ sitePoiId: q.siteId }] : [])] };
    const [rows, total] = await Promise.all([
      this.prisma.transportShift.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: SHIFT_INCLUDE }),
      this.prisma.transportShift.count({ where }),
    ]);
    return listResult(plan, rows.map(toShiftDto), total, SHIFT_CSV);
  }

  async createShift(ctx: AuthContext, dto: CreateShiftDto): Promise<TransportShiftDto> {
    const data = await this.shiftData(ctx, dto, null);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.transportShift
        .create({ data: { ...(data as Prisma.TransportShiftUncheckedCreateInput), companyId: ctx.companyId, createdById: ctx.userId }, include: SHIFT_INCLUDE })
        .catch((e: unknown) => {
          throw isUniqueViolation(e) ? invalid('A shift with this name already exists') : e;
        });
      await this.audit.record(ctx, { action: 'CREATE', entity: SHIFT_ENTITY, entityId: created.id, after: shiftSnapshot(created) }, tx);
      return created;
    });
    return toShiftDto(row);
  }

  async updateShift(ctx: AuthContext, id: string, dto: UpdateShiftDto): Promise<TransportShiftDto> {
    const before = await this.findShift(ctx, id);
    const data = await this.shiftData(ctx, dto, before);
    const row = await this.prisma.$transaction(async (tx) => {
      const after = await tx.transportShift.update({ where: { id }, data, include: SHIFT_INCLUDE }).catch((e: unknown) => {
        throw isUniqueViolation(e) ? invalid('A shift with this name already exists') : e;
      });
      await this.audit.record(ctx, { action: 'UPDATE', entity: SHIFT_ENTITY, entityId: id, before: shiftSnapshot(before), after: shiftSnapshot(after) }, tx);
      return after;
    });
    if (dto.startMin !== undefined || dto.endMin !== undefined || dto.days !== undefined || dto.timeZone !== undefined || dto.sitePoiId !== undefined || dto.isActive !== undefined) {
      await this.resyncSchedules((await this.prisma.transportSchedule.findMany({ where: { shiftId: id, companyId: ctx.companyId }, select: { id: true } })).map((s) => s.id));
    }
    return toShiftDto(row);
  }

  /** Archive (never delete: schedules reference it with Restrict). Future unseated bookings of its schedules are cancelled. */
  async archiveShift(ctx: AuthContext, id: string): Promise<TransportShiftDto> {
    return this.updateShift(ctx, id, { isActive: false });
  }

  private async findShift(ctx: AuthContext, id: string) {
    const row = await this.prisma.transportShift.findFirst({ where: { id, companyId: ctx.companyId }, include: SHIFT_INCLUDE });
    if (!row) throw notFound();
    return row;
  }

  private async shiftData(ctx: AuthContext, dto: CreateShiftDto | UpdateShiftDto, before: { startMin: number; endMin: number; timeZone: string } | null): Promise<Prisma.TransportShiftUncheckedUpdateInput> {
    const data: Prisma.TransportShiftUncheckedUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.days !== undefined) data.days = sortedDays(dto.days);
    if (dto.sitePoiId !== undefined) data.sitePoiId = dto.sitePoiId ? await this.ownPlace(ctx, dto.sitePoiId) : null;
    if ('isActive' in dto && dto.isActive !== undefined) data.isActive = dto.isActive;
    const startMin = dto.startMin ?? before?.startMin;
    const endMin = dto.endMin ?? before?.endMin;
    if (startMin === undefined || endMin === undefined) throw invalid('Give the login and logout times');
    if (startMin === endMin) throw invalid('Login and logout cannot be the same time');
    if (dto.startMin !== undefined || dto.endMin !== undefined || !before) {
      data.startMin = startMin;
      data.endMin = endMin;
      data.overnight = endMin < startMin;
    }
    if (dto.timeZone !== undefined || !before) {
      const tz = dto.timeZone?.trim() || (await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { timezone: true } })).timezone;
      if (!isValidTimezone(tz)) throw invalid('Unknown time zone');
      data.timeZone = tz;
    }
    return data;
  }

  /** A place (Poi) of the caller's own company, else 400 (never another tenant's id). */
  private async ownPlace(ctx: AuthContext, poiId: string): Promise<string> {
    const p = await this.prisma.poi.findFirst({ where: { id: poiId, companyId: ctx.companyId, isActive: true }, select: { id: true } });
    if (!p) throw invalid('Unknown place');
    return p.id;
  }

  // ───────────────────────────── Schedules ─────────────────────────────

  private scheduleWhere(ctx: AuthContext): Prisma.TransportScheduleWhereInput {
    const branch = profileBranchWhere(ctx);
    return branch ? { companyId: ctx.companyId, profile: branch } : { companyId: ctx.companyId };
  }

  async listSchedules(ctx: AuthContext, q: ScheduleListQuery) {
    const plan = planList<Prisma.TransportScheduleWhereInput, Prisma.TransportScheduleOrderByWithRelationInput>(q, SCHEDULE_LIST);
    const filters: Prisma.TransportScheduleWhereInput[] = [this.scheduleWhere(ctx), plan.where];
    if (q.profileId) filters.push({ profileId: q.profileId });
    if (q.shiftId) filters.push({ shiftId: q.shiftId });
    if (q.direction) filters.push({ direction: q.direction });
    const where: Prisma.TransportScheduleWhereInput = { AND: filters };
    const [rows, total] = await Promise.all([
      this.prisma.transportSchedule.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: SCHEDULE_INCLUDE }),
      this.prisma.transportSchedule.count({ where }),
    ]);
    const visible = rows.filter((r) => inProfileBranch(ctx, r.profile.branchId));
    return listResult(plan, await this.toScheduleDtos(visible), total, SCHEDULE_CSV);
  }

  async createSchedules(ctx: AuthContext, dto: CreateSchedulesDto): Promise<CreateTransportSchedulesResult> {
    const shift = await this.prisma.transportShift.findFirst({ where: { id: dto.shiftId, companyId: ctx.companyId } });
    if (!shift) throw notFound();
    if (!shift.isActive) throw conflict('INVALID_STATE', 'This shift is archived');
    const days = sortedDays(dto.days ?? shift.days);
    if (days.some((d) => !shift.days.includes(d))) throw invalid('Schedule days must be days of the shift');
    const stopPoiId = dto.pickupMode === 'STOP' ? (dto.stopPoiId ? await this.ownPlace(ctx, dto.stopPoiId) : null) : null;
    if (dto.pickupMode === 'STOP' && !stopPoiId) throw invalid('Choose the pickup stop');
    const validFrom = serviceDate(dto.validFrom, 'validFrom');
    const validTo = dto.validTo ? serviceDate(dto.validTo, 'validTo') : null;
    if (validTo && validTo < validFrom) throw invalid('Valid to must not be before valid from');
    const ids = [...new Set(dto.profileIds)];
    const profiles = await this.prisma.employeeTransportProfile.findMany({ where: { id: { in: ids }, companyId: ctx.companyId, isActive: true }, select: { id: true, branchId: true } });
    const found = new Set(profiles.filter((p) => inProfileBranch(ctx, p.branchId)).map((p) => p.id));
    if (ids.some((id) => !found.has(id))) throw notFound('Passenger not found');
    const directions = [...new Set(dto.directions)];
    const created = await this.prisma.$transaction(async (tx) => {
      const out: string[] = [];
      for (const profileId of ids) {
        for (const direction of directions) {
          const row = await tx.transportSchedule.create({
            data: { companyId: ctx.companyId, profileId, shiftId: shift.id, direction, days, pickupMode: dto.pickupMode, stopPoiId, validFrom: dateOnly(validFrom), validTo: validTo ? dateOnly(validTo) : null, createdById: ctx.userId },
          });
          await this.audit.record(ctx, { action: 'CREATE', entity: SCHEDULE_ENTITY, entityId: row.id, after: scheduleSnapshot(row) }, tx);
          out.push(row.id);
        }
      }
      return out;
    });
    const g = await this.generator.generate(Date.now(), created);
    const rows = await this.prisma.transportSchedule.findMany({ where: { id: { in: created } }, include: SCHEDULE_INCLUDE });
    return { created: await this.toScheduleDtos(rows), generatedBookings: g.created };
  }

  async updateSchedule(ctx: AuthContext, id: string, dto: UpdateScheduleDto): Promise<TransportScheduleDto> {
    const before = await this.findSchedule(ctx, id);
    const data: Prisma.TransportScheduleUncheckedUpdateManyInput = {};
    let shiftDays = before.shift.days;
    if (dto.shiftId !== undefined && dto.shiftId !== before.shiftId) {
      const shift = await this.prisma.transportShift.findFirst({ where: { id: dto.shiftId, companyId: ctx.companyId, isActive: true } });
      if (!shift) throw invalid('Unknown or archived shift');
      data.shiftId = shift.id;
      shiftDays = shift.days;
    }
    const days = dto.days !== undefined ? sortedDays(dto.days) : before.days;
    if (days.some((d) => !shiftDays.includes(d))) throw invalid('Schedule days must be days of the shift');
    if (dto.days !== undefined) data.days = days;
    const mode = dto.pickupMode ?? before.pickupMode;
    if (dto.pickupMode !== undefined) data.pickupMode = dto.pickupMode;
    if (dto.stopPoiId !== undefined) data.stopPoiId = dto.stopPoiId ? await this.ownPlace(ctx, dto.stopPoiId) : null;
    const stop = dto.stopPoiId !== undefined ? data.stopPoiId : before.stopPoiId;
    if (mode === 'STOP' && !stop) throw invalid('Choose the pickup stop');
    if (mode === 'HOME' && dto.pickupMode === 'HOME' && dto.stopPoiId === undefined) data.stopPoiId = null;
    const validFrom = dto.validFrom !== undefined ? serviceDate(dto.validFrom, 'validFrom') : dayKeyOf(before.validFrom);
    const validTo = dto.validTo !== undefined ? (dto.validTo ? serviceDate(dto.validTo, 'validTo') : null) : before.validTo ? dayKeyOf(before.validTo) : null;
    if (validTo && validTo < validFrom) throw invalid('Valid to must not be before valid from');
    if (dto.validFrom !== undefined) data.validFrom = dateOnly(validFrom);
    if (dto.validTo !== undefined) data.validTo = validTo ? dateOnly(validTo) : null;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.transportSchedule.updateMany({ where: { id, version: dto.expectedVersion }, data: { ...data, version: { increment: 1 } } });
      if (!claimed.count) throw versionConflict(before.version);
      const after = await tx.transportSchedule.findUniqueOrThrow({ where: { id } });
      await this.audit.record(ctx, { action: 'UPDATE', entity: SCHEDULE_ENTITY, entityId: id, before: scheduleSnapshot(before), after: scheduleSnapshot(after) }, tx);
    });
    await this.resyncSchedules([id]);
    return (await this.toScheduleDtos([await this.findSchedule(ctx, id)]))[0];
  }

  /** Archive: isActive = false; future unseated bookings are cancelled (seated ones stay with the dispatcher). */
  async archiveSchedule(ctx: AuthContext, id: string): Promise<TransportScheduleDto> {
    const before = await this.findSchedule(ctx, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.transportSchedule.updateMany({ where: { id }, data: { isActive: false, version: { increment: 1 } } });
      const cancelled = await tx.transportBooking.updateMany({
        where: { scheduleId: id, status: { in: [...UNSEATED_STATUSES] }, windowStart: { gt: new Date() } },
        data: { status: 'CANCELLED', statusReason: SCHEDULE_ARCHIVED_REASON, version: { increment: 1 } },
      });
      await this.audit.record(ctx, { action: 'DELETE', entity: SCHEDULE_ENTITY, entityId: id, before: scheduleSnapshot(before), details: { archived: true, bookingsCancelled: cancelled.count } }, tx);
    });
    return (await this.toScheduleDtos([await this.findSchedule(ctx, id)]))[0];
  }

  // ───────────────────────────── Exceptions ─────────────────────────────

  async listExceptions(ctx: AuthContext, id: string): Promise<TransportScheduleExceptionDto[]> {
    const schedule = await this.findSchedule(ctx, id);
    const rows = await this.prisma.transportScheduleException.findMany({ where: { scheduleId: id }, orderBy: { date: 'asc' } });
    const show = await this.exceptionView(ctx, schedule);
    return rows.map((r) => toExceptionDto(r, show));
  }

  /** M4: an override pickup is a personal point: shown only with the passenger's consent, 4 decimals unless whole-company. */
  private async exceptionView(ctx: AuthContext, schedule: { companyId: string; profileId: string }): Promise<ExceptionView> {
    const consent = (await activeRoutingConsents(this.prisma, [schedule.profileId])).has(schedule.profileId);
    return { consent, precise: preciseFor(ctx, schedule.companyId) };
  }

  /**
   * SKIP cancels that date's unseated booking (409 INVALID_STATE when the passenger is already seated: remove them from
   * the trip first); OVERRIDE re-times / re-points it (or the generator uses it when the date comes into the horizon).
   */
  async createException(ctx: AuthContext, id: string, dto: CreateExceptionDto): Promise<TransportScheduleExceptionDto> {
    const schedule = await this.findSchedule(ctx, id);
    const date = serviceDate(dto.date, 'date');
    const override = dto.kind === 'OVERRIDE' ? overrideOf(dto.override as unknown as Prisma.JsonValue) : null;
    if (dto.kind === 'OVERRIDE' && (!override || (override.timeMin === undefined && !override.pickup))) throw invalid('An override needs a time or a pickup point');
    // M4: a pickup override is a personal point (a temporary address): only while the passenger's routing consent is active.
    if (override?.pickup && !(await activeRoutingConsents(this.prisma, [schedule.profileId])).has(schedule.profileId)) {
      throw forbidden('CONSENT_REQUIRED', 'The passenger has not consented to the use of a pickup location; set a time only');
    }
    const seated = await this.prisma.transportBooking.findFirst({ where: { scheduleId: id, serviceDate: dateOnly(date), status: { in: ['ASSIGNED', 'CONFIRMED'] } }, select: { id: true } });
    if (seated) throw conflict('INVALID_STATE', 'The passenger already has a seat that day; remove them from the trip first');
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.transportScheduleException
        .create({ data: { companyId: schedule.companyId, scheduleId: id, date: dateOnly(date), kind: dto.kind, override: override ? (override as Prisma.InputJsonValue) : Prisma.DbNull, reason: dto.reason?.trim() || null, createdById: ctx.userId } })
        .catch((e: unknown) => {
          throw isUniqueViolation(e) ? conflict('INVALID_STATE', 'This date already has an exception; delete it first') : e;
        });
      if (dto.kind === 'SKIP') {
        await tx.transportBooking.updateMany({
          where: { scheduleId: id, serviceDate: dateOnly(date), status: { in: [...UNSEATED_STATUSES] } },
          data: { status: 'CANCELLED', statusReason: SKIPPED_REASON, version: { increment: 1 } },
        });
      }
      // M4: no coordinates or address label in the audit (the exception row holds them; erasure clears both).
      const audited = override ? { ...(override.timeMin !== undefined ? { timeMin: override.timeMin } : {}), hasPickup: !!override.pickup, poiId: override.pickup?.poiId ?? null } : null;
      await this.audit.record(ctx, { action: 'CREATE', entity: SCHEDULE_ENTITY, entityId: id, details: { exception: { date, kind: dto.kind, override: audited, reason: created.reason } } }, tx);
      return created;
    });
    if (dto.kind === 'OVERRIDE') await this.resyncSchedules([id]);
    return toExceptionDto(row, await this.exceptionView(ctx, schedule));
  }

  async deleteException(ctx: AuthContext, id: string, date: string): Promise<{ deleted: true }> {
    await this.findSchedule(ctx, id);
    const day = serviceDate(date, 'date');
    const row = await this.prisma.transportScheduleException.findFirst({ where: { scheduleId: id, date: dateOnly(day) } });
    if (!row) throw notFound();
    await this.prisma.$transaction(async (tx) => {
      await tx.transportScheduleException.deleteMany({ where: { id: row.id } });
      await this.audit.record(ctx, { action: 'DELETE', entity: SCHEDULE_ENTITY, entityId: id, details: { exception: { date: day, kind: row.kind } } }, tx);
    });
    await this.resyncSchedules([id]);
    return { deleted: true };
  }

  // ───────────────────────────── Preview ─────────────────────────────

  /** What the generator would do for [from, to) (default: the next 72 h), for the caller's schedules. Writes nothing. */
  async preview(ctx: AuthContext, q: SchedulePreviewQuery): Promise<TransportSchedulePreviewDto> {
    const from = q.from ? parseInstant(q.from, 'from') : Date.now();
    const to = q.to ? parseInstant(q.to, 'to') : from + TRANSPORT_E3_LIMITS.generatorHorizonHours * H;
    // L5: each occurrence becomes a clause of one query: the range stays small.
    if (to <= from || to - from > TRANSPORT_E3_LIMITS.previewMaxDays * 24 * H) throw invalid(`Preview at most ${TRANSPORT_E3_LIMITS.previewMaxDays} days, with from before to`);
    const schedules = await this.generator.loadSchedules(this.scheduleWhere(ctx));
    const { rows, skippedByException } = await this.generator.plan(schedules, from, to);
    const keys = rows.map((r) => ({ scheduleId: r.scheduleId as string, serviceDate: r.serviceDate as Date, direction: r.direction }));
    const existing = keys.length
      ? await this.prisma.transportBooking.findMany({
          where: { OR: keys.map((k) => ({ scheduleId: k.scheduleId, serviceDate: k.serviceDate, direction: k.direction })) },
          select: { scheduleId: true, serviceDate: true, direction: true },
        })
      : [];
    const have = new Set(existing.map((e) => `${e.scheduleId}|${dayKeyOf(e.serviceDate)}|${e.direction}`));
    const fresh = rows.filter((r) => !have.has(`${r.scheduleId}|${dayKeyOf(r.serviceDate as Date)}|${r.direction}`));
    const active = fresh.length
      ? await this.prisma.transportBooking.findMany({
          where: { status: { in: ['REQUESTED', 'PENDING_ASSIGNMENT', 'ASSIGNED', 'CONFIRMED', 'WAITLISTED'] }, OR: fresh.map((r) => ({ profileId: r.profileId, serviceDate: r.serviceDate as Date, direction: r.direction })) },
          select: { profileId: true, serviceDate: true, direction: true },
        })
      : [];
    const taken = new Set(active.map((a) => `${a.profileId}|${dayKeyOf(a.serviceDate)}|${a.direction}`));
    const would = fresh.filter((r) => !taken.has(`${r.profileId}|${dayKeyOf(r.serviceDate as Date)}|${r.direction}`));
    const byDate = new Map<string, { date: string; direction: 'IN' | 'OUT'; count: number }>();
    for (const r of would) {
      const k = `${dayKeyOf(r.serviceDate as Date)}|${r.direction}`;
      const e = byDate.get(k) ?? { date: dayKeyOf(r.serviceDate as Date), direction: r.direction as 'IN' | 'OUT', count: 0 };
      e.count++;
      byDate.set(k, e);
    }
    return {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      schedules: schedules.length,
      wouldCreate: would.length,
      existing: rows.length - fresh.length,
      skippedByException,
      skippedDuplicate: fresh.length - would.length,
      needsLocation: would.filter((r) => r.pickupLat === null || r.dropLat === null).length,
      byDate: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date) || a.direction.localeCompare(b.direction)),
    };
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private async resyncSchedules(ids: string[]): Promise<void> {
    const now = Date.now();
    for (const id of ids) await this.generator.resync(id, now);
    if (ids.length) await this.generator.generate(now, ids);
  }

  private async findSchedule(ctx: AuthContext, id: string): Promise<ScheduleRow> {
    const row = await this.prisma.transportSchedule.findFirst({ where: { AND: [this.scheduleWhere(ctx), { id }] }, include: SCHEDULE_INCLUDE });
    if (!row || !inProfileBranch(ctx, row.profile.branchId)) throw notFound();
    return row;
  }

  private async toScheduleDtos(rows: ScheduleRow[]): Promise<TransportScheduleDto[]> {
    const consents = await activeRoutingConsents(this.prisma, rows.map((r) => r.profileId));
    return rows.map((r) => {
      const consent = consents.has(r.profileId);
      const home = r.profile.homeLat !== null || r.profile.defaultStopPoiId !== null;
      // Same rule as legPoints: no passenger point without consent; STOP needs the stop, HOME a home point / default stop.
      const needsLocation = !consent || (r.pickupMode === 'STOP' ? !r.stopPoi : !home);
      return {
        id: r.id,
        version: r.version,
        passenger: { id: r.profile.id, displayName: r.profile.displayName, employeeCode: r.profile.employeeCode },
        shiftId: r.shiftId,
        shiftName: r.shift.name,
        direction: r.direction,
        days: [...r.days].sort((a, b) => a - b),
        pickupMode: r.pickupMode,
        stop: r.stopPoi ? { id: r.stopPoi.id, name: r.stopPoi.name, lat: r.stopPoi.lat, lng: r.stopPoi.lng } : null,
        validFrom: dayKeyOf(r.validFrom),
        validTo: r.validTo ? dayKeyOf(r.validTo) : null,
        isActive: r.isActive,
        timeZone: r.shift.timeZone,
        needsLocation,
        createdAt: iso(r.createdAt),
        updatedAt: iso(r.updatedAt),
      };
    });
  }
}

interface ExceptionView {
  consent: boolean;
  precise: boolean;
}

function toExceptionDto(r: Prisma.TransportScheduleExceptionGetPayload<object>, show: ExceptionView): TransportScheduleExceptionDto {
  const ov = r.kind === 'OVERRIDE' ? overrideOf(r.override) : null;
  if (ov?.pickup) {
    const d = show.precise ? 6 : 4;
    if (!show.consent) delete ov.pickup;
    else ov.pickup = { ...ov.pickup, lat: round(ov.pickup.lat, d), lng: round(ov.pickup.lng, d) };
  }
  return { id: r.id, scheduleId: r.scheduleId, date: dayKeyOf(r.date), kind: r.kind, override: ov, reason: r.reason, createdAt: iso(r.createdAt) };
}

function shiftSnapshot(r: { name: string; sitePoiId: string | null; startMin: number; endMin: number; overnight: boolean; days: number[]; timeZone: string; isActive: boolean }) {
  return { name: r.name, sitePoiId: r.sitePoiId, startMin: r.startMin, endMin: r.endMin, overnight: r.overnight, days: r.days, timeZone: r.timeZone, isActive: r.isActive };
}

function scheduleSnapshot(r: { profileId: string; shiftId: string; direction: string; days: number[]; pickupMode: string; stopPoiId: string | null; validFrom: Date; validTo: Date | null; isActive: boolean; version: number }) {
  return { profileId: r.profileId, shiftId: r.shiftId, direction: r.direction, days: r.days, pickupMode: r.pickupMode, stopPoiId: r.stopPoiId, validFrom: dayKeyOf(r.validFrom), validTo: r.validTo ? dayKeyOf(r.validTo) : null, isActive: r.isActive, version: r.version };
}
