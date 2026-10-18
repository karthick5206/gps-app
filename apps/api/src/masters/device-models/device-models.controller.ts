import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequireAnyPermission, RequirePermission } from '../../access/decorators';
import { BulkActionDto } from '../../common/bulk';
import { CreateDeviceModelDto, DeviceModelListQuery, UpdateDeviceModelDto } from './device-models.dto';
import { DeviceModelsService } from './device-models.service';

@Controller('device-models')
export class DeviceModelsController {
  constructor(private readonly service: DeviceModelsService) {}

  @Get() @RequireAnyPermission(['sa_device_models', 'view'], ['devices', 'view'])
  list(@Query() query: DeviceModelListQuery) {
    return this.service.list(query);
  }

  @Get(':id') @RequireAnyPermission(['sa_device_models', 'view'], ['devices', 'view'])
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Get(':id/history') @RequirePermission('sa_device_models', 'view')
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.history(id);
  }

  @Post() @RequirePermission('sa_device_models', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateDeviceModelDto) {
    return this.service.create(ctx, dto);
  }

  @Post('bulk') @RequirePermission('sa_device_models', 'edit')
  bulk(@Auth() ctx: AuthContext, @Body() dto: BulkActionDto) {
    return this.service.bulk(ctx, dto);
  }

  @Patch(':id') @RequirePermission('sa_device_models', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDeviceModelDto) {
    return this.service.update(ctx, id, dto);
  }

  @Delete(':id') @RequirePermission('sa_device_models', 'delete')
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(ctx, id);
    return { ok: true };
  }
}
