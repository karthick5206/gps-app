import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { CreateRouteDto, CreateScheduleDto, PreviewPathDto, RouteListQuery, UpdateRouteDto, UpdateScheduleDto } from './routes.dto';
import { RoutesService } from './routes.service';

@Controller('routes')
export class RoutesController {
  constructor(private readonly service: RoutesService) {}

  @Get() @RequirePermission('routes', 'view')
  list(@Auth() ctx: AuthContext, @Query() query: RouteListQuery) {
    return this.service.list(ctx, query);
  }

  /** Road path for the editor (not saved). */
  @Post('preview-path') @RequirePermission('routes', 'view')
  previewPath(@Body() dto: PreviewPathDto) {
    return this.service.previewPath(dto);
  }

  @Get(':id') @RequirePermission('routes', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(ctx, id);
  }

  @Get(':id/history') @RequirePermission('routes', 'view')
  history(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.history(ctx, id);
  }

  @Post() @RequirePermission('routes', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateRouteDto) {
    return this.service.create(ctx, dto);
  }

  @Post(':id/copy') @RequirePermission('routes', 'create')
  copy(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.copy(ctx, id);
  }

  /** Also archives / restores (`isActive`). */
  @Patch(':id') @RequirePermission('routes', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRouteDto) {
    return this.service.update(ctx, id, dto);
  }

  /** 409 when the route has planned trips (archive it instead). */
  @Delete(':id') @RequirePermission('routes', 'delete')
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(ctx, id);
    return { ok: true };
  }

  // ───────────── schedules (part of editing a route) ─────────────

  @Get(':id/schedules') @RequirePermission('routes', 'view')
  schedules(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.listSchedules(ctx, id);
  }

  @Post(':id/schedules') @RequirePermission('routes', 'edit')
  createSchedule(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateScheduleDto) {
    return this.service.createSchedule(ctx, id, dto);
  }

  @Patch(':id/schedules/:scheduleId') @RequirePermission('routes', 'edit')
  updateSchedule(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @Body() dto: UpdateScheduleDto,
  ) {
    return this.service.updateSchedule(ctx, id, scheduleId, dto);
  }

  @Delete(':id/schedules/:scheduleId') @RequirePermission('routes', 'edit')
  async removeSchedule(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('scheduleId', ParseUUIDPipe) scheduleId: string) {
    await this.service.removeSchedule(ctx, id, scheduleId);
    return { ok: true };
  }
}
