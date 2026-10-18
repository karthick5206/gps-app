import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { VehicleGroupDto } from '@veetracer/shared';
import { objectScopeWhere } from '../../access/access-rules';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { BulkActionDto, runBulk } from '../../common/bulk';
import { iso } from '../../common/dto';
import { CsvSpec, ListSpec, listResult, planList } from '../../common/list-query';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisKeys } from '../../redis/keys';
import { RedisService } from '../../redis/redis.service';
import { CreateVehicleGroupDto, UpdateVehicleGroupDto, VehicleGroupListQuery } from './vehicle-groups.dto';

const ENTITY = 'vehicle_group';

/** Members are shown (and edited) only for objects inside the caller's data scope. */
const includeFor = (ctx: AuthContext) =>
  ({
    members: {
      where: { object: objectScopeWhere(ctx) },
      include: { object: { select: { id: true, name: true } } },
      orderBy: { object: { name: 'asc' } },
    },
  }) satisfies Prisma.VehicleGroupInclude;
type Row = Prisma.VehicleGroupGetPayload<{ include: ReturnType<typeof includeFor> }>;

const LIST: ListSpec = {
  search: ['name', 'description'],
  sort: { name: 'name', createdAt: 'createdAt', updatedAt: 'updatedAt' },
  defaultSort: 'name',
};

const CSV: CsvSpec<VehicleGroupDto & { alertPriority: number }> = {
  name: 'vehicle-groups',
  columns: [
    { header: 'Name', value: (g) => g.name },
    { header: 'Description', value: (g) => g.description },
    { header: 'Objects', value: (g) => g.objects.map((o) => o.name) },
    { header: 'Alert priority', value: (g) => g.alertPriority },
    { header: 'Active', value: (g) => (g.isActive ? 'Yes' : 'No') },
  ],
};

/** VehicleGroupDto plus `alertPriority` (M2a; not yet in the shared type). */
function toDto(g: Row): VehicleGroupDto & { alertPriority: number } {
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    isActive: g.isActive,
    objects: g.members.map((m) => ({ id: m.object.id, name: m.object.name })),
    alertPriority: g.alertPriority,
    createdAt: iso(g.createdAt),
    updatedAt: iso(g.updatedAt),
  };
}

function snapshot(g: Row) {
  const { members, ...scalars } = g;
  return { ...scalars, objectIds: members.map((m) => m.objectId).sort() };
}

@Injectable()
export class VehicleGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  /** Membership/priority/active changes alter alert-settings resolution and geofence applicability. */
  private async invalidateRules(ctx: AuthContext): Promise<void> {
    await this.redis.client.publish(RedisKeys.rulesInvalidate, JSON.stringify({ companyId: ctx.companyId, reason: 'vehicle_group', at: Date.now() }));
  }

  async list(ctx: AuthContext, query: VehicleGroupListQuery) {
    const plan = planList<Prisma.VehicleGroupWhereInput, Prisma.VehicleGroupOrderByWithRelationInput>(query, LIST);
    const filters: Prisma.VehicleGroupWhereInput[] = [{ companyId: ctx.companyId }, plan.where];
    if (query.objectId) filters.push({ members: { some: { objectId: query.objectId } } });
    const where: Prisma.VehicleGroupWhereInput = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.vehicleGroup.findMany({
        where,
        orderBy: plan.orderBy,
        skip: plan.skip,
        take: plan.take,
        include: includeFor(ctx),
      }),
      this.prisma.vehicleGroup.count({ where }),
    ]);
    return listResult(plan, rows.map(toDto), total, CSV);
  }

  async get(ctx: AuthContext, id: string): Promise<VehicleGroupDto> {
    return toDto(await this.find(ctx, id));
  }

  async create(ctx: AuthContext, dto: CreateVehicleGroupDto): Promise<VehicleGroupDto> {
    const objectIds = [...new Set(dto.objectIds ?? [])];
    await this.assertObjects(ctx, objectIds);
    const row = await this.prisma.vehicleGroup.create({
      data: {
        companyId: ctx.companyId,
        name: dto.name.trim(),
        description: dto.description,
        isActive: dto.isActive,
        alertPriority: dto.alertPriority,
        members: { create: objectIds.map((objectId) => ({ objectId })) },
      },
      include: includeFor(ctx),
    });
    await this.audit.record(ctx, { action: 'CREATE', entity: ENTITY, entityId: row.id, after: snapshot(row) });
    await this.invalidateRules(ctx);
    return toDto(row);
  }

  async update(ctx: AuthContext, id: string, dto: UpdateVehicleGroupDto): Promise<VehicleGroupDto> {
    const before = await this.find(ctx, id);
    const objectIds = dto.objectIds ? [...new Set(dto.objectIds)] : undefined;
    if (objectIds) await this.assertObjects(ctx, objectIds);
    const row = await this.prisma.$transaction(async (tx) => {
      if (objectIds) {
        // Replace only the members the caller can see; members outside their scope stay untouched.
        await tx.vehicleGroupMember.deleteMany({ where: { groupId: id, object: objectScopeWhere(ctx) } });
        await tx.vehicleGroupMember.createMany({
          data: objectIds.map((objectId) => ({ groupId: id, objectId })),
          skipDuplicates: true,
        });
      }
      return tx.vehicleGroup.update({
        where: { id },
        data: { name: dto.name?.trim(), description: dto.description, isActive: dto.isActive, alertPriority: dto.alertPriority },
        include: includeFor(ctx),
      });
    });
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: id, before: snapshot(before), after: snapshot(row) });
    await this.invalidateRules(ctx);
    return toDto(row);
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const before = await this.find(ctx, id);
    await this.prisma.vehicleGroup.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: ENTITY, entityId: id, before: snapshot(before) });
    await this.invalidateRules(ctx);
  }

  bulk(ctx: AuthContext, dto: BulkActionDto) {
    return runBulk(ctx, 'vehicle_groups', dto, {
      setActive: (id, isActive) => this.update(ctx, id, { isActive }),
      remove: (id) => this.remove(ctx, id),
    });
  }

  async history(ctx: AuthContext, id: string) {
    await this.find(ctx, id);
    return this.audit.history(ctx, ENTITY, id);
  }

  private async find(ctx: AuthContext, id: string): Promise<Row> {
    const row = await this.prisma.vehicleGroup.findFirst({ where: { id, companyId: ctx.companyId }, include: includeFor(ctx) });
    if (!row) throw new NotFoundException('Vehicle group not found');
    return row;
  }

  private async assertObjects(ctx: AuthContext, objectIds: string[]): Promise<void> {
    if (!objectIds.length) return;
    const count = await this.prisma.trackedObject.count({ where: { AND: [objectScopeWhere(ctx), { id: { in: objectIds } }] } });
    if (count !== objectIds.length) throw new BadRequestException('Unknown object');
  }
}
