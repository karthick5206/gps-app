import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { COMMAND_TYPES, CommandType, ReportPeriod, ReportType } from '@veetracer/shared';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth } from '../access/decorators';
import { CommandsService } from '../commands/commands.service';
import { ApiKeyController, RequireScope } from '../developer/api-key.guard';
import { WebhookEndpointDtoIn } from '../developer/developer.controller';
import { WebhooksAdminService } from '../webhooks/webhooks-admin.service';
import { ReportDataService } from '../reports/report-data.service';
import { daysBetween, isDayKey } from '../summarizer/tz';
import { PublicApiService } from './public-api.service';
import { AlertsQueryDto, idList, LiveQueryDto, PageQueryDto, RangeQueryDto, ReportQueryDto, TripsQueryDto } from './v1-query';

/** Report types offered as JSON on the public API (URL form: lower case with dashes, e.g. engine-hours). */
export const V1_REPORT_TYPES: readonly ReportType[] = [
  'SUMMARY',
  'CONSOLIDATED',
  'DISTANCE',
  'ENGINE_HOURS',
  'TRIPS',
  'STOPS',
  'IDLE',
  'HALT',
  'OVERSPEED',
  'IGNITION',
  'ALERTS',
  'EVENT_SUMMARY',
  'GEOFENCE_VISITS',
  'GEOFENCE_SUMMARY',
  'DEVICE_STATUS',
  'FUEL',
  'FUEL_EVENTS',
];
export const V1_REPORT_MAX_DAYS = 31;
export const V1_REPORT_MAX_ROWS = 5000;
const REPORT_PERIODS: readonly ReportPeriod[] = ['DAY', 'WEEK', 'MONTH'];
const API_COMMANDS = COMMAND_TYPES.filter((t) => t !== 'custom');

export const reportSlug = (t: ReportType) => t.toLowerCase().replace(/_/g, '-');

class V1CommandDto {
  @IsIn(API_COMMANDS) type!: CommandType;
  @IsOptional() @IsString() @Length(1, 200) text?: string;
}

@Controller('v1')
@ApiKeyController()
export class PublicApiController {
  constructor(
    private readonly api: PublicApiService,
    private readonly reports: ReportDataService,
    private readonly commands: CommandsService,
    private readonly webhooks: WebhooksAdminService,
  ) {}

  @Get('vehicles') @RequireScope('read:vehicles')
  vehicles(@Auth() ctx: AuthContext, @Query() q: PageQueryDto) {
    return this.api.vehicles(ctx, q);
  }

  @Get('vehicles/live') @RequireScope('read:positions')
  live(@Auth() ctx: AuthContext, @Query() q: LiveQueryDto) {
    return this.api.liveAll(ctx, q.vehicleIds);
  }

  @Get('vehicles/:id/positions') @RequireScope('read:positions')
  positions(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: RangeQueryDto) {
    return this.api.positions(ctx, id, q);
  }

  @Get('trips') @RequireScope('read:trips')
  trips(@Auth() ctx: AuthContext, @Query() q: TripsQueryDto) {
    return this.api.trips(ctx, q);
  }

  @Get('stops') @RequireScope('read:trips')
  stops(@Auth() ctx: AuthContext, @Query() q: TripsQueryDto) {
    return this.api.stops(ctx, q);
  }

  @Get('alerts') @RequireScope('read:alerts')
  alerts(@Auth() ctx: AuthContext, @Query() q: AlertsQueryDto) {
    return this.api.alerts(ctx, q);
  }

  @Get('reports/:type') @RequireScope('read:reports')
  async report(@Auth() ctx: AuthContext, @Param('type') slug: string, @Query() q: ReportQueryDto) {
    const type = V1_REPORT_TYPES.find((t) => reportSlug(t) === slug.toLowerCase().replace(/_/g, '-'));
    if (!type) throw new BadRequestException(`Unknown report "${slug}". Available: ${V1_REPORT_TYPES.map(reportSlug).join(', ')}`);
    if (!q.from || !q.to || !isDayKey(q.from) || !isDayKey(q.to)) throw new BadRequestException('from and to are required dates (YYYY-MM-DD, company time zone)');
    if (q.to < q.from) throw new BadRequestException('to must not be before from');
    if (daysBetween(q.from, q.to) >= V1_REPORT_MAX_DAYS) throw new BadRequestException(`The range may span at most ${V1_REPORT_MAX_DAYS} days`);
    if (q.period && !(REPORT_PERIODS as readonly string[]).includes(q.period.toUpperCase())) throw new BadRequestException(`period must be one of ${REPORT_PERIODS.join(', ')}`);
    const r = await this.reports.generate(
      ctx,
      {
        type,
        from: q.from,
        to: q.to,
        scope: { branchIds: [], groupIds: [], objectIds: await this.api.reportObjectIds(ctx, idList(q.vehicleIds)) },
        ...(q.period ? { period: q.period.toUpperCase() as ReportPeriod } : {}),
      },
      V1_REPORT_MAX_ROWS,
    );
    return {
      data: r.rows,
      meta: {
        report: reportSlug(type),
        from: r.from,
        to: r.to,
        timezone: r.tz,
        period: r.period ?? null,
        totals: r.totals,
        count: r.rows.length,
        totalRows: r.totalRows,
        truncated: r.truncated,
      },
    };
  }

  @Post('vehicles/:id/commands') @HttpCode(202) @RequireScope('write:commands')
  async sendCommand(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: V1CommandDto) {
    await this.api.assertVehicleInPlan(ctx, id);
    const c = await this.commands.send(ctx, id, { type: body.type, text: body.text });
    return { data: commandOut(c) };
  }

  @Get('vehicles/:id/commands') @RequireScope('write:commands')
  async listCommands(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.api.assertVehicleInPlan(ctx, id);
    const rows = await this.commands.list(ctx, id);
    return { data: rows.map(commandOut), meta: { count: rows.length, nextCursor: null } };
  }
  @Get('webhooks') @RequireScope('webhooks')
  async listWebhooks(@Auth() ctx: AuthContext) {
    const rows = await this.webhooks.list(ctx);
    return { data: rows, meta: { count: rows.length, nextCursor: null } };
  }

  @Post('webhooks') @RequireScope('webhooks')
  async createWebhook(@Auth() ctx: AuthContext, @Body() body: WebhookEndpointDtoIn) {
    const r = await this.webhooks.create(ctx, body);
    return { data: { ...r.endpoint, secret: r.secret } };
  }

  @Delete('webhooks/:id') @HttpCode(204) @RequireScope('webhooks')
  async deleteWebhook(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.webhooks.remove(ctx, id);
  }
}

function commandOut(
c: Awaited<ReturnType<CommandsService['send']>>) {
  return {
    id: c.id,
    vehicleId: c.objectId,
    imei: c.uniqueId,
    type: c.type,
    status: c.status,
    response: c.response,
    error: c.error,
    createdAt: c.createdAt,
    sentAt: c.sentAt,
    acknowledgedAt: c.ackAt,
    expiresAt: c.expiresAt,
  };
}
