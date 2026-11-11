import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import type {
  DriverDutyDto,
  DriverDutyTodayDto,
  DriverMeDto,
  DriverStartTripResult,
  DriverSyncDto,
  DriverTripDetailDto,
  DriverTripEventBatchResult,
  DriverTripHistoryDto,
  DriverTripSummaryDto,
  TransportNotificationDto,
  TransportNotificationPreferences,
} from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { PeopleService } from '../people/people.service';
import { TransportFeatureGuard } from '../transport-feature.guard';
import { cleanPreferences, preferencesOf, TransportNotificationsService } from '../notifications/transport-notifications.service';
import { DriverApiService } from './driver-api.service';
import { resolveDriver } from './driver-identity';
import { DriverDutyEndDto, DriverDutyStartDto, DriverStartTripDto, DriverSyncQuery, DriverTripEventBatchDto, DriverTripListDto, NotificationListDto, NotificationPreferencesDto, NotificationReadDto } from './driver.dto';

/**
 * /api/driver/v1 (doc 05 §2.9, 09). Menu `etms_driver` (view = reads, edit = commands) AND the caller's own active
 * Driver (resolveDriver: 403 NOT_A_DRIVER / DRIVER_INACTIVE); trips not assigned to that driver are 404.
 */
@Controller('driver/v1')
@UseGuards(TransportFeatureGuard)
export class DriverController {
  constructor(
    private readonly driver: DriverApiService,
    private readonly notifications: TransportNotificationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('me') @RequirePermission('etms_driver', 'view')
  me(@Auth() ctx: AuthContext): Promise<DriverMeDto> {
    return this.driver.me(ctx);
  }

  @Get('duty') @RequirePermission('etms_driver', 'view')
  duty(@Auth() ctx: AuthContext): Promise<DriverDutyTodayDto> {
    return this.driver.dutyToday(ctx);
  }

  @Post('duty/start') @HttpCode(200) @RequirePermission('etms_driver', 'edit')
  startDuty(@Auth() ctx: AuthContext, @Body() dto: DriverDutyStartDto): Promise<DriverDutyDto> {
    return this.driver.startDuty(ctx, dto);
  }

  @Post('duty/end') @HttpCode(200) @RequirePermission('etms_driver', 'edit')
  endDuty(@Auth() ctx: AuthContext, @Body() dto: DriverDutyEndDto): Promise<DriverDutyDto> {
    return this.driver.endDuty(ctx, dto);
  }

  @Get('trips') @RequirePermission('etms_driver', 'view')
  trips(@Auth() ctx: AuthContext, @Query() q: DriverTripListDto): Promise<DriverTripSummaryDto[]> {
    return this.driver.trips(ctx, q);
  }

  @Get('trips/history') @RequirePermission('etms_driver', 'view')
  history(@Auth() ctx: AuthContext, @Query() q: DriverTripListDto): Promise<DriverTripHistoryDto[]> {
    return this.driver.history(ctx, q);
  }

  @Get('trips/:id') @RequirePermission('etms_driver', 'view')
  trip(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<DriverTripDetailDto> {
    return this.driver.trip(ctx, id);
  }

  @Post('trips/:id/start') @HttpCode(200) @RequirePermission('etms_driver', 'edit')
  start(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DriverStartTripDto): Promise<DriverStartTripResult> {
    return this.driver.startTrip(ctx, id, dto);
  }

  @Post('trips/:id/events') @HttpCode(200) @RequirePermission('etms_driver', 'edit')
  events(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DriverTripEventBatchDto): Promise<DriverTripEventBatchResult> {
    return this.driver.events(ctx, id, dto);
  }

  @Get('sync') @RequirePermission('etms_driver', 'view')
  sync(@Auth() ctx: AuthContext, @Query() q: DriverSyncQuery): Promise<DriverSyncDto> {
    return this.driver.sync(ctx, q);
  }

  @Get('notifications') @RequirePermission('etms_driver', 'view')
  async notificationList(@Auth() ctx: AuthContext, @Query() q: NotificationListDto): Promise<TransportNotificationDto[]> {
    await resolveDriver(this.prisma, ctx);
    return this.notifications.list(ctx, 'DRIVER', q);
  }

  @Post('notifications/read') @HttpCode(200) @RequirePermission('etms_driver', 'view')
  async notificationRead(@Auth() ctx: AuthContext, @Body() dto: NotificationReadDto): Promise<{ updated: number }> {
    await resolveDriver(this.prisma, ctx);
    return this.notifications.markRead(ctx, 'DRIVER', dto);
  }
}

/**
 * /api/me/transport/notifications (05 §2.8): the passenger's own in-app notification history and push preferences.
 * etms_self + the caller's own active passenger profile (403 NOT_A_PASSENGER otherwise), like the E2 consent routes.
 */
@Controller('me/transport/notifications')
@UseGuards(TransportFeatureGuard)
export class MyTransportNotificationsController {
  constructor(
    private readonly notifications: TransportNotificationsService,
    private readonly people: PeopleService,
    private readonly prisma: PrismaService,
  ) {}

  @Get() @RequirePermission('etms_self', 'view')
  async list(@Auth() ctx: AuthContext, @Query() q: NotificationListDto): Promise<TransportNotificationDto[]> {
    await this.people.myProfileRow(ctx);
    return this.notifications.list(ctx, 'PASSENGER', q);
  }

  @Post('read') @HttpCode(200) @RequirePermission('etms_self', 'view')
  async read(@Auth() ctx: AuthContext, @Body() dto: NotificationReadDto): Promise<{ updated: number }> {
    await this.people.myProfileRow(ctx);
    return this.notifications.markRead(ctx, 'PASSENGER', dto);
  }

  @Get('preferences') @RequirePermission('etms_self', 'view')
  async preferences(@Auth() ctx: AuthContext): Promise<TransportNotificationPreferences> {
    return preferencesOf((await this.people.myProfileRow(ctx)).preferences);
  }

  /** Push switches only: the in-app record of an operational notification is always kept. */
  @Put('preferences') @RequirePermission('etms_self', 'view')
  async setPreferences(@Auth() ctx: AuthContext, @Body() dto: NotificationPreferencesDto): Promise<TransportNotificationPreferences> {
    const me = await this.people.myProfileRow(ctx);
    const prefs = cleanPreferences(dto);
    const base = me.preferences && typeof me.preferences === 'object' && !Array.isArray(me.preferences) ? (me.preferences as Record<string, unknown>) : {};
    await this.prisma.employeeTransportProfile.updateMany({ where: { id: me.id, companyId: ctx.companyId, userId: ctx.userId }, data: { preferences: { ...base, notifications: { ...prefs } } } });
    return prefs;
  }
}
