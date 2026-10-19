import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Put, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { AuthContext } from '../access/auth-context';
import { Auth, Public, RequirePermission } from '../access/decorators';
import { DriverEventQuery, DriverEventSettingsDto, MediaTokenQuery, ReviewDriverEventDto } from './driver-events.dto';
import { DriverEventsService } from './driver-events.service';

/** Driver behaviour events (ADAS / DMS / crash) with cabin / road snapshots. Menu `driver_events`. */
@Controller('driver-events')
export class DriverEventsController {
  constructor(private readonly service: DriverEventsService) {}

  /** Paged list; `?format=CSV|XLSX` downloads the filtered events (needs export). */
  @Get() @RequirePermission('driver_events', 'view')
  list(@Auth() ctx: AuthContext, @Query() q: DriverEventQuery) {
    if (q.format && !ctx.isSuperAdmin && !ctx.permissions.driver_events?.includes('export')) {
      return this.service.list(ctx, { ...q, format: undefined });
    }
    return this.service.list(ctx, q);
  }

  @Get('stats') @RequirePermission('driver_events', 'view')
  stats(@Auth() ctx: AuthContext, @Query() q: DriverEventQuery) {
    return this.service.stats(ctx, q);
  }

  @Get('settings') @RequirePermission('driver_events', 'view')
  settings(@Auth() ctx: AuthContext) {
    return this.service.settings(ctx);
  }

  @Put('settings') @RequirePermission('settings', 'edit')
  updateSettings(@Auth() ctx: AuthContext, @Body() dto: DriverEventSettingsDto) {
    return this.service.updateSettings(ctx, dto);
  }

  /** Driver event of an alert (snapshot thumbnail in the alert detail); `null` when there is none. */
  @Get('by-alert/:alertId') @RequirePermission('alerts', 'view')
  async byAlert(@Auth() ctx: AuthContext, @Param('alertId', ParseUUIDPipe) alertId: string) {
    return { event: await this.service.byAlert(ctx, alertId) };
  }

  /** Photo / clip, authorised by the signed token in the URL (for <img> / <video> tags and the mobile app). */
  @Get('media/:id') @Public()
  async media(@Param('id', ParseUUIDPipe) id: string, @Query() q: MediaTokenQuery, @Res({ passthrough: true }) res: Response) {
    const found = await this.service.media(id, q.token);
    if (!found) {
      res.status(404).json({ statusCode: 404, message: 'This photo link has expired or the photo was removed' });
      return;
    }
    res.setHeader('Cache-Control', 'private, max-age=1800');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return found.file;
  }

  @Get(':id') @RequirePermission('driver_events', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(ctx, id);
  }

  @Patch(':id/review') @RequirePermission('driver_events', 'edit')
  review(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewDriverEventDto) {
    return this.service.review(ctx, id, dto);
  }
}
