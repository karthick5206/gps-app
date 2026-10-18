import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { BulkActionDto } from '../../common/bulk';
import { CreateVehicleGroupDto, UpdateVehicleGroupDto, VehicleGroupListQuery } from './vehicle-groups.dto';
import { VehicleGroupsService } from './vehicle-groups.service';

@Controller('vehicle-groups')
export class VehicleGroupsController {
  constructor(private readonly service: VehicleGroupsService) {}

  @Get() @RequirePermission('vehicle_groups', 'view')
  list(@Auth() ctx: AuthContext, @Query() query: VehicleGroupListQuery) {
    return this.service.list(ctx, query);
  }

  @Get(':id') @RequirePermission('vehicle_groups', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(ctx, id);
  }

  @Get(':id/history') @RequirePermission('vehicle_groups', 'view')
  history(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.history(ctx, id);
  }

  @Post() @RequirePermission('vehicle_groups', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateVehicleGroupDto) {
    return this.service.create(ctx, dto);
  }

  @Post('bulk') @RequirePermission('vehicle_groups', 'edit')
  bulk(@Auth() ctx: AuthContext, @Body() dto: BulkActionDto) {
    return this.service.bulk(ctx, dto);
  }

  @Patch(':id') @RequirePermission('vehicle_groups', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVehicleGroupDto) {
    return this.service.update(ctx, id, dto);
  }

  @Delete(':id') @RequirePermission('vehicle_groups', 'delete')
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(ctx, id);
    return { ok: true };
  }
}
