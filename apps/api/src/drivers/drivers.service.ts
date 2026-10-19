import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DriverAssignmentDto, DriverAssignmentSource, DriverDto, normalizeRfidTag } from '@veetracer/shared';
import { objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { BulkActionDto, runBulk } from '../common/bulk';
import { iso, isoOrNull } from '../common/dto';
import { CsvSpec, ListSpec, listResult, planList } from '../common/list-query';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { switchDriver } from './driver-sessions';
import { AssignDriverDto, AssignmentQuery, CreateDriverDto, DriverListQuery, UpdateDriverDto } from './drivers.dto';

const ENTITY = 'driver';
const INCLUDE = {
  branch: { select: { name: true } },
  assignments: { where: { toTime: null }, take: 1, include: { object: { select: { name: true } } } },
} satisfies Prisma.DriverInclude;
type Row = Prisma.DriverGetPayload<{ include: typeof INCLUDE }>;

const LIST: ListSpec = {
  search: ['name', 'mobile', 'employeeId', 'licenseNo', 'rfidTag'],
  sort: { name: 'name', employeeId: 'employeeId', licenseExpiry: 'licenseExpiry', branchName: 'branch.name', createdAt: 'createdAt' },
  defaultSort: 'name',
};

const CSV: CsvSpec<DriverDto> = {
  name: 'drivers',
  columns: [
    { header: 'Name', value: (d) => d.name },
    { header: 'Employee ID', value: (d) => d.employeeId },
    { header: 'Mobile', value: (d) => d.mobile },
    { header: 'Licence no.', value: (d) => d.licenseNo },
    { header: 'Licence expiry', value: (d) => d.licenseExpiry },
    { header: 'RFID tag', value: (d) => d.rfidTag },
    { header: 'Branch', value: (d) => d.branchName },
    { header: 'Driving now', value: (d) => d.current?.objectName ?? null },
    { header: 'Active', value: (d) => (d.isActive ? 'Yes' : 'No') },
    { header: 'Created', value: (d) => d.createdAt },
  ],
};

const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const blank = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() ? v.trim() : null);

function toDto(d: Row): DriverDto {
  const a = d.assignments[0];
  return {
    id: d.id,
    name: d.name,
    mobile: d.mobile,
    employeeId: d.employeeId,
    licenseNo: d.licenseNo,
    licenseExpiry: ymd(d.licenseExpiry),
    rfidTag: d.rfidTag,
    branchId: d.branchId,
    branchName: d.branch?.name ?? null,
    notes: d.notes,
    isActive: d.isActive,
    current: a ? { objectId: a.objectId, objectName: a.object.name, since: iso(a.fromTime), source: a.source as DriverAssignmentSource } : null,
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  };
}

/** Drivers of the caller's company; ASSIGNED scope sees its branches' drivers and company-wide (no branch) drivers. */
export function driverScopeWhere(ctx: Pick<AuthContext, 'companyId' | 'dataScope' | 'branchIds'>): Prisma.DriverWhereInput {
  if (ctx.dataScope === 'COMPANY') return { companyId: ctx.companyId };
  return { companyId: ctx.companyId, OR: [{ branchId: null }, { branchId: { in: ctx.branchIds } }] };
}

@Injectable()
export class DriversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  async list(ctx: AuthContext, query: DriverListQuery) {
    const plan = planList<Prisma.DriverWhereInput, Prisma.DriverOrderByWithRelationInput>(query, LIST);
    const filters: Prisma.DriverWhereInput[] = [driverScopeWhere(ctx), plan.where];
    if (query.branchId) filters.push({ branchId: query.branchId });
    if (query.driving) filters.push({ assignments: query.driving === 'on' ? { some: { toTime: null } } : { none: { toTime: null } } });
    const where: Prisma.DriverWhereInput = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.driver.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: INCLUDE }),
      this.prisma.driver.count({ where }),
    ]);
    return listResult(plan, rows.map(toDto), total, CSV);
  }

  async get(ctx: AuthContext, id: string): Promise<DriverDto> {
    return toDto(await this.find(ctx, id));
  }

  async create(ctx: AuthContext, dto: CreateDriverDto): Promise<DriverDto> {
    await this.assertBranch(ctx, dto.branchId, true);
    const row = await this.prisma.driver.create({ data: { ...(this.data(dto) as Omit<Prisma.DriverUncheckedCreateInput, 'companyId' | 'name'>), companyId: ctx.companyId, name: dto.name.trim() }, include: INCLUDE });
    await this.audit.record(ctx, { action: 'CREATE', entity: ENTITY, entityId: row.id, after: row });
    return toDto(row);
  }

  async update(ctx: AuthContext, id: string, dto: UpdateDriverDto): Promise<DriverDto> {
    const before = await this.find(ctx, id);
    await this.assertBranch(ctx, dto.branchId);
    const data = this.data(dto);
    // New licence expiry: licence reminders start over.
    if (dto.licenseExpiry !== undefined && (dto.licenseExpiry?.slice(0, 10) ?? null) !== ymd(before.licenseExpiry)) data.licenseNotifiedState = null;
    const row = await this.prisma.driver.update({ where: { id }, data, include: INCLUDE });
    // A deactivated driver leaves the vehicle.
    if (dto.isActive === false && before.assignments[0]) await this.assign(ctx, { objectId: before.assignments[0].objectId, driverId: null });
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: id, before, after: row });
    if (dto.name !== undefined || dto.rfidTag !== undefined) await this.redis.invalidateCache('driver:update');
    return toDto(row);
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const before = await this.find(ctx, id);
    await this.prisma.driver.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: ENTITY, entityId: id, before });
    if (before.assignments[0]) await this.redis.invalidateCache('driver:delete');
  }

  bulk(ctx: AuthContext, dto: BulkActionDto) {
    return runBulk(ctx, 'drivers', dto, {
      setActive: (id, isActive) => this.update(ctx, id, { isActive }),
      remove: (id) => this.remove(ctx, id),
    });
  }

  async history(ctx: AuthContext, id: string) {
    await this.find(ctx, id);
    return this.audit.history(ctx, ENTITY, id);
  }

  /** Puts a driver on a vehicle now (driverId null = no driver). */
  async assign(ctx: AuthContext, dto: AssignDriverDto): Promise<{ changed: boolean }> {
    const object = await this.prisma.trackedObject.findFirst({ where: { AND: [objectScopeWhere(ctx), { id: dto.objectId }] }, select: { id: true } });
    if (!object) throw new NotFoundException('Vehicle not found');
    if (dto.driverId) {
      const driver = await this.find(ctx, dto.driverId);
      if (!driver.isActive) throw new BadRequestException('This driver is inactive');
    }
    const changed = await switchDriver(this.prisma, { companyId: ctx.companyId, objectId: dto.objectId, driverId: dto.driverId, at: new Date(), source: 'MANUAL', createdById: ctx.userId });
    if (changed) {
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'object', entityId: dto.objectId, details: { driverId: dto.driverId } });
      await this.redis.invalidateCache('driver:assign');
    }
    return { changed };
  }

  /** Driver sessions for a driver or a vehicle (latest first, last 200). */
  async assignments(ctx: AuthContext, q: AssignmentQuery): Promise<DriverAssignmentDto[]> {
    if (!q.driverId && !q.objectId) throw new BadRequestException('driverId or objectId is required');
    const rows = await this.prisma.driverAssignment.findMany({
      where: {
        companyId: ctx.companyId,
        ...(q.driverId ? { driverId: q.driverId, driver: driverScopeWhere(ctx) } : {}),
        ...(q.objectId ? { objectId: q.objectId } : {}),
        object: objectScopeWhere(ctx),
      },
      orderBy: { fromTime: 'desc' },
      take: 200,
      include: { driver: { select: { name: true } }, object: { select: { name: true } } },
    });
    const userIds = [...new Set(rows.map((r) => r.createdById).filter((v): v is string => !!v))];
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const names = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      id: r.id,
      driverId: r.driverId,
      driverName: r.driver.name,
      objectId: r.objectId,
      objectName: r.object.name,
      fromTime: iso(r.fromTime),
      toTime: isoOrNull(r.toTime),
      source: r.source as DriverAssignmentSource,
      createdByName: r.createdById ? (names.get(r.createdById) ?? null) : null,
    }));
  }

  private data(dto: UpdateDriverDto): Prisma.DriverUncheckedUpdateInput {
    const rfid = dto.rfidTag === undefined ? undefined : dto.rfidTag ? normalizeRfidTag(dto.rfidTag) || null : null;
    return {
      name: dto.name?.trim(),
      mobile: blank(dto.mobile),
      employeeId: blank(dto.employeeId),
      licenseNo: blank(dto.licenseNo),
      licenseExpiry: dto.licenseExpiry === undefined ? undefined : dto.licenseExpiry ? new Date(`${dto.licenseExpiry.slice(0, 10)}T00:00:00Z`) : null,
      rfidTag: rfid,
      branchId: dto.branchId,
      notes: blank(dto.notes),
      isActive: dto.isActive,
    };
  }

  /** Branch must be the caller's; branch-scoped users can't create company-wide drivers. */
  private async assertBranch(ctx: AuthContext, branchId: string | null | undefined, creating = false): Promise<void> {
    if (!branchId) {
      if (ctx.dataScope !== 'COMPANY' && (creating || branchId === null)) throw new BadRequestException('Choose one of your branches');
      return;
    }
    const ok = await this.prisma.branch.count({ where: { AND: [{ id: branchId, companyId: ctx.companyId }, ctx.dataScope === 'COMPANY' ? {} : { id: { in: ctx.branchIds } }] } });
    if (!ok) throw new BadRequestException('Branch not found');
  }

  private async find(ctx: AuthContext, id: string): Promise<Row> {
    const row = await this.prisma.driver.findFirst({ where: { AND: [driverScopeWhere(ctx), { id }] }, include: INCLUDE });
    if (!row) throw new NotFoundException('Driver not found');
    return row;
  }
}
