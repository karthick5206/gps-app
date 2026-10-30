import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { FUEL_CONFIG_DEFAULTS, FuelConfigDto, FuelEventDto, FuelSource } from '@veetracer/shared';
import { allCompaniesOr, objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { iso } from '../common/dto';
import { LicencePolicyService } from '../licences/licence-policy.service';
import { SeatsService } from '../licences/seats.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { FuelConfigBody, FuelEventsQuery } from './fuel.dto';

const MAX_EVENTS = 2000;

@Injectable()
export class FuelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly seats: SeatsService,
    private readonly policy: LicencePolicyService,
  ) {}

  private async object(ctx: AuthContext, objectId: string) {
    const o = await this.prisma.trackedObject.findFirst({ where: { AND: [allCompaniesOr(ctx, objectScopeWhere(ctx)), { id: objectId }] }, select: { id: true, name: true, plateNumber: true } });
    if (!o) throw new NotFoundException('Vehicle not found');
    return o;
  }

  async get(ctx: AuthContext, objectId: string): Promise<FuelConfigDto> {
    await this.object(ctx, objectId);
    const row = await this.prisma.fuelConfig.findUnique({ where: { objectId } });
    if (!row) return { objectId, ...FUEL_CONFIG_DEFAULTS, updatedAt: null };
    return {
      objectId,
      source: row.source as FuelSource,
      tankCapacityL: row.tankCapacityL,
      calibration: (Array.isArray(row.calibration) ? row.calibration : []) as [number, number][],
      refillMinL: row.refillMinL,
      drainMinL: row.drainMinL,
      drainWindowMin: row.drainWindowMin,
      smoothingWindow: row.smoothingWindow,
      updatedAt: iso(row.updatedAt),
    };
  }

  async put(ctx: AuthContext, objectId: string, dto: FuelConfigBody): Promise<FuelConfigDto> {
    await this.object(ctx, objectId);
    const calibration = [...(dto.calibration ?? [])].map((p) => [Number(p.raw), Number(p.litres)] as [number, number]).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < calibration.length; i++) {
      if (calibration[i][0] === calibration[i - 1][0]) throw new BadRequestException('Calibration raw values must be different');
    }
    if (dto.source === 'analog' && calibration.length < 2) {
      throw new BadRequestException('An analog sensor needs at least 2 calibration rows');
    }
    if (dto.source === 'can_level_pct' && !dto.tankCapacityL) throw new BadRequestException('Enter the tank capacity to convert % to litres');
    const before = await this.prisma.fuelConfig.findUnique({ where: { objectId } });
    const data = {
      source: dto.source,
      tankCapacityL: dto.tankCapacityL ?? null,
      calibration: calibration as unknown as Prisma.InputJsonValue,
      refillMinL: dto.refillMinL ?? null,
      drainMinL: dto.drainMinL ?? FUEL_CONFIG_DEFAULTS.drainMinL,
      drainWindowMin: dto.drainWindowMin ?? FUEL_CONFIG_DEFAULTS.drainWindowMin,
      smoothingWindow: dto.smoothingWindow ?? FUEL_CONFIG_DEFAULTS.smoothingWindow,
    };
    // Fuel monitoring on a vehicle takes a FUEL_SENSOR licence seat; switching it off returns the seat to the pool.
    const row = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.fuelConfig.upsert({ where: { objectId }, create: { objectId, companyId: ctx.companyId, ...data }, update: data });
      if (dto.source === 'none') await this.seats.releaseFuel(tx, objectId);
      else await this.seats.ensureFuel(tx, ctx, ctx.companyId, objectId);
      return saved;
    });
    await this.audit.record(ctx, { action: before ? 'UPDATE' : 'CREATE', entity: 'fuel_config', entityId: objectId, before: before ?? undefined, after: row });
    // The processor caches device / object facts (fuel settings included): reload them.
    await this.redis.invalidateCache('fuel_config');
    return this.get(ctx, objectId);
  }

  async events(ctx: AuthContext, q: FuelEventsQuery): Promise<FuelEventDto[]> {
    const objects = await this.prisma.trackedObject.findMany({ where: { AND: [objectScopeWhere(ctx), q.objectId ? { id: q.objectId } : {}] }, select: { id: true, name: true, plateNumber: true } });
    const fuelLocked = await this.policy.fuelLockedObjectIds(ctx);
    if (fuelLocked.size) objects.splice(0, objects.length, ...objects.filter((o) => !fuelLocked.has(o.id)));
    if (!objects.length) return [];
    const meta = new Map(objects.map((o) => [o.id, o]));
    const rows = await this.prisma.fuelEvent.findMany({
      where: {
        companyId: ctx.companyId,
        objectId: { in: [...meta.keys()] },
        ...(q.type ? { type: q.type } : {}),
        ...(q.from || q.to ? { startTime: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
      },
      orderBy: { startTime: 'desc' },
      take: MAX_EVENTS,
    });
    return rows.map((e) => fuelEventDto(e, meta.get(e.objectId)));
  }
}

export function fuelEventDto(
  e: { id: string; objectId: string; type: string; startTime: Date; endTime: Date; litresBefore: number; litresAfter: number; deltaL: number; lat: number | null; lng: number | null },
  o: { name: string; plateNumber: string | null } | undefined,
): FuelEventDto {
  return {
    id: e.id,
    objectId: e.objectId,
    objectName: o?.name ?? 'Unknown object',
    plateNumber: o?.plateNumber ?? null,
    type: e.type as FuelEventDto['type'],
    startTime: e.startTime.toISOString(),
    endTime: e.endTime.toISOString(),
    litresBefore: e.litresBefore,
    litresAfter: e.litresAfter,
    deltaL: e.deltaL,
    lat: e.lat,
    lng: e.lng,
  };
}
