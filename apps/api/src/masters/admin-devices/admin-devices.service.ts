import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DeviceDto } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { BulkActionDto, runBulk } from '../../common/bulk';
import { listResult, planList } from '../../common/list-query';
import { randomToken } from '../../common/secrets';
import { SeatsService } from '../../licences/seats.service';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeDeviceUniqueId } from '../device-unique-id';
import { RedisService } from '../../redis/redis.service';
import {
  assignedFilter,
  DEVICE_INCLUDE,
  DEVICE_LIST,
  deviceCsv,
  DeviceRow,
  deviceSnapshot,
  toDeviceDto,
} from '../devices/device.mapper';
import { AdminDeviceListQuery, CreateAdminDeviceDto, UpdateAdminDeviceDto } from './admin-devices.dto';

const ENTITY = 'device';
const CSV = deviceCsv('device-inventory');

/** Platform device inventory (Super Admin): every company's devices plus unallocated stock. */
@Injectable()
export class AdminDevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly seats: SeatsService,
  ) {}

  async list(query: AdminDeviceListQuery) {
    const plan = planList<Prisma.DeviceWhereInput, Prisma.DeviceOrderByWithRelationInput>(query, DEVICE_LIST);
    const filters: Prisma.DeviceWhereInput[] = [plan.where];
    if (query.companyId) filters.push({ companyId: query.companyId });
    if (query.modelId) filters.push({ modelId: query.modelId });
    const assigned = assignedFilter(query.assigned);
    if (assigned) filters.push(assigned);
    const where: Prisma.DeviceWhereInput = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.device.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: DEVICE_INCLUDE }),
      this.prisma.device.count({ where }),
    ]);
    return listResult(plan, rows.map(toDeviceDto), total, CSV);
  }

  async get(id: string): Promise<DeviceDto> {
    return toDeviceDto(await this.find(id));
  }

  async create(ctx: AuthContext, dto: CreateAdminDeviceDto): Promise<DeviceDto> {
    await this.assertRefs(dto.modelId, dto.companyId);
    dto = { ...dto, uniqueId: await normalizeDeviceUniqueId(this.prisma, dto.modelId, dto.uniqueId) };
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.device.create({ data: { ...dto, ingestToken: randomToken(24) }, include: DEVICE_INCLUDE });
      if (created.companyId && created.isActive) await this.seats.ensureDevice(tx, ctx, created.companyId, created.id);
      return created;
    });
    await this.audit.record(ctx, { action: 'CREATE', entity: ENTITY, entityId: row.id, after: deviceSnapshot(row) });
    await this.redis.invalidateCache('device');
    return toDeviceDto(row);
  }

  async update(ctx: AuthContext, id: string, dto: UpdateAdminDeviceDto): Promise<DeviceDto> {
    const before = await this.find(id);
    await this.assertRefs(dto.modelId, dto.companyId);
    if (dto.uniqueId !== undefined || dto.modelId) dto = { ...dto, uniqueId: await normalizeDeviceUniqueId(this.prisma, dto.modelId ?? before.modelId, dto.uniqueId ?? before.uniqueId) };
    const movesCompany = dto.companyId !== undefined && dto.companyId !== before.companyId;
    const row = await this.prisma.$transaction(async (tx) => {
      // A device moving to another company (or back to stock) leaves the object it was fitted to.
      if (movesCompany) {
        await tx.deviceAssignment.updateMany({ where: { deviceId: id, toTime: null }, data: { toTime: new Date() } });
      }
      // Its licence seat stays with the old company's pool; in the new company it takes a free seat there.
      if (movesCompany) await this.seats.releaseDevice(tx, id);
      const updated = await tx.device.update({ where: { id }, data: dto, include: DEVICE_INCLUDE });
      if (updated.companyId && updated.isActive && (movesCompany || (dto.isActive === true && !before.isActive))) {
        await this.seats.ensureDevice(tx, ctx, updated.companyId, id);
      }
      return updated;
    });
    await this.audit.record(ctx, {
      action: 'UPDATE',
      entity: ENTITY,
      entityId: id,
      before: deviceSnapshot(before),
      after: deviceSnapshot(row),
    });
    await this.redis.invalidateCache('device');
    return toDeviceDto(row);
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const before = await this.find(id);
    await this.prisma.device.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: ENTITY, entityId: id, before: deviceSnapshot(before) });
    await this.redis.invalidateCache('device');
  }

  bulk(ctx: AuthContext, dto: BulkActionDto) {
    return runBulk(ctx, 'sa_device_inventory', dto, {
      setActive: (id, isActive) => this.update(ctx, id, { isActive }),
      remove: (id) => this.remove(ctx, id),
    });
  }

  async history(id: string) {
    await this.find(id);
    return this.audit.platformHistory(ENTITY, id);
  }

  private async find(id: string): Promise<DeviceRow> {
    const row = await this.prisma.device.findUnique({ where: { id }, include: DEVICE_INCLUDE });
    if (!row) throw new NotFoundException('Device not found');
    return row;
  }

  private async assertRefs(modelId: string | undefined, companyId: string | null | undefined): Promise<void> {
    if (modelId && !(await this.prisma.deviceModel.count({ where: { id: modelId } }))) {
      throw new BadRequestException('Unknown device model');
    }
    if (companyId && !(await this.prisma.company.count({ where: { id: companyId } }))) {
      throw new BadRequestException('Unknown company');
    }
  }
}
