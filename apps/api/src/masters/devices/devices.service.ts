import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DeviceDto, RawPacketDto } from '@veetracer/shared';
import { deviceScopeWhere } from '../../access/access-rules';
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
} from './device.mapper';
import { CreateDeviceDto, DeviceListQuery, UpdateDeviceDto } from './devices.dto';

const ENTITY = 'device';
const CSV = deviceCsv('devices');

/** Devices of the caller's company (platform-wide inventory lives in AdminDevicesService). */
@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly seats: SeatsService,
  ) {}

  async list(ctx: AuthContext, query: DeviceListQuery) {
    const plan = planList<Prisma.DeviceWhereInput, Prisma.DeviceOrderByWithRelationInput>(query, DEVICE_LIST);
    const filters: Prisma.DeviceWhereInput[] = [deviceScopeWhere(ctx), plan.where];
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

  async get(ctx: AuthContext, id: string): Promise<DeviceDto> {
    return toDeviceDto(await this.find(ctx, id));
  }

  async create(ctx: AuthContext, dto: CreateDeviceDto): Promise<DeviceDto> {
    await this.assertModel(dto.modelId);
    dto = { ...dto, uniqueId: await normalizeDeviceUniqueId(this.prisma, dto.modelId, dto.uniqueId) };
    // A device takes a GPS_DEVICE / DASHCAM licence seat from the company pool (refused without one).
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.device.create({
        data: { ...dto, companyId: ctx.companyId, ingestToken: randomToken(24) },
        include: DEVICE_INCLUDE,
      });
      if (created.isActive) await this.seats.ensureDevice(tx, ctx, ctx.companyId, created.id);
      return created;
    });
    await this.audit.record(ctx, { action: 'CREATE', entity: ENTITY, entityId: row.id, after: deviceSnapshot(row) });
    await this.redis.invalidateCache('device');
    return toDeviceDto(row);
  }

  async update(ctx: AuthContext, id: string, dto: UpdateDeviceDto): Promise<DeviceDto> {
    const before = await this.find(ctx, id);
    if (dto.modelId) await this.assertModel(dto.modelId);
    if (dto.uniqueId !== undefined || dto.modelId) dto = { ...dto, uniqueId: await normalizeDeviceUniqueId(this.prisma, dto.modelId ?? before.modelId, dto.uniqueId ?? before.uniqueId) };
    const row = await this.prisma.$transaction(async (tx) => {
      if (dto.isActive === true && !before.isActive) await this.seats.ensureDevice(tx, ctx, ctx.companyId, id);
      return tx.device.update({ where: { id }, data: dto, include: DEVICE_INCLUDE });
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
    const before = await this.find(ctx, id);
    await this.prisma.device.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: ENTITY, entityId: id, before: deviceSnapshot(before) });
    await this.redis.invalidateCache('device');
  }

  bulk(ctx: AuthContext, dto: BulkActionDto) {
    return runBulk(ctx, 'devices', dto, {
      setActive: (id, isActive) => this.update(ctx, id, { isActive }),
      remove: (id) => this.remove(ctx, id),
    });
  }

  async history(ctx: AuthContext, id: string) {
    await this.find(ctx, id);
    return this.audit.history(ctx, ENTITY, id);
  }

  /** Latest raw frames of a device, newest first (support: decoding problems, protocol checks). */
  async raw(ctx: AuthContext, id: string, limit: number): Promise<RawPacketDto[]> {
    const device = await this.find(ctx, id);
    const rows = await this.prisma.rawPacket.findMany({ where: { uniqueId: device.uniqueId }, orderBy: { receivedAt: 'desc' }, take: limit });
    return rows.map((r) => ({ id: r.id.toString(), receivedAt: r.receivedAt.toISOString(), protocol: r.protocol, remoteAddress: r.remoteAddress, hex: r.hex, length: r.hex.length / 2 }));
  }

  private async find(ctx: AuthContext, id: string): Promise<DeviceRow> {
    const row = await this.prisma.device.findFirst({ where: { AND: [deviceScopeWhere(ctx), { id }] }, include: DEVICE_INCLUDE });
    if (!row) throw new NotFoundException('Device not found');
    return row;
  }

  private async assertModel(modelId: string): Promise<void> {
    const exists = await this.prisma.deviceModel.count({ where: { id: modelId } });
    if (!exists) throw new BadRequestException('Unknown device model');
  }
}
