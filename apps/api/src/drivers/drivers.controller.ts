import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthContext } from '../access/auth-context';
import { Auth, RequireAnyPermission, RequirePermission } from '../access/decorators';
import { BulkActionDto } from '../common/bulk';
import { AssignDriverDto, AssignmentQuery, CreateDriverDto, DriverListQuery, UpdateDriverDto } from './drivers.dto';
import { DriversService } from './drivers.service';

@Controller('drivers')
export class DriversController {
  constructor(private readonly service: DriversService) {}

  @Get() @RequireAnyPermission(['drivers', 'view'], ['live_map', 'view'])
  list(@Auth() ctx: AuthContext, @Query() query: DriverListQuery) {
    return this.service.list(ctx, query);
  }

  /** Driver sessions of a driver or a vehicle. */
  @Get('assignments') @RequireAnyPermission(['drivers', 'view'], ['live_map', 'view'])
  assignments(@Auth() ctx: AuthContext, @Query() query: AssignmentQuery) {
    return this.service.assignments(ctx, query);
  }

  /** Put a driver on a vehicle now, or clear it (driverId null). */
  @Post('assign') @HttpCode(200) @RequireAnyPermission(['drivers', 'edit'], ['objects', 'edit'])
  assign(@Auth() ctx: AuthContext, @Body() dto: AssignDriverDto) {
    return this.service.assign(ctx, dto);
  }

  @Post('bulk') @RequirePermission('drivers', 'edit')
  bulk(@Auth() ctx: AuthContext, @Body() dto: BulkActionDto) {
    return this.service.bulk(ctx, dto);
  }

  @Get(':id') @RequirePermission('drivers', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(ctx, id);
  }

  @Get(':id/history') @RequirePermission('drivers', 'view')
  history(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.history(ctx, id);
  }

  @Post() @RequirePermission('drivers', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateDriverDto) {
    return this.service.create(ctx, dto);
  }

  @Patch(':id') @RequirePermission('drivers', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDriverDto) {
    return this.service.update(ctx, id, dto);
  }

  @Delete(':id') @RequirePermission('drivers', 'delete')
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(ctx, id);
    return { ok: true };
  }
}
