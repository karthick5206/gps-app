import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DEFAULT_NOTIFY_BEFORE_DAYS, DEFAULT_NOTIFY_BEFORE_KM, SERVICE_STATUSES, ServiceRecordDto, ServiceReminderDto, serviceDue, serviceStatus } from '@veetracer/shared';
import { hasPermission, objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { iso } from '../common/dto';
import { ObjectsService } from '../masters/objects/objects.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateServiceReminderDto, ServiceDoneDto, ServiceRecordQuery, ServiceReminderListQuery, UpdateServiceReminderDto } from './documents.dto';
import { DocumentsService } from './documents.service';
import { dateOf, odometers, ymd } from './reminder-logic';

const ENTITY = 'service_reminder';
const MAX_ROWS = 2000;

const INCLUDE = { object: { select: { name: true, plateNumber: true, maintenanceSince: true } } } satisfies Prisma.ServiceReminderInclude;
type Row = Prisma.ServiceReminderGetPayload<{ include: typeof INCLUDE }>;

const blank = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() ? v.trim() : null);
const URGENCY = Object.fromEntries([...SERVICE_STATUSES].reverse().map((s, i) => [s, i])) as Record<ServiceReminderDto['status'], number>;

export function toServiceReminderDto(r: Row, today: string, odometerKm: number | null): ServiceReminderDto {
  const dueAt = ymd(r.dueAt);
  const s = serviceStatus({ dueAt, dueOdometerKm: r.dueOdometerKm, notifyBeforeDays: r.notifyBeforeDays, notifyBeforeKm: r.notifyBeforeKm }, today, odometerKm);
  return {
    id: r.id,
    objectId: r.objectId,
    objectName: r.object.name,
    plateNumber: r.object.plateNumber,
    title: r.title,
    intervalKm: r.intervalKm,
    intervalDays: r.intervalDays,
    lastDoneAt: ymd(r.lastDoneAt),
    lastDoneOdometerKm: r.lastDoneOdometerKm,
    dueAt,
    dueOdometerKm: r.dueOdometerKm,
    notifyBeforeKm: r.notifyBeforeKm,
    notifyBeforeDays: r.notifyBeforeDays,
    notes: r.notes,
    isActive: r.isActive,
    odometerKm,
    status: s.status,
    daysLeft: s.daysLeft,
    kmLeft: s.kmLeft,
    inMaintenance: r.object.maintenanceSince !== null,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

/** Most urgent first: overdue, due soon, then by days / km left. */
export function compareReminders(a: ServiceReminderDto, b: ServiceReminderDto): number {
  const left = (r: ServiceReminderDto) => Math.min(r.daysLeft ?? Infinity, r.kmLeft === null ? Infinity : r.kmLeft / 100);
  return URGENCY[a.status] - URGENCY[b.status] || left(a) - left(b) || a.objectName.localeCompare(b.objectName) || a.title.localeCompare(b.title);
}

/** Service reminders by date and/or odometer, "mark done" with a service history row. */
@Injectable()
export class ServiceRemindersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly documents: DocumentsService,
    private readonly objects: ObjectsService,
  ) {}

  async list(ctx: AuthContext, q: ServiceReminderListQuery): Promise<ServiceReminderDto[]> {
    const search = q.q?.trim();
    const where: Prisma.ServiceReminderWhereInput = {
      companyId: ctx.companyId,
      object: objectScopeWhere(ctx),
      ...(q.objectId ? { objectId: q.objectId } : {}),
      ...(q.status ? { isActive: q.status === 'ACTIVE' } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' } },
              { object: { name: { contains: search, mode: 'insensitive' } } },
              { object: { plateNumber: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.serviceReminder.findMany({ where, include: INCLUDE, take: MAX_ROWS, orderBy: { createdAt: 'asc' } });
    const [today, odo] = await Promise.all([this.documents.today(ctx.companyId), odometers(this.prisma, rows.map((r) => r.objectId))]);
    return rows
      .map((r) => toServiceReminderDto(r, today, odo.get(r.objectId) ?? null))
      .filter((r) => !q.due || r.status === q.due)
      .sort(compareReminders);
  }

  async get(ctx: AuthContext, id: string): Promise<ServiceReminderDto> {
    const row = await this.find(ctx, id);
    return this.dto(ctx, row);
  }

  async create(ctx: AuthContext, dto: CreateServiceReminderDto): Promise<ServiceReminderDto> {
    await this.assertObject(ctx, dto.objectId);
    if (!dto.intervalKm && !dto.intervalDays) throw new BadRequestException('Set an interval in km, in days, or both');
    const [today, odo] = await Promise.all([this.documents.today(ctx.companyId), odometers(this.prisma, [dto.objectId])]);
    // A new reminder counts from today / the odometer now unless the last service is given.
    const lastDoneAt = dto.lastDoneAt?.slice(0, 10) ?? today;
    const lastDoneOdometerKm = dto.lastDoneOdometerKm ?? (dto.intervalKm ? (odo.get(dto.objectId) ?? 0) : null);
    const due = serviceDue({ intervalKm: dto.intervalKm ?? null, intervalDays: dto.intervalDays ?? null, lastDoneAt, lastDoneOdometerKm });
    const row = await this.prisma.serviceReminder.create({
      data: {
        companyId: ctx.companyId,
        objectId: dto.objectId,
        title: dto.title.trim(),
        intervalKm: dto.intervalKm ?? null,
        intervalDays: dto.intervalDays ?? null,
        lastDoneAt: dateOf(lastDoneAt),
        lastDoneOdometerKm,
        dueAt: due.dueAt ? dateOf(due.dueAt) : null,
        dueOdometerKm: due.dueOdometerKm,
        notifyBeforeKm: dto.notifyBeforeKm ?? DEFAULT_NOTIFY_BEFORE_KM,
        notifyBeforeDays: dto.notifyBeforeDays ?? DEFAULT_NOTIFY_BEFORE_DAYS,
        notes: blank(dto.notes) ?? null,
        isActive: dto.isActive ?? true,
        createdById: ctx.userId,
      },
      include: INCLUDE,
    });
    await this.audit.record(ctx, { action: 'CREATE', entity: ENTITY, entityId: row.id, after: this.snapshot(row) });
    return this.dto(ctx, row);
  }

  async update(ctx: AuthContext, id: string, dto: UpdateServiceReminderDto): Promise<ServiceReminderDto> {
    const before = await this.find(ctx, id);
    if (dto.objectId && dto.objectId !== before.objectId) await this.assertObject(ctx, dto.objectId);
    const pick = <K extends keyof UpdateServiceReminderDto>(k: K, current: unknown) => (dto[k] !== undefined ? dto[k] : current);
    const schedule = {
      intervalKm: pick('intervalKm', before.intervalKm) as number | null,
      intervalDays: pick('intervalDays', before.intervalDays) as number | null,
      lastDoneAt: ((pick('lastDoneAt', ymd(before.lastDoneAt)) as string | null) ?? null)?.slice(0, 10) ?? null,
      lastDoneOdometerKm: pick('lastDoneOdometerKm', before.lastDoneOdometerKm) as number | null,
    };
    if (!schedule.intervalKm && !schedule.intervalDays) throw new BadRequestException('Set an interval in km, in days, or both');
    const due = serviceDue(schedule);
    const dueAt = due.dueAt ? dateOf(due.dueAt) : null;
    const notifyChanged = (dto.notifyBeforeDays ?? before.notifyBeforeDays) !== before.notifyBeforeDays || (dto.notifyBeforeKm ?? before.notifyBeforeKm) !== before.notifyBeforeKm;
    const dueChanged = ymd(dueAt) !== ymd(before.dueAt) || due.dueOdometerKm !== before.dueOdometerKm;
    const row = await this.prisma.serviceReminder.update({
      where: { id },
      data: {
        objectId: dto.objectId,
        title: dto.title?.trim(),
        intervalKm: schedule.intervalKm,
        intervalDays: schedule.intervalDays,
        lastDoneAt: schedule.lastDoneAt ? dateOf(schedule.lastDoneAt) : null,
        lastDoneOdometerKm: schedule.lastDoneOdometerKm,
        dueAt,
        dueOdometerKm: due.dueOdometerKm,
        notifyBeforeKm: dto.notifyBeforeKm,
        notifyBeforeDays: dto.notifyBeforeDays,
        notes: blank(dto.notes),
        isActive: dto.isActive,
        ...(dueChanged || notifyChanged || dto.objectId ? { notifiedState: null } : {}),
      },
      include: INCLUDE,
    });
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: id, before: this.snapshot(before), after: this.snapshot(row) });
    return this.dto(ctx, row);
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const before = await this.find(ctx, id);
    await this.prisma.serviceReminder.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: ENTITY, entityId: id, before: this.snapshot(before) });
  }

  /** Records the service (history row) and rolls the reminder forward from that date / odometer. */
  async done(ctx: AuthContext, id: string, dto: ServiceDoneDto): Promise<ServiceReminderDto> {
    const before = await this.find(ctx, id);
    if (dto.endMaintenance && !hasPermission(ctx, 'objects', 'edit')) throw new ForbiddenException('You may not change the vehicle\'s maintenance status');
    const [today, odo] = await Promise.all([this.documents.today(ctx.companyId), odometers(this.prisma, [before.objectId])]);
    const doneAt = dto.doneAt?.slice(0, 10) ?? today;
    if (doneAt > today) throw new BadRequestException('The service date is in the future');
    const odometerKm = dto.odometerKm !== undefined ? dto.odometerKm : (odo.get(before.objectId) ?? null);
    const due = serviceDue({ intervalKm: before.intervalKm, intervalDays: before.intervalDays, lastDoneAt: doneAt, lastDoneOdometerKm: odometerKm });
    const [, row] = await this.prisma.$transaction([
      this.prisma.serviceRecord.create({
        data: {
          companyId: ctx.companyId,
          objectId: before.objectId,
          reminderId: id,
          title: before.title,
          doneAt: dateOf(doneAt),
          odometerKm,
          cost: dto.cost ?? null,
          notes: blank(dto.notes) ?? null,
          createdById: ctx.userId,
        },
      }),
      this.prisma.serviceReminder.update({
        where: { id },
        data: {
          lastDoneAt: dateOf(doneAt),
          lastDoneOdometerKm: odometerKm,
          dueAt: due.dueAt ? dateOf(due.dueAt) : null,
          dueOdometerKm: due.dueOdometerKm,
          notifiedState: null,
        },
        include: INCLUDE,
      }),
    ]);
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: id, details: { serviceDone: { doneAt, odometerKm, cost: dto.cost ?? null } } });
    if (dto.endMaintenance && before.object.maintenanceSince) await this.objects.setMaintenance(ctx, before.objectId, false, null);
    return this.dto(ctx, { ...row, object: { ...row.object, maintenanceSince: dto.endMaintenance ? null : row.object.maintenanceSince } });
  }

  /** Service history of a vehicle or a reminder (latest first, last 200). */
  async records(ctx: AuthContext, q: ServiceRecordQuery): Promise<ServiceRecordDto[]> {
    const rows = await this.prisma.serviceRecord.findMany({
      where: { companyId: ctx.companyId, object: objectScopeWhere(ctx), ...(q.objectId ? { objectId: q.objectId } : {}), ...(q.reminderId ? { reminderId: q.reminderId } : {}) },
      orderBy: [{ doneAt: 'desc' }, { createdAt: 'desc' }],
      take: 200,
      include: { object: { select: { name: true } } },
    });
    const userIds = [...new Set(rows.map((r) => r.createdById).filter((v): v is string => !!v))];
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const names = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      id: r.id,
      reminderId: r.reminderId,
      objectId: r.objectId,
      objectName: r.object.name,
      title: r.title,
      doneAt: ymd(r.doneAt)!,
      odometerKm: r.odometerKm,
      cost: r.cost,
      notes: r.notes,
      createdByName: r.createdById ? (names.get(r.createdById) ?? null) : null,
      createdAt: iso(r.createdAt),
    }));
  }

  async history(ctx: AuthContext, id: string) {
    await this.find(ctx, id);
    return this.audit.history(ctx, ENTITY, id);
  }

  private async dto(ctx: AuthContext, row: Row): Promise<ServiceReminderDto> {
    const [today, odo] = await Promise.all([this.documents.today(ctx.companyId), odometers(this.prisma, [row.objectId])]);
    return toServiceReminderDto(row, today, odo.get(row.objectId) ?? null);
  }

  private snapshot(row: Row): Record<string, unknown> {
    const { object: _o, notifiedState: _n, ...rest } = row;
    return rest;
  }

  private async assertObject(ctx: AuthContext, objectId: string): Promise<void> {
    const ok = await this.prisma.trackedObject.count({ where: { AND: [objectScopeWhere(ctx), { id: objectId }] } });
    if (!ok) throw new BadRequestException('Vehicle not found');
  }

  private async find(ctx: AuthContext, id: string): Promise<Row> {
    const row = await this.prisma.serviceReminder.findFirst({ where: { id, companyId: ctx.companyId, object: objectScopeWhere(ctx) }, include: INCLUDE });
    if (!row) throw new NotFoundException('Service reminder not found');
    return row;
  }
}
