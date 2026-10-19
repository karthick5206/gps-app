import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import { AuthTokens, LoginResponse, Me, SessionDto } from '@veetracer/shared';
import { Request } from 'express';
import { AuthContext } from '../access/auth-context';
import { Auth, Public } from '../access/decorators';
import { AuditService } from '../audit/audit.service';
import { AuthService } from './auth.service';
import {
  ForgotPasswordDto,
  LoginDto,
  OtpRequestDto,
  OtpVerifyDto,
  ChangePasswordDto,
  PreferencesDto,
  UpdateProfileDto,
  PushTokenDto,
  RemovePushTokenDto,
  RefreshDto,
  ResetPasswordDto,
} from './dto/auth.dto';
import { MeService } from './me.service';
import { ClientInfo, TokenService } from './token.service';

const client = (req: Request): ClientInfo => ({ ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null });

@Controller('auth')
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly me: MeService,
    private readonly audit: AuditService,
  ) {}

  @Public() @Post('login') @HttpCode(200)
  login(@Body() dto: LoginDto, @Req() req: Request): Promise<LoginResponse> {
    return this.auth.loginWithPassword(dto.email, dto.password, client(req));
  }

  @Public() @Post('otp/request') @HttpCode(200)
  requestOtp(@Body() dto: OtpRequestDto): Promise<{ ok: true; devCode?: string }> {
    return this.auth.requestOtp(dto.mobile);
  }

  @Public() @Post('otp/verify') @HttpCode(200)
  verifyOtp(@Body() dto: OtpVerifyDto, @Req() req: Request): Promise<LoginResponse> {
    return this.auth.verifyOtp(dto.mobile, dto.code, client(req));
  }

  @Public() @Post('refresh') @HttpCode(200)
  refresh(@Body() dto: RefreshDto): Promise<AuthTokens> {
    return this.tokens.rotate(dto.refreshToken);
  }

  @Public() @Post('logout') @HttpCode(200)
  logout(@Body() dto: RefreshDto, @Req() req: Request): Promise<{ ok: true }> {
    return this.auth.logout(dto.refreshToken, req.ip ?? null);
  }

  @Public() @Post('password/forgot') @HttpCode(200)
  forgot(@Body() dto: ForgotPasswordDto): Promise<{ ok: true; devLink?: string }> {
    return this.auth.forgotPassword(dto.email);
  }

  @Public() @Post('password/reset') @HttpCode(200)
  reset(@Body() dto: ResetPasswordDto, @Req() req: Request): Promise<{ ok: true }> {
    return this.auth.resetPassword(dto.token, dto.password, req.ip ?? null);
  }

  @SkipThrottle() @Get('me')
  getMe(@Auth() ctx: AuthContext): Promise<Me> {
    return this.me.build(ctx);
  }

  /** Devices / browsers where the user is signed in. */
  @SkipThrottle() @Get('sessions')
  sessions(@Auth() ctx: AuthContext): Promise<SessionDto[]> {
    return this.tokens.list(ctx.userId, ctx.sessionId);
  }

  @Delete('sessions/:id') @HttpCode(200)
  async endSession(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<{ ok: true }> {
    if (!(await this.tokens.revokeOwn(ctx.userId, id))) throw new NotFoundException('Session not found');
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'Session', entityId: id, details: { signedOut: true } });
    return { ok: true };
  }

  @Post('sessions/revoke-others') @HttpCode(200)
  async endOtherSessions(@Auth() ctx: AuthContext): Promise<{ count: number }> {
    const count = await this.tokens.revokeOthers(ctx.userId, ctx.sessionId);
    if (count) await this.audit.record(ctx, { action: 'UPDATE', entity: 'Session', entityId: null, details: { signedOutOthers: count } });
    return { count };
  }

  /** Registers this app install for push alerts (moves the token to the current user / session). */
  @SkipThrottle() @Post('push-token') @HttpCode(200)
  async registerPush(@Auth() ctx: AuthContext, @Body() dto: PushTokenDto): Promise<{ ok: true }> {
    await this.me.registerPushToken(ctx, dto);
    return { ok: true };
  }

  /** Sends a test notification to this app install. */
  @Post('push-token/test') @HttpCode(200)
  testPush(@Auth() ctx: AuthContext, @Body() dto: RemovePushTokenDto): Promise<{ sent: boolean; error: string | null }> {
    return this.me.testPush(ctx, dto.token);
  }

  /** Called by the app before signing out. Public: the access token may already be gone. */
  @Public() @Post('push-token/remove') @HttpCode(200)
  async removePush(@Body() dto: RemovePushTokenDto): Promise<{ ok: true }> {
    await this.me.removePushToken(dto.token);
    return { ok: true };
  }

  /** Edit own name / email / mobile. */
  @Patch('me') @HttpCode(200)
  async updateProfile(@Auth() ctx: AuthContext, @Body() dto: UpdateProfileDto): Promise<Me> {
    const me = await this.me.updateProfile(ctx, dto);
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'user', entityId: ctx.userId, details: { profile: Object.keys(dto) } });
    return me;
  }

  /** Change own password; other signed-in devices are signed out. */
  @Post('me/password') @HttpCode(200)
  async changePassword(@Auth() ctx: AuthContext, @Body() dto: ChangePasswordDto): Promise<{ ok: true; signedOutOthers: number }> {
    await this.me.changePassword(ctx, dto.currentPassword, dto.newPassword);
    const signedOutOthers = await this.tokens.revokeOthers(ctx.userId, ctx.sessionId);
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'user', entityId: ctx.userId, details: { passwordChanged: true, signedOutOthers } });
    return { ok: true, signedOutOthers };
  }

  @SkipThrottle() @Patch('me/preferences')
  setPreferences(@Auth() ctx: AuthContext, @Body() dto: PreferencesDto): Promise<Me> {
    return this.me.setPreferences(ctx, dto);
  }
}
