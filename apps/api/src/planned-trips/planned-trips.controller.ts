import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { CancelPlannedTripDto, CreatePlannedTripDto, ManualTripActionDto, PlannedTripListQuery, UpdatePlannedTripDto } from './planned-trips.dto';
import { PlannedTripsService } from './planned-trips.service';

@Controller('planned-trips')
export class PlannedTripsController {
  constructor(private readonly service: PlannedTripsService) {}

  @Get() @RequirePermission('plannedTrips', 'view')
  list(@Auth() ctx: AuthContext, @Query() query: PlannedTripListQuery) {
    return this.service.list(ctx, query);
  }

  @Get(':id') @RequirePermission('plannedTrips', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(ctx, id);
  }

  @Get(':id/history') @RequirePermission('plannedTrips', 'view')
  history(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.history(ctx, id);
  }

  /** One-off trip. */
  @Post() @RequirePermission('plannedTrips', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreatePlannedTripDto) {
    return this.service.create(ctx, dto);
  }

  /** Only while SCHEDULED. */
  @Patch(':id') @RequirePermission('plannedTrips', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePlannedTripDto) {
    return this.service.update(ctx, id, dto);
  }

  @Post(':id/cancel') @RequirePermission('plannedTrips', 'edit')
  cancel(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelPlannedTripDto) {
    return this.service.cancel(ctx, id, dto);
  }

  @Post(':id/start') @RequirePermission('plannedTrips', 'edit')
  start(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ManualTripActionDto) {
    return this.service.start(ctx, id, dto);
  }

  @Post(':id/complete') @RequirePermission('plannedTrips', 'edit')
  complete(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ManualTripActionDto) {
    return this.service.complete(ctx, id, dto);
  }
}
