import { Controller, Get, Query } from '@nestjs/common';
import { Prisma, UnknownDevice } from '@prisma/client';
import { UnknownDeviceDto } from '@veetracer/shared';
import { RequirePermission } from '../../access/decorators';
import { iso } from '../../common/dto';
import { CsvSpec, ListQueryDto, ListSpec, listResult, planList } from '../../common/list-query';
import { PrismaService } from '../../prisma/prisma.service';

const LIST: ListSpec = {
  search: ['uniqueId', 'remoteAddress'],
  sort: { uniqueId: 'uniqueId', lastSeenAt: 'lastSeenAt', firstSeenAt: 'firstSeenAt', packetCount: 'packetCount' },
  defaultSort: 'lastSeenAt',
  defaultOrder: 'desc',
  status: null,
  tiebreaker: 'uniqueId',
};

const CSV: CsvSpec<UnknownDeviceDto> = {
  name: 'unknown-devices',
  columns: [
    { header: 'Unique ID', value: (d) => d.uniqueId },
    { header: 'Protocol', value: (d) => d.protocol },
    { header: 'Remote address', value: (d) => d.remoteAddress },
    { header: 'First seen', value: (d) => d.firstSeenAt },
    { header: 'Last seen', value: (d) => d.lastSeenAt },
    { header: 'Packets', value: (d) => d.packetCount },
  ],
};

const toDto = (d: UnknownDevice): UnknownDeviceDto => ({
  uniqueId: d.uniqueId,
  protocol: d.protocol,
  remoteAddress: d.remoteAddress,
  firstSeenAt: iso(d.firstSeenAt),
  lastSeenAt: iso(d.lastSeenAt),
  packetCount: d.packetCount,
});

/** Devices that sent data but are not registered (written by the processor). Read-only. */
@Controller('admin/unknown-devices')
export class UnknownDevicesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get() @RequirePermission('sa_unknown_devices', 'view')
  async list(@Query() query: ListQueryDto) {
    const plan = planList<Prisma.UnknownDeviceWhereInput, Prisma.UnknownDeviceOrderByWithRelationInput>(query, LIST);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.unknownDevice.findMany({ where: plan.where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take }),
      this.prisma.unknownDevice.count({ where: plan.where }),
    ]);
    return listResult(plan, rows.map(toDto), total, CSV);
  }
}
