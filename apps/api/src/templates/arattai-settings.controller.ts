import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Post, Put, Query, Res } from '@nestjs/common';
import type { MessagingChannelsDto, MessagingSettingsDto } from '@veetracer/shared';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { randomBytes, randomInt } from 'node:crypto';
import { AuthContext } from '../access/auth-context';
import { Auth, Public, RequirePermission } from '../access/decorators';
import { AuditService } from '../audit/audit.service';
import { APP_ENV } from '../config/config.module';
import { AppEnv, deliveryChannels } from '../config/env';
import { arattaiConfig, arattaiReady } from '../notifier/arattai';
import { PrismaService } from '../prisma/prisma.service';
import { SystemMessagesService } from './system-messages.service';

class SettingsBody {
  @IsBoolean() smsEnabled!: boolean;
  @IsBoolean() emailEnabled!: boolean;
  @IsBoolean() whatsappEnabled!: boolean;
  @IsBoolean() arattaiEnabled!: boolean;
  @IsString() @MaxLength(40) arattaiCompanyId!: string;
  @IsString() @MaxLength(40) arattaiBusinessNumberId!: string;
  @IsString() @MaxLength(40) arattaiOtpTemplateId!: string;
  @IsString() @MaxLength(40) arattaiAlertTemplateId!: string;
  @IsString() @MaxLength(10) arattaiLanguage!: string;
  @IsString() @MaxLength(200) arattaiClientId!: string;
  @IsOptional() @IsString() @MaxLength(300) arattaiClientSecret?: string;
}

class TestBody {
  @Matches(/^\+?[\d\s-]{10,16}$/, { message: 'Enter a mobile number' }) mobile!: string;
  @IsOptional() @IsString() kind?: 'otp' | 'alert';
}

/** What Arattai (Zoho accounts) adds to the redirect: code, state, and its data-centre details. */
class CallbackQuery {
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() error?: string;
  @IsOptional() @IsString() location?: string;
  /** The accounts server that issued the code (the token must be fetched from the same one). */
  @IsOptional() @IsString() 'accounts-server'?: string;
}

/**
 * Platform Settings → Messaging (Super Admin): switch SMS / e-mail / WhatsApp / Arattai on or off for the platform,
 * the Arattai ids and templates, its API client, "Connect Arattai" (one-time approval that yields the refresh token)
 * and test messages. GET /messaging/channels tells every signed-in user which alert channels they may choose.
 */
@Controller()
export class ArattaiSettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messages: SystemMessagesService,
    private readonly audit: AuditService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  private get redirectUri(): string {
    return `${this.env.webUrl.replace(/\/+$/, '')}/api/platform/messaging/arattai/callback`;
  }

  private async row() {
    return (await this.prisma.messagingSettings.findUnique({ where: { id: 'default' } })) ?? (await this.prisma.messagingSettings.create({ data: { id: 'default' } }));
  }

  private async dto(): Promise<MessagingSettingsDto> {
    const s = await this.row();
    return {
      smsEnabled: s.smsEnabled,
      emailEnabled: s.emailEnabled,
      whatsappEnabled: s.whatsappEnabled,
      arattaiEnabled: s.arattaiEnabled,
      arattaiCompanyId: s.arattaiCompanyId,
      arattaiBusinessNumberId: s.arattaiBusinessNumberId,
      arattaiOtpTemplateId: s.arattaiOtpTemplateId,
      arattaiAlertTemplateId: s.arattaiAlertTemplateId,
      arattaiLanguage: s.arattaiLanguage,
      arattaiClientId: s.arattaiClientId,
      arattaiClientSecretSet: !!s.arattaiClientSecret,
      arattaiConnected: !!s.arattaiRefreshToken,
      arattaiConnectedAt: s.arattaiConnectedAt?.toISOString() ?? null,
      arattaiLastSentAt: s.arattaiLastSentAt?.toISOString() ?? null,
      arattaiLastError: s.arattaiLastError,
      arattaiRedirectUri: this.redirectUri,
    };
  }

  /** Alert channels customers may choose: switched on by the Super Admin and actually able to send. */
  @Get('messaging/channels')
  async channels(): Promise<MessagingChannelsDto> {
    const s = await this.row();
    const can = deliveryChannels();
    return { email: s.emailEnabled && can.email, sms: s.smsEnabled && can.sms, arattai: arattaiReady(arattaiConfig(s)) && !!s.arattaiAlertTemplateId };
  }

  @Get('platform/messaging') @RequirePermission('sa_platform_settings', 'view')
  get(): Promise<MessagingSettingsDto> {
    return this.dto();
  }

  @Put('platform/messaging') @RequirePermission('sa_platform_settings', 'edit')
  async save(@Auth() ctx: AuthContext, @Body() b: SettingsBody): Promise<MessagingSettingsDto> {
    const before = await this.row();
    const clientChanged = b.arattaiClientId.trim() !== before.arattaiClientId || !!b.arattaiClientSecret?.trim();
    const { arattaiClientSecret, ...rest } = b;
    await this.prisma.messagingSettings.update({
      where: { id: 'default' },
      data: {
        ...rest,
        arattaiCompanyId: b.arattaiCompanyId.trim(),
        arattaiBusinessNumberId: b.arattaiBusinessNumberId.trim(),
        arattaiOtpTemplateId: b.arattaiOtpTemplateId.trim(),
        arattaiAlertTemplateId: b.arattaiAlertTemplateId.trim(),
        arattaiLanguage: b.arattaiLanguage.trim() || 'en',
        arattaiClientId: b.arattaiClientId.trim(),
        ...(arattaiClientSecret?.trim() ? { arattaiClientSecret: arattaiClientSecret.trim() } : {}),
        // A different API client needs a new approval.
        ...(clientChanged && before.arattaiRefreshToken ? { arattaiRefreshToken: '', arattaiConnectedAt: null } : {}),
      },
    });
    this.messages.arattai.reset();
    const view = (x: Record<string, unknown>) => Object.fromEntries(Object.entries(x).filter(([k]) => !/Secret|RefreshToken|OauthState/.test(k)));
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'MessagingSettings', entityId: 'default', before: view(before), after: { ...view(rest), clientSecretChanged: !!arattaiClientSecret?.trim() } });
    return this.dto();
  }

  /** The approval page to open (state kept to check the redirect back). */
  @Post('platform/messaging/arattai/connect') @HttpCode(200) @RequirePermission('sa_platform_settings', 'edit')
  async connect(): Promise<{ url: string }> {
    const s = await this.row();
    if (!s.arattaiClientId || !s.arattaiClientSecret) throw new BadRequestException('Save the client ID and client secret first');
    const state = randomBytes(16).toString('hex');
    await this.prisma.messagingSettings.update({ where: { id: 'default' }, data: { arattaiOauthState: state } });
    return { url: this.messages.arattai.connectUrl({ clientId: s.arattaiClientId }, this.redirectUri, state) };
  }

  /** Arattai sends the approver back here; the code becomes the stored refresh token, then back to Platform Settings. */
  @Public() @Get('platform/messaging/arattai/callback')
  async callback(@Query() q: CallbackQuery, @Res() res: Response): Promise<void> {
    const back = (result: string) => res.redirect(`${this.env.webUrl.replace(/\/+$/, '')}/platform/settings?tab=messaging&arattai=${encodeURIComponent(result)}`);
    const s = await this.row();
    if (q.error) return back(`error:${q.error}`.slice(0, 80));
    if (!q.code || !q.state || !s.arattaiOauthState || q.state !== s.arattaiOauthState) return back('error:expired, press Connect again');
    try {
      const refreshToken = await this.messages.arattai.exchange({ clientId: s.arattaiClientId, clientSecret: s.arattaiClientSecret }, q.code, this.redirectUri, q['accounts-server']);
      await this.prisma.messagingSettings.update({ where: { id: 'default' }, data: { arattaiRefreshToken: refreshToken, arattaiConnectedAt: new Date(), arattaiOauthState: null, arattaiLastError: null } });
      this.messages.arattai.reset();
      // Fill in the Company ID and Business number ID from Arattai when they are still empty.
      if (!s.arattaiCompanyId || !s.arattaiBusinessNumberId) {
        const found = await this.messages.arattai.discover({ clientId: s.arattaiClientId, clientSecret: s.arattaiClientSecret, refreshToken }, null);
        const data: Record<string, string> = {};
        if (!s.arattaiCompanyId && found.companyId) data.arattaiCompanyId = found.companyId;
        if (!s.arattaiBusinessNumberId && found.businessNumberId) data.arattaiBusinessNumberId = found.businessNumberId;
        if (!found.businessNumberId && found.numbers.length > 1) data.arattaiLastError = `Several business numbers (${found.numbers.join(', ')}): type the Business number ID of the one to use`;
        if (Object.keys(data).length) await this.prisma.messagingSettings.update({ where: { id: 'default' }, data });
      }
      back('connected');
    } catch (e) {
      await this.prisma.messagingSettings.update({ where: { id: 'default' }, data: { arattaiOauthState: null, arattaiLastError: `${new Date().toISOString()} ${(e as Error).message}` } });
      back(`error:${(e as Error).message}`.slice(0, 120));
    }
  }

  /** A test code (or test alert) to a number, even while Arattai is switched off, to check the set-up. */
  @Post('platform/messaging/arattai/test') @HttpCode(200) @RequirePermission('sa_platform_settings', 'edit')
  async test(@Body() b: TestBody): Promise<{ sent: boolean; error: string | null }> {
    if (b.kind === 'alert') {
      try {
        await this.messages.arattai.sendAlert(b.mobile, { alert: 'Test alert', vehicle: 'VeeTrax test', time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), details: 'This is a test message from VeeTrax Platform Settings.' });
        return { sent: true, error: null };
      } catch (e) {
        return { sent: false, error: (e as Error).message };
      }
    }
    return this.messages.arattai.sendOtp(b.mobile, String(randomInt(0, 1_000_000)).padStart(6, '0'), 10, { evenIfOff: true });
  }
}
