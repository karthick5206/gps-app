import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TrackedObjectDto } from '@veetracer/shared';
import { objectScopeWhere } from '../../access/access-rules';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { BulkActionDto, runBulk } from '../../common/bulk';
import { asRecord, iso } from '../../common/dto';
import { CsvSpec, ListSpec, listResult, planList } from '../../common/list-query';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisKeys } from '../../redis/keys';
import { RedisService } from '../../redis/redis.service';
import { CreateObjectDto, ObjectListQuery, UpdateObjectDto } from './objects.dto';

const ENTITY = 'object';
const INCLUDE = {
  branch: { select: { name: true } },
  assignments: {
    where: { toTime: null },
    include: { device: { select: { id: true, uniqueId: true, model: { select: { brand: true, model: true } } } } },
  },
  groups: { include: { group: { select: { id: true, name: true } } } },
} satisfies Prisma.TrackedObjectInclude;
type Row = Prisma.TrackedObjectGetPayload<{ include: typeof INCLUDE }>;

const LIST: ListSpec = {
  search: (q) => ({
    OR: [
      { name: { contains: q, mode: 'insensitive' } },
      { plateNumber: { contains: q, mode: 'insensitive' } },
      { assignments: { some: { toTime: null, device: { uniqueId: { contains: q } } } } },
    ],
  }),
  sort: {
    name: 'name',
    plateNumber: 'plateNumber',
    type: 'type',
    vehicleType: 'vehicleType',
    branchName: 'branch.name',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  defaultSort: 'name',
};

const CSV: CsvSpec<TrackedObjectDto> = {
  name: 'objects',
  columns: [
    { header: 'Name', value: (o) => o.name },
    { header: 'Type', value: (o) => o.type },
    { header: 'Vehicle type', value: (o) => o.vehicleType },
    { header: 'Plate', value: (o) => o.plateNumber },
    { header: 'Make', value: (o) => o.make },
    { header: 'Model', value: (o) => o.model },
    { header: 'Branch', value: (o) => o.branchName },
    { header: 'Device IMEI', value: (o) => o.device?.uniqueId },
    { header: 'Groups', value: (o) => o.groups.map((g) => g.name) },
    { header: 'Speed limit', value: (o) => o.speedLimitKph },
    { header: 'Active', value: (o) => (o.isActive ? 'Yes' : 'No') },
  ],
};

function toDto(o: Row): TrackedObjectDto {
  const device = o.assignments[0]?.device;
  return {
    id: o.id,
    name: o.name,
    type: o.type,
    vehicleType: o.vehicleType,
    plateNumber: o.plateNumber,
    make: o.make,
    model: o.model,
    color: o.color,
    branchId: o.branchId,
    branchName: o.branch?.name ?? null,
    speedLimitKph: o.speedLimitKph,
    isActive: o.isActive,
    maintenanceSince: o.maintenanceSince ? iso(o.maintenanceSince) : null,
    maintenanceNote: o.maintenanceNote,
    device: device ? { id: device.id, uniqueId: device.uniqueId, modelName: `${device.model.brand} ${device.model.model}` } : null,
    groups: o.groups.map((g) => ({ id: g.group.id, name: g.group.name })),
    customFields: asRecord(o.customFields),
    createdAt: iso(o.createdAt),
    updatedAt: iso(o.updatedAt),
  };
}

function snapshot(o: Row) {
  const { branch, assignments, groups, ...scalars } = o;
  return { ...scalars, deviceId: assignments[0]?.deviceId ?? null };
}

@Injectable()
export class ObjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  async list(ctx: AuthContext, query: ObjectListQuery) {
    const plan = planList<Prisma.TrackedObjectWhereInput, Prisma.TrackedObjectOrderByWithRelationInput>(query, LIST);
    const filters: Prisma.TrackedObjectWhereInput[] = [objectScopeWhere(ctx), plan.where];
    if (query.branchId) filters.push({ branchId: query.branchId });
    if (query.groupId) filters.push({ groups: { some: { groupId: query.groupId } } });
    if (query.type) filters.push({ type: query.type });
    if (query.vehicleType) filters.push({ vehicleType: query.vehicleType });
    const where: Prisma.TrackedObjectWhereInput = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.trackedObject.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: INCLUDE }),
      this.prisma.trackedObject.count({ where }),
    ]);
    return listResult(plan, rows.map(toDto), total, CSV);
  }

  async get(ctx: AuthContext, id: string): Promise<TrackedObjectDto> {
    return toDto(await this.find(ctx, id));
  }

  async create(ctx: AuthContext, dto: CreateObjectDto): Promise<TrackedObjectDto> {
    await this.assertBranch(ctx, dto.branchId);
    if (ctx.dataScope === 'ASSIGNED' && !dto.branchId) {
      throw new ForbiddenException('Objects you create must belong to one of your branches');
    }
    const { deviceId, customFields, ...fields } = dto;
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.trackedObject.create({
        data: {
          ...fields,
          name: dto.name.trim(),
          customFields: customFields as Prisma.InputJsonValue | undefined,
          companyId: ctx.companyId,
        },
      });
      if (deviceId) await this.assignDevice(tx, ctx, created.id, deviceId);
      return tx.trackedObject.findUniqueOrThrow({ where: { id: created.id }, include: INCLUDE });
    });
    await this.audit.record(ctx, { action: 'CREATE', entity: ENTITY, entityId: row.id, after: snapshot(row) });
    await this.redis.invalidateCache('object');
    return toDto(row);
  }

  async update(ctx: AuthContext, id: string, dto: UpdateObjectDto): Promise<TrackedObjectDto> {
    const before = await this.find(ctx, id);
    if (dto.branchId !== undefined) {
      await this.assertBranch(ctx, dto.branchId);
      if (ctx.dataScope === 'ASSIGNED' && !dto.branchId) throw new ForbiddenException('You can only use your own branches');
    }
    const { deviceId, customFields, ...fields } = dto;
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.trackedObject.update({
        where: { id },
        data: { ...fields, name: dto.name?.trim(), customFields: customFields as Prisma.InputJsonValue | undefined },
      });
      if (deviceId !== undefined) await this.assignDevice(tx, ctx, id, deviceId);
      return tx.trackedObject.findUniqueOrThrow({ where: { id }, include: INCLUDE });
    });
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: id, before: snapshot(before), after: snapshot(row) });
    await this.redis.invalidateCache('object');
    return toDto(row);
  }

  /** Put a vehicle in / take it out of maintenance (alerts suppressed while in maintenance). */
  async setMaintenance(ctx: AuthContext, id: string, enabled: boolean, note: string | null): Promise<TrackedObjectDto> {
    const before = await this.find(ctx, id);
    const row = await this.prisma.trackedObject.update({
      where: { id },
      data: enabled ? { maintenanceSince: before.maintenanceSince ?? new Date(), maintenanceNote: note?.trim() || null } : { maintenanceSince: null, maintenanceNote: null },
      include: INCLUDE,
    });
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: id, before: { maintenance: !!before.maintenanceSince, note: before.maintenanceNote }, after: { maintenance: enabled, note: row.maintenanceNote } });
    await this.redis.invalidateCache('object');
    // Reflect it in the live state right away (the processor only rewrites it on the next position).
    const key = RedisKeys.live(id);
    const live = await this.redis.client.get(key);
    if (live) {
      try {
        await this.redis.client.set(key, JSON.stringify({ ...JSON.parse(live), inMaintenance: enabled }));
      } catch {
        // Corrupt live entry: the processor rewrites it on the next position.
      }
    }
    return toDto(row);
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const before = await this.find(ctx, id);
    await this.prisma.trackedObject.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: ENTITY, entityId: id, before: snapshot(before) });
    await this.redis.invalidateCache('object');
  }

  bulk(ctx: AuthContext, dto: BulkActionDto) {
    return runBulk(ctx, 'objects', dto, {
      setActive: (id, isActive) => this.update(ctx, id, { isActive }),
      remove: (id) => this.remove(ctx, id),
    });
  }

  async history(ctx: AuthContext, id: string) {
    await this.find(ctx, id);
    return this.audit.history(ctx, ENTITY, id);
  }

  private async find(ctx: AuthContext, id: string): Promise<Row> {
    const row = await this.prisma.trackedObject.findFirst({ where: { AND: [objectScopeWhere(ctx), { id }] }, include: INCLUDE });
    if (!row) throw new NotFoundException('Object not found');
    return row;
  }

  private async assertBranch(ctx: AuthContext, branchId: string | null | undefined): Promise<void> {
    if (!branchId) return;
    const exists = await this.prisma.branch.count({ where: { id: branchId, companyId: ctx.companyId } });
    if (!exists) throw new BadRequestException('Unknown branch');
    if (ctx.dataScope === 'ASSIGNED' && !ctx.branchIds.includes(branchId)) {
      throw new ForbiddenException('You can only use your own branches');
    }
  }

  /**
   * Fit `deviceId` to the object (null = remove the device). Closes the object's open assignment and the device's
   * open assignment on another object, so a device swap is a single call [DEV-02/03].
   */
  private async assignDevice(
    tx: Prisma.TransactionClient,
    ctx: AuthContext,
    objectId: string,
    deviceId: string | null,
  ): Promise<void> {
    const current = await tx.deviceAssignment.findFirst({ where: { objectId, toTime: null } });
    if (current?.deviceId === deviceId) return;
    const now = new Date();
    if (deviceId) {
      const device = await tx.device.findFirst({
        where: { id: deviceId, companyId: ctx.companyId },
        include: { assignments: { where: { toTime: null }, select: { id: true, objectId: true } } },
      });
      if (!device) throw new BadRequestException('Unknown device');
      const other = device.assignments[0];
      if (other) {
        const visible = await tx.trackedObject.count({ where: { AND: [objectScopeWhere(ctx), { id: other.objectId }] } });
        if (!visible) throw new ForbiddenException('Device is fitted to an object outside your access');
        await tx.deviceAssignment.update({ where: { id: other.id }, data: { toTime: now } });
      }
    }
    if (current) await tx.deviceAssignment.update({ where: { id: current.id }, data: { toTime: now } });
    if (deviceId) await tx.deviceAssignment.create({ data: { deviceId, objectId, fromTime: now } });
  }
}
