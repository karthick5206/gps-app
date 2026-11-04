import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { SharedVehicleDto, VehicleShareDto } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const ENTITY = 'VehicleShare';
const toDto = (r: { id: string; objectId: string; sharedWithId: string; startAt: Date; endAt: Date | null; alertsOn: boolean; sharedWith: { name: string } }): VehicleShareDto => ({
  id: r.id,
  objectId: r.objectId,
  sharedWithId: r.sharedWithId,
  sharedWithName: r.sharedWith.name,
  startAt: r.startAt.toISOString(),
  endAt: r.endAt?.toISOString() ?? null,
  alertsOn: r.alertsOn,
});
const INCLUDE = { sharedWith: { select: { name: true } } } as const;

function endOf(raw: string | null | undefined, now: Date): Date | null {
  if (!raw) return null;
  const end = new Date(raw);
  if (Number.isNaN(end.getTime()) || end <= now) throw new BadRequestException('The end time must be in the future');
  return end;
}

/**
 * Shows a vehicle, view only, to another company. Only Super Admin manages shares. The owner keeps the vehicle, its
 * device and licence. The other company sees it from the moment it is shared (never earlier), so a share that ended and
 * is made again starts afresh.
 */
@Injectable()
export class VehicleSharesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  private assertSuperAdmin(ctx: AuthContext): void {
    if (!ctx.isSuperAdmin) throw new ForbiddenException('Only Super Admin can share vehicles between companies');
  }

  async list(ctx: AuthContext, objectId: string): Promise<VehicleShareDto[]> {
    this.assertSuperAdmin(ctx);
    const rows = await this.prisma.vehicleShare.findMany({ where: { objectId }, include: INCLUDE, orderBy: { createdAt: 'asc' } });
    return rows.map(toDto);
  }

  async create(ctx: AuthContext, b: { objectId: string; companyId: string; alertsOn?: boolean; endAt?: string | null }, now = new Date()): Promise<VehicleShareDto> {
    this.assertSuperAdmin(ctx);
    const [object, company] = await Promise.all([
      this.prisma.trackedObject.findUnique({ where: { id: b.objectId }, select: { companyId: true, isActive: true } }),
      this.prisma.company.count({ where: { id: b.companyId } }),
    ]);
    if (!object?.isActive) throw new NotFoundException('Vehicle not found');
    if (!company) throw new NotFoundException('Company not found');
    if (object.companyId === b.companyId) throw new BadRequestException('The vehicle already belongs to that company');
    const endAt = endOf(b.endAt, now);
    const key = { objectId_sharedWithId: { objectId: b.objectId, sharedWithId: b.companyId } };
    const existing = await this.prisma.vehicleShare.findUnique({ where: key });
    if (existing && (!existing.endAt || existing.endAt > now)) throw new ConflictException('The vehicle is already shared with that company');
    const data = { startAt: now, endAt, alertsOn: b.alertsOn ?? false, createdById: ctx.userId };
    const row = await this.prisma.vehicleShare.upsert({ where: key, create: { objectId: b.objectId, sharedWithId: b.companyId, ...data }, update: data, include: INCLUDE });
    await this.audit.record(ctx, { action: 'CREATE', entity: ENTITY, entityId: row.id, after: { objectId: b.objectId, sharedWithId: b.companyId, alertsOn: data.alertsOn, endAt } });
    await this.redis.invalidateCache('object');
    return toDto(row);
  }

  async update(ctx: AuthContext, id: string, b: { alertsOn?: boolean; endAt?: string | null }, now = new Date()): Promise<VehicleShareDto> {
    this.assertSuperAdmin(ctx);
    const before = await this.prisma.vehicleShare.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Share not found');
    const data = { ...(b.alertsOn !== undefined ? { alertsOn: b.alertsOn } : {}), ...(b.endAt !== undefined ? { endAt: endOf(b.endAt, now) } : {}) };
    const row = await this.prisma.vehicleShare.update({ where: { id }, data, include: INCLUDE });
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: id, before: { alertsOn: before.alertsOn, endAt: before.endAt }, after: data });
    await this.redis.invalidateCache('object');
    return toDto(row);
  }

  async remove(ctx: AuthContext, id: string): Promise<{ ok: true }> {
    this.assertSuperAdmin(ctx);
    const before = await this.prisma.vehicleShare.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Share not found');
    await this.prisma.vehicleShare.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: ENTITY, entityId: id, before: { objectId: before.objectId, sharedWithId: before.sharedWithId, startAt: before.startAt, alertsOn: before.alertsOn, endAt: before.endAt } });
    await this.redis.invalidateCache('object');
    return { ok: true };
  }

  /** Vehicles shared with the caller's company, for pickers. */
  async mine(ctx: AuthContext): Promise<SharedVehicleDto[]> {
    const shares = ctx.shares ?? [];
    if (!shares.length) return [];
    const rows = await this.prisma.vehicleShare.findMany({
      where: { sharedWithId: ctx.companyId, objectId: { in: shares.map((x) => x.objectId) } },
      select: { objectId: true, startAt: true, endAt: true, alertsOn: true, object: { select: { name: true, plateNumber: true } } },
      orderBy: { object: { name: 'asc' } },
    });
    return rows.map((r) => ({ objectId: r.objectId, name: r.object.name, plateNumber: r.object.plateNumber, startAt: r.startAt.toISOString(), endAt: r.endAt?.toISOString() ?? null, alertsOn: r.alertsOn }));
  }
}
