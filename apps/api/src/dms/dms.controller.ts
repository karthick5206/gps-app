import { Controller, ForbiddenException, Get, Query, StreamableFile } from '@nestjs/common';
import { DMS_COLUMNS, DMS_PERIODS, type DmsPeriod, type DmsSummaryDto, type DmsVehicleRow } from '@veetracer/shared';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { csvFile } from '../common/csv';
import { DmsService } from './dms.service';

class DmsQuery {
  @IsOptional() @IsIn(DMS_PERIODS) period?: DmsPeriod;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @IsUUID() objectId?: string;
  @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';
}

/** DMS dashboard: driver-monitoring and harsh-driving counts per vehicle and per day (JSON / CSV). */
@Controller('dms')
export class DmsController {
  constructor(private readonly dms: DmsService) {}

  @Get() @RequirePermission('dms', 'view')
  async summary(@Auth() ctx: AuthContext, @Query() q: DmsQuery): Promise<DmsSummaryDto | StreamableFile> {
    if (q.format === 'csv' && !ctx.isSuperAdmin && !ctx.permissions.dms?.includes('export')) throw new ForbiddenException('No permission to export');
    const s = await this.dms.summary(ctx, { period: q.period ?? 'today', from: q.from, to: q.to, objectId: q.objectId });
    if (q.format !== 'csv') return s;
    const total: DmsVehicleRow = { objectId: '', name: 'Total', plateNumber: null, counts: s.totals, total: s.rows.reduce((a, r) => a + r.total, 0) };
    return csvFile('dms', [...s.rows, total], [
      { header: 'Vehicle', value: (r) => r.name },
      { header: 'Plate', value: (r) => r.plateNumber ?? '' },
      ...DMS_COLUMNS.map((c) => ({ header: c.label, value: (r: DmsVehicleRow) => r.counts[c.key] })),
      { header: 'Total', value: (r) => r.total },
    ]);
  }
}
