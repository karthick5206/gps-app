import { Body, Controller, Get, Headers, HttpCode, Logger, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AuthContext } from '../access/auth-context';
import { Auth, Public, RequirePermission } from '../access/decorators';
import { TrackerActivationEmailBody, TrackerDiagnosticsBody, TrackerPositionsBody, TrackerRequestCodeBody, TrackerVerifyBody } from './mobile-tracker.dto';
import { MobileTrackerService } from './mobile-tracker.service';

/** VeeTrax Tracker app (docs/mobile-tracker/API.md): activation by OTP and position upload with the phone's token. */
@Controller('tracker/v1')
@UseGuards(ThrottlerGuard)
export class MobileTrackerController {
  private readonly logger = new Logger('MobileTracker');

  constructor(private readonly service: MobileTrackerService) {}

  @Public() @Post('activate/request') @HttpCode(200) @Throttle({ default: { ttl: 60_000, limit: 5 } })
  request(@Body() body: TrackerRequestCodeBody) {
    return this.service.requestCode(body.mobile);
  }

  @Public() @Post('activate/verify') @HttpCode(200) @Throttle({ default: { ttl: 60_000, limit: 10 } })
  verify(@Body() body: TrackerVerifyBody) {
    return this.service.verify(body);
  }

  @Public() @SkipThrottle() @Get('me')
  me(@Headers('authorization') authorization?: string) {
    return this.service.me(authorization);
  }

  @Public() @SkipThrottle() @Post('positions') @HttpCode(200)
  positions(@Headers('authorization') authorization: string | undefined, @Body() body: TrackerPositionsBody) {
    return this.service.upload(authorization, body.positions);
  }

  /** Crash reports from the app (stack traces only, no location or personal data). Logged for support. */
  @Public() @Post('diagnostics') @HttpCode(200) @Throttle({ default: { ttl: 60_000, limit: 3 } })
  diagnostics(@Body() body: TrackerDiagnosticsBody) {
    const head = `tracker crash: app ${body.appVersion ?? '?'} on ${body.device ?? body.platform ?? '?'}`;
    if (body.nativeCrash) this.logger.warn(`${head} [native]\n${body.nativeCrash}`);
    if (body.jsCrash) this.logger.warn(`${head} [js]\n${body.jsCrash}`);
    return { ok: true as const };
  }
}

/** Devices page: which phone tracks for a mobile-tracker device, its pending code, and stopping it. */
@Controller('devices')
export class MobileTrackerAdminController {
  constructor(private readonly service: MobileTrackerService) {}

  @Get(':id/mobile-tracker') @RequirePermission('devices', 'view')
  status(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.adminStatus(ctx, id);
  }

  @Patch(':id/mobile-tracker') @RequirePermission('devices', 'edit')
  setEmail(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: TrackerActivationEmailBody) {
    return this.service.adminSetActivationEmail(ctx, id, body.activationEmail?.trim() || null);
  }

  @Post(':id/mobile-tracker/revoke') @HttpCode(200) @RequirePermission('devices', 'edit')
  revoke(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.adminRevoke(ctx, id);
  }
}
