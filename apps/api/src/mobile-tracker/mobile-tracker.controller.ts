import { Body, Controller, Put, Get, Headers, HttpCode, Logger, Param, ParseUUIDPipe, Patch, Post, UseGuards, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle, Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AuthContext } from '../access/auth-context';
import { Auth, Public, RequirePermission } from '../access/decorators';
import { TrackerOutingBody, TrackerActivationEmailBody, TrackerDiagnosticsBody, TrackerLookupBody, TrackerPositionsBody, TrackerRequestCodeBody, TrackerRequiredBody, TrackerRestoreBody, TrackerVerifyBody } from './mobile-tracker.dto';
import { MobileTrackerService } from './mobile-tracker.service';

/** VeeTrax Tracker app (docs/mobile-tracker/API.md): activation by OTP and position upload with the phone's token. */
@Controller('tracker/v1')
@UseGuards(ThrottlerGuard)
export class MobileTrackerController {
  private readonly logger = new Logger('MobileTracker');

  constructor(private readonly service: MobileTrackerService) {}

  @Public() @Post('activate/request') @HttpCode(200) @Throttle({ default: { ttl: 60_000, limit: 5 } })
  request(@Body() body: TrackerRequestCodeBody) {
    return this.service.requestCode(body.mobile, body.email, body.name);
  }

  @Public() @Post('activate/lookup') @HttpCode(200) @Throttle({ default: { ttl: 60_000, limit: 10 } })
  lookup(@Body() body: TrackerLookupBody) {
    return this.service.lookup(body.mobile, body.installId);
  }

  @Public() @Post('activate/restore') @HttpCode(200) @Throttle({ default: { ttl: 60_000, limit: 5 } })
  restore(@Body() body: TrackerRestoreBody) {
    return this.service.restore(body);
  }

  @Public() @Post('activate/verify') @HttpCode(200) @Throttle({ default: { ttl: 60_000, limit: 10 } })
  verify(@Body() body: TrackerVerifyBody) {
    return this.service.verify(body);
  }

  @Public() @Post('signout') @HttpCode(200) @Throttle({ default: { ttl: 60_000, limit: 5 } })
  signOut(@Headers('authorization') authorization?: string) {
    return this.service.signOut(authorization);
  }

  @Public() @SkipThrottle() @Get('me')
  me(@Headers('authorization') authorization?: string, @Headers('x-app-version') appVersion?: string) {
    return this.service.me(authorization, appVersion);
  }

  @Public() @SkipThrottle() @Post('positions') @HttpCode(200)
  positions(@Headers('authorization') authorization: string | undefined, @Body() body: TrackerPositionsBody) {
    return this.service.upload(authorization, body.positions, body.health);
  }

  /** Attendance of the person this phone tracks: what to show, the employee's answers, the check-in selfie. */
  @Public() @Get('attendance') @Throttle({ default: { ttl: 60_000, limit: 30 } })
  attendance(@Headers('authorization') authorization?: string) {
    return this.service.attendanceStatus(authorization);
  }

  @Public() @Put('attendance/outing') @Throttle({ default: { ttl: 60_000, limit: 20 } })
  attendanceOuting(@Headers('authorization') authorization: string | undefined, @Body() body: TrackerOutingBody) {
    return this.service.attendanceAnswer(authorization, body);
  }

  @Public() @Post('attendance/selfie') @HttpCode(200) @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024, files: 1 } }))
  attendanceSelfie(@Headers('authorization') authorization: string | undefined, @UploadedFile() file?: { buffer: Buffer; mimetype?: string }) {
    return this.service.attendanceSelfie(authorization, file);
  }

  @Public() @Post('attendance/video') @HttpCode(200) @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 30 * 1024 * 1024, files: 1 } }))
  attendanceVideo(@Headers('authorization') authorization: string | undefined, @UploadedFile() file?: { buffer: Buffer; mimetype?: string }) {
    return this.service.attendanceVideo(authorization, file);
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

  @Put(':id/mobile-tracker/required') @RequirePermission('devices', 'edit')
  setRequired(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: TrackerRequiredBody) {
    return this.service.adminSetRequired(ctx, id, body.required);
  }

  @Post(':id/mobile-tracker/revoke') @HttpCode(200) @RequirePermission('devices', 'edit')
  revoke(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.adminRevoke(ctx, id);
  }
}
