import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import type { DispatchRequestDto, DriverRouteAckResult, LiveDispatchDecisionDto, PoolingSettingsDto, TransportBookingDto, TransportSharingPolicyDto, VehicleAvailabilityDto } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { PeopleService } from '../people/people.service';
import { TransportFeatureGuard } from '../transport-feature.guard';
import { LiveDispatchService } from './live-dispatch.service';
import { DispatchRequestQuery, DriverPolicyBody, HoldDto, LiveDecideDto, PoolingSettingsBody, PutAvailabilityDto, RouteAckDto, SharingPolicyBody } from './pooling.dto';
import { PoolingService } from './pooling.service';

/**
 * Pooling administration (doc 20 §6): dispatcher hold, sharing policy, pooling / live-dispatch settings, driver
 * working-hour policy, vehicle availability. Own company only (other tenants' ids 404); branch scope as the E3 routes.
 */
@Controller('transport')
@UseGuards(TransportFeatureGuard)
export class PoolingController {
  constructor(private readonly pooling: PoolingService) {}

  /** Dispatcher hold: excluded from plans and live dispatch without cancelling (audited). */
  @Patch('bookings/:id/hold') @RequirePermission('etms_dispatch', 'edit')
  hold(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: HoldDto): Promise<TransportBookingDto> {
    return this.pooling.hold(ctx, id, dto);
  }

  @Get('sharing-policy') @RequirePermission('etms_bookings', 'view')
  policy(@Auth() ctx: AuthContext): Promise<TransportSharingPolicyDto> {
    return this.pooling.policy(ctx);
  }

  /** A new policy version (append-only; accepted bookings keep theirs). Whole-company scope. */
  @Put('sharing-policy') @RequirePermission('etms_settings', 'edit')
  updatePolicy(@Auth() ctx: AuthContext, @Body() dto: SharingPolicyBody): Promise<TransportSharingPolicyDto> {
    return this.pooling.updatePolicy(ctx, dto);
  }

  @Get('pooling/settings') @RequirePermission('etms_dispatch', 'view')
  settings(@Auth() ctx: AuthContext): Promise<PoolingSettingsDto> {
    return this.pooling.settings(ctx);
  }

  /** Live dispatch switch (default OFF), policies, delay threshold, driver hours. Whole-company scope; audited. */
  @Put('pooling/settings') @RequirePermission('etms_settings', 'edit')
  updateSettings(@Auth() ctx: AuthContext, @Body() dto: PoolingSettingsBody): Promise<PoolingSettingsDto> {
    return this.pooling.updateSettings(ctx, dto);
  }

  @Put('driver-policy') @RequirePermission('etms_settings', 'edit')
  driverPolicy(@Auth() ctx: AuthContext, @Body() dto: DriverPolicyBody): Promise<PoolingSettingsDto> {
    return this.pooling.updateDriverPolicy(ctx, dto.policy);
  }

  @Get('vehicles/:objectId/availability') @RequirePermission('objects', 'view')
  availability(@Auth() ctx: AuthContext, @Param('objectId', ParseUUIDPipe) objectId: string): Promise<VehicleAvailabilityDto> {
    return this.pooling.availability(ctx, objectId);
  }

  @Put('vehicles/:objectId/availability') @RequirePermission('objects', 'edit')
  putAvailability(@Auth() ctx: AuthContext, @Param('objectId', ParseUUIDPipe) objectId: string, @Body() dto: PutAvailabilityDto): Promise<VehicleAvailabilityDto> {
    return this.pooling.putAvailability(ctx, objectId, dto);
  }
}

/** Live dispatch (doc 20 §5–6): "find a vehicle" for a booking (+ apply), and the decision log. */
@Controller('transport/dispatch/live')
@UseGuards(TransportFeatureGuard)
export class LiveDispatchController {
  constructor(private readonly live: LiveDispatchService) {}

  @Post('decide') @HttpCode(200) @RequirePermission('etms_dispatch', 'command')
  decide(@Auth() ctx: AuthContext, @Body() dto: LiveDecideDto, @Headers('idempotency-key') key: string | undefined): Promise<LiveDispatchDecisionDto> {
    return this.live.decide(ctx, dto, key);
  }

  @Get('requests') @RequirePermission('etms_dispatch', 'view')
  requests(@Auth() ctx: AuthContext, @Query() q: DispatchRequestQuery): Promise<DispatchRequestDto[]> {
    return this.live.requests(ctx, q);
  }
}

/** The passenger's view of the sharing policy before accepting it (self-service; the caller must be a passenger). */
@Controller('me/transport')
@UseGuards(TransportFeatureGuard)
export class MySharingPolicyController {
  constructor(
    private readonly pooling: PoolingService,
    private readonly people: PeopleService,
  ) {}

  @Get('sharing-policy') @RequirePermission('etms_self', 'view')
  async policy(@Auth() ctx: AuthContext): Promise<TransportSharingPolicyDto> {
    await this.people.myProfileRow(ctx); // 403 NOT_A_PASSENGER for a login without a passenger profile
    return this.pooling.policy(ctx);
  }
}

/** P5: the driver acknowledges a live change of a started trip (own trip only, else 404). */
@Controller('driver/v1')
@UseGuards(TransportFeatureGuard)
export class DriverRouteAckController {
  constructor(private readonly live: LiveDispatchService) {}

  @Post('trips/:id/route-ack') @HttpCode(200) @RequirePermission('etms_driver', 'edit')
  ack(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RouteAckDto): Promise<DriverRouteAckResult> {
    return this.live.routeAck(ctx, id, dto);
  }
}
