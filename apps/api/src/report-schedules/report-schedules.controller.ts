import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { BulkActionDto } from '../common/bulk';
import {
  CreateReportScheduleDto,
  ReportRunsQuery,
  ReportScheduleListQuery,
  UpdateReportScheduleDto,
} from './report-schedules.dto';
import { ReportSchedulesService } from './report-schedules.service';

@Controller('report-schedules')
export class ReportSchedulesController {
  constructor(private readonly service: ReportSchedulesService) {}

  @Get() @RequirePermission('report_schedules', 'view')
  list(@Auth() ctx: AuthContext, @Query() query: ReportScheduleListQuery) {
    return this.service.list(ctx, query);
  }

  @Get(':id') @RequirePermission('report_schedules', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(ctx, id);
  }

  @Get(':id/history') @RequirePermission('report_schedules', 'view')
  history(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.history(ctx, id);
  }

  @Post() @RequirePermission('report_schedules', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateReportScheduleDto) {
    return this.service.create(ctx, dto);
  }

  @Post('bulk') @RequirePermission('report_schedules', 'edit')
  bulk(@Auth() ctx: AuthContext, @Body() dto: BulkActionDto) {
    return this.service.bulk(ctx, dto);
  }

  /** Generate and e-mail now for the previous complete period; returns the finished ReportRunDto. */
  @Post(':id/run-now') @HttpCode(200) @RequirePermission('report_schedules', 'edit')
  runNow(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.runNow(ctx, id);
  }

  @Patch(':id') @RequirePermission('report_schedules', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateReportScheduleDto) {
    return this.service.update(ctx, id, dto);
  }

  @Delete(':id') @RequirePermission('report_schedules', 'delete')
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(ctx, id);
    return { ok: true };
  }
}

@Controller('report-runs')
export class ReportRunsController {
  constructor(private readonly service: ReportSchedulesService) {}

  @Get() @RequirePermission('report_schedules', 'view')
  list(@Auth() ctx: AuthContext, @Query() query: ReportRunsQuery) {
    return this.service.listRuns(ctx, query.scheduleId);
  }

  @Get(':id/file') @RequirePermission('report_schedules', 'view')
  file(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.runFile(ctx, id);
  }
}
