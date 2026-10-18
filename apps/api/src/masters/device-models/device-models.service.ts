import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DeviceModelDto } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { BulkActionDto, runBulk } from '../../common/bulk';
import { iso } from '../../common/dto';
import { CsvSpec, ListSpec, listResult, planList } from '../../common/list-query';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateDeviceModelDto, DeviceModelListQuery, UpdateDeviceModelDto } from './device-models.dto';

const ENTITY = 'device_model';
const INCLUDE = { _count: { select: { devices: true } } } satisfies Prisma.DeviceModelInclude;
type Row = Prisma.DeviceModelGetPayload<{ include: typeof INCLUDE }>;

const LIST: ListSpec = {
  search: ['brand', 'model', 'protocol'],
  sort: { brand: 'brand', model: 'model', protocol: 'protocol', createdAt: 'createdAt', updatedAt: 'updatedAt' },
  defaultSort: 'brand',
};

const CSV: CsvSpec<DeviceModelDto> = {
  name: 'device-models',
  columns: [
    { header: 'Brand', value: (m) => m.brand },
    { header: 'Model', value: (m) => m.model },
    { header: 'Protocol', value: (m) => m.protocol },
    { header: 'Capabilities', value: (m) => m.capabilities },
    { header: 'Devices', value: (m) => m.deviceCount },
    { header: 'Active', value: (m) => (m.isActive ? 'Yes' : 'No') },
  ],
};

function toDto(m: Row): DeviceModelDto {
  return {
    id: m.id,
    brand: m.brand,
    model: m.model,
    protocol: m.protocol,
    capabilities: m.capabilities,
    fields: Array.isArray(m.fields) ? (m.fields as unknown as DeviceModelDto['fields']) : [],
    commands: Array.isArray(m.commands) ? (m.commands as unknown as DeviceModelDto['commands']) : [],
    timeOffsetMinutes: m.timeOffsetMinutes,
    isActive: m.isActive,
    deviceCount: m._count.devices,
    createdAt: iso(m.createdAt),
    updatedAt: iso(m.updatedAt),
  };
}

function toData(dto: UpdateDeviceModelDto) {
  const { fields, commands, filterDefaults, ...rest } = dto;
  return {
    ...rest,
    fields: fields as Prisma.InputJsonValue | undefined,
    commands: commands as Prisma.InputJsonValue | undefined,
    filterDefaults: filterDefaults as Prisma.InputJsonValue | undefined,
  };
}

/** Platform catalogue of device models (Super Admin; readable by anyone who can view devices). */
@Injectable()
export class DeviceModelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: DeviceModelListQuery) {
    const plan = planList<Prisma.DeviceModelWhereInput, Prisma.DeviceModelOrderByWithRelationInput>(query, LIST);
    const filters: Prisma.DeviceModelWhereInput[] = [plan.where];
    if (query.protocol) filters.push({ protocol: query.protocol });
    const where: Prisma.DeviceModelWhereInput = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.deviceModel.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: INCLUDE }),
      this.prisma.deviceModel.count({ where }),
    ]);
    return listResult(plan, rows.map(toDto), total, CSV);
  }

  async get(id: string): Promise<DeviceModelDto> {
    return toDto(await this.find(id));
  }

  async create(ctx: AuthContext, dto: CreateDeviceModelDto): Promise<DeviceModelDto> {
    const row = await this.prisma.deviceModel.create({
      data: { ...toData(dto), brand: dto.brand, model: dto.model, protocol: dto.protocol },
      include: INCLUDE,
    });
    await this.audit.record(ctx, { action: 'CREATE', entity: ENTITY, entityId: row.id, after: row });
    return toDto(row);
  }

  async update(ctx: AuthContext, id: string, dto: UpdateDeviceModelDto): Promise<DeviceModelDto> {
    const before = await this.find(id);
    const row = await this.prisma.deviceModel.update({ where: { id }, data: toData(dto), include: INCLUDE });
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: id, before, after: row });
    return toDto(row);
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const before = await this.find(id);
    await this.prisma.deviceModel.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: ENTITY, entityId: id, before });
  }

  bulk(ctx: AuthContext, dto: BulkActionDto) {
    return runBulk(ctx, 'sa_device_models', dto, {
      setActive: (id, isActive) => this.update(ctx, id, { isActive }),
      remove: (id) => this.remove(ctx, id),
    });
  }

  async history(id: string) {
    await this.find(id);
    return this.audit.platformHistory(ENTITY, id);
  }

  private async find(id: string): Promise<Row> {
    const row = await this.prisma.deviceModel.findUnique({ where: { id }, include: INCLUDE });
    if (!row) throw new NotFoundException('Device model not found');
    return row;
  }
}
