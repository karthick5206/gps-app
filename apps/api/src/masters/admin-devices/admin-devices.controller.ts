import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { BulkActionDto } from '../../common/bulk';
import { AdminDeviceListQuery, CreateAdminDeviceDto, UpdateAdminDeviceDto } from './admin-devices.dto';
import { AdminDevicesService } from './admin-devices.service';

@Controller('admin/devices')
export class AdminDevicesController {
  constructor(private readonly service: AdminDevicesService) {}

  @Get() @RequirePermission('sa_device_inventory', 'view')
  list(@Query() query: AdminDeviceListQuery) {
    return this.service.list(query);
  }

  @Get(':id') @RequirePermission('sa_device_inventory', 'view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Get(':id/history') @RequirePermission('sa_device_inventory', 'view')
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.history(id);
  }

  @Post() @RequirePermission('sa_device_inventory', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateAdminDeviceDto) {
    return this.service.create(ctx, dto);
  }

  @Post('bulk') @RequirePermission('sa_device_inventory', 'edit')
  bulk(@Auth() ctx: AuthContext, @Body() dto: BulkActionDto) {
    return this.service.bulk(ctx, dto);
  }

  @Patch(':id') @RequirePermission('sa_device_inventory', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAdminDeviceDto) {
    return this.service.update(ctx, id, dto);
  }

  @Delete(':id') @RequirePermission('sa_device_inventory', 'delete')
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(ctx, id);
    return { ok: true };
  }
}
