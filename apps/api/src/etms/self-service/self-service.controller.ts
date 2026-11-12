import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Res, UseGuards } from '@nestjs/common';
import type { MeBookingDto, MeCommuteDto, MePlaceDto, MeTransportPolicyDto, MeTripConfirmResult, MeTripReportResult } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { TransportFeatureGuard } from '../transport-feature.guard';
import { MeCreateBookingDto, MePlaceDto as MePlaceBody, MePlaceUpdateDto, MeTripConfirmDto, MeTripReportDto } from './self-service.dto';
import { SelfServiceService } from './self-service.service';

type HeaderSink = { setHeader?: (name: string, value: string) => unknown } | undefined;

/**
 * Passenger self-service (E5 WP 5.3; doc 05 §2.8): /api/me/transport/{policy, bookings (POST), schedule, places,
 * trips/:id/confirm, trips/:id/reports}. Company add-on `etms` (TransportFeatureGuard: 404), menu `etms_self` (the
 * passenger template holds `view` only, like the E5 self-cancel), the caller's own active profile (403
 * NOT_A_PASSENGER), and — except GET policy — the company setting `etms.selfBooking` (default off: 404
 * SELF_BOOKING_DISABLED). Other passengers' trips / places are 404.
 */
@Controller('me/transport')
@UseGuards(TransportFeatureGuard)
export class MySelfServiceController {
  constructor(private readonly self: SelfServiceService) {}

  @Get('policy') @RequirePermission('etms_self', 'view')
  policy(@Auth() ctx: AuthContext): Promise<MeTransportPolicyDto> {
    return this.self.policy(ctx);
  }

  /** Idempotency-Key header required (05 §1); a replay answers the same booking with `Idempotent-Replay: true`. */
  @Post('bookings') @RequirePermission('etms_self', 'view')
  async book(@Auth() ctx: AuthContext, @Body() dto: MeCreateBookingDto, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res?: HeaderSink): Promise<MeBookingDto> {
    const r = await this.self.createBooking(ctx, dto, key);
    if (r.replay) res?.setHeader?.('Idempotent-Replay', 'true');
    return r.value;
  }

  @Get('schedule') @RequirePermission('etms_self', 'view')
  commute(@Auth() ctx: AuthContext): Promise<MeCommuteDto> {
    return this.self.commute(ctx);
  }

  @Get('places') @RequirePermission('etms_self', 'view')
  places(@Auth() ctx: AuthContext): Promise<MePlaceDto[]> {
    return this.self.places(ctx);
  }

  @Post('places') @RequirePermission('etms_self', 'view')
  addPlace(@Auth() ctx: AuthContext, @Body() dto: MePlaceBody): Promise<MePlaceDto> {
    return this.self.addPlace(ctx, dto);
  }

  @Patch('places/:id') @RequirePermission('etms_self', 'view')
  updatePlace(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MePlaceUpdateDto): Promise<MePlaceDto> {
    return this.self.updatePlace(ctx, id, dto);
  }

  @Delete('places/:id') @RequirePermission('etms_self', 'view')
  deletePlace(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<{ deleted: true }> {
    return this.self.deletePlace(ctx, id);
  }

  @Post('trips/:id/confirm') @HttpCode(200) @RequirePermission('etms_self', 'view')
  confirm(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MeTripConfirmDto): Promise<MeTripConfirmResult> {
    return this.self.confirm(ctx, id, dto);
  }

  @Post('trips/:id/reports') @HttpCode(200) @RequirePermission('etms_self', 'view')
  report(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MeTripReportDto): Promise<MeTripReportResult> {
    return this.self.report(ctx, id, dto);
  }
}
