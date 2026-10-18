import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { BulkActionDto } from '../../common/bulk';
import { CreateDeviceDto, DeviceListQuery, RawQuery, UpdateDeviceDto } from './devices.dto';
import { DevicesService } from './devices.service';

@Controller('devices')
export class DevicesController {
  constructor(private readonly service: DevicesService) {}

  @Get() @RequirePermission('devices', 'view')
  list(@Auth() ctx: AuthContext, @Query() query: DeviceListQuery) {
    return this.service.list(ctx, query);
  }

  /** Raw frames: support staff only (anyone who can edit devices). */
  @Get(':id/raw') @RequirePermission('devices', 'edit')
  raw(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: RawQuery) {
    return this.service.raw(ctx, id, q.limit ?? 100);
  }

  @Get(':id') @RequirePermission('devices', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(ctx, id);
  }

  @Get(':id/history') @RequirePermission('devices', 'view')
  history(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.history(ctx, id);
  }

  @Post() @RequirePermission('devices', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateDeviceDto) {
    return this.service.create(ctx, dto);
  }

  @Post('bulk') @RequirePermission('devices', 'edit')
  bulk(@Auth() ctx: AuthContext, @Body() dto: BulkActionDto) {
    return this.service.bulk(ctx, dto);
  }

  @Patch(':id') @RequirePermission('devices', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDeviceDto) {
    return this.service.update(ctx, id, dto);
  }

  @Delete(':id') @RequirePermission('devices', 'delete')
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(ctx, id);
    return { ok: true };
  }
}
