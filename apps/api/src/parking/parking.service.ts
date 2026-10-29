import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  nextParkingStart,
  parkingArmedWindow,
  parkingScheduleError,
  readParkingWindows,
  type ParkingRowDto,
  type ParkingScheduleDto,
  type ParkingScheduleInput,
} from '@veetracer/shared';
import { allCompaniesOr, objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/** Redis cache reason the processor listens to (it reloads parking schedules at once instead of within 30 s). */
export const PARKING_CACHE_REASON = 'parking';

type Row = Prisma.ParkingScheduleGetPayload<object>;

function toDto(r: Row, names: Map<string, string>): ParkingScheduleDto {
  return {
    objectId: r.objectId,
    enabled: r.enabled,
    windows: readParkingWindows(r.windows),
    alarmAllAlerts: r.alarmAllAlerts,
    escalation: (r.escalation && typeof r.escalation === 'object' ? r.escalation : {}) as ParkingScheduleDto['escalation'],
    updatedAt: r.updatedAt.toISOString(),
    updatedByName: r.updatedById ? (names.get(r.updatedById) ?? null) : null,
  };
}

/** Parking mode page: vehicles in scope with their schedule, armed state and next window; saving schedules. */
@Injectable()
export class ParkingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  async list(ctx: AuthContext, now = Date.now()): Promise<ParkingRowDto[]> {
    const objects = await this.prisma.trackedObject.findMany({
      where: { AND: [allCompaniesOr(ctx, objectScopeWhere(ctx)), { isActive: true }] },
      select: { id: true, name: true, plateNumber: true, companyId: true, company: { select: { timezone: true } }, parkingSchedule: true },
      orderBy: { name: 'asc' },
    });
    const userIds = [...new Set(objects.flatMap((o) => (o.parkingSchedule?.updatedById ? [o.parkingSchedule.updatedById] : [])))];
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const names = new Map(users.map((u) => [u.id, u.name]));
    return objects.map((o) => {
      const s = o.parkingSchedule ? toDto(o.parkingSchedule, names) : null;
      const tz = o.company.timezone;
      const open = s?.enabled ? parkingArmedWindow(s.windows, now, tz) : null;
      const next = s?.enabled ? nextParkingStart(s.windows, now, tz) : null;
      return {
        objectId: o.id,
        name: o.name,
        plateNumber: o.plateNumber,
        companyId: o.companyId,
        schedule: s,
        armedUntil: open ? new Date(open.end).toISOString() : null,
        nextStart: next ? new Date(next).toISOString() : null,
      };
    });
  }

  /** Saves the same schedule on one or more vehicles in scope (one audit entry per vehicle). */
  async save(ctx: AuthContext, objectIds: string[], input: ParkingScheduleInput): Promise<ParkingRowDto[]> {
    const error = parkingScheduleError(input);
    if (error) throw new BadRequestException(error);
    const ids = [...new Set(objectIds)];
    const objects = await this.prisma.trackedObject.findMany({
      where: { AND: [allCompaniesOr(ctx, objectScopeWhere(ctx)), { id: { in: ids } }] },
      select: { id: true, companyId: true, parkingSchedule: true },
    });
    if (objects.length !== ids.length) throw new NotFoundException('Vehicle not found');
    const windows = input.windows.map((w) => ({ days: [...new Set(w.days)].sort(), startMin: w.startMin, endMin: w.endMin }));
    await this.prisma.$transaction(async (tx) => {
      for (const o of objects) {
        const data = { enabled: input.enabled, windows: windows as unknown as Prisma.InputJsonValue, alarmAllAlerts: input.alarmAllAlerts, updatedById: ctx.userId };
        await tx.parkingSchedule.upsert({ where: { objectId: o.id }, create: { objectId: o.id, companyId: o.companyId, ...data }, update: data });
        const before = o.parkingSchedule ? { enabled: o.parkingSchedule.enabled, windows: o.parkingSchedule.windows, alarmAllAlerts: o.parkingSchedule.alarmAllAlerts } : null;
        await this.audit.record(
          { ...ctx, companyId: o.companyId },
          { action: before ? 'UPDATE' : 'CREATE', entity: 'ParkingSchedule', entityId: o.id, before, after: { enabled: input.enabled, windows, alarmAllAlerts: input.alarmAllAlerts } },
          tx,
        );
      }
    });
    await this.redis.invalidateCache(PARKING_CACHE_REASON).catch(() => undefined);
    const rows = await this.list(ctx);
    return rows.filter((r) => ids.includes(r.objectId));
  }
}
