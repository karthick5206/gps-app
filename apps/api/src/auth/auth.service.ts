import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { User } from '@prisma/client';
import { LoginResponse } from '@veetracer/shared';
import { randomInt } from 'node:crypto';
import { AuthContextService } from '../access/auth-context.service';
import { AuditService } from '../audit/audit.service';
import { hashPassword, hmac, randomToken, sha256, verifyPassword } from '../common/secrets';
import { APP_ENV } from '../config/config.module';
import { AppEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { SystemMessagesService } from '../templates/system-messages.service';
import { MailerService } from './mailer.service';
import { MeService } from './me.service';
import { ClientInfo, TokenService } from './token.service';

const MAX_LOGIN_FAILURES = 5;
const LOCKOUT_SEC = 15 * 60;
const OTP_TTL_MS = 5 * 60_000;
const OTP_RESEND_MS = 30_000;
const OTP_MAX_ATTEMPTS = 5;
const RESET_TTL_MS = 30 * 60_000;

type UserWithCompany = User & { company: { status: string } };

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly tokens: TokenService,
    private readonly contexts: AuthContextService,
    private readonly me: MeService,
    private readonly audit: AuditService,
    private readonly mailer: MailerService,
    private readonly messages: SystemMessagesService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async loginWithPassword(emailInput: string, password: string, client: ClientInfo): Promise<LoginResponse> {
    const email = emailInput.trim().toLowerCase();
    const failKey = RedisKeys.loginFailures(email);
    const failures = Number(await this.redis.client.get(failKey)) || 0;
    if (failures >= MAX_LOGIN_FAILURES) {
      throw new HttpException('Too many failed attempts. Try again in 15 minutes', HttpStatus.TOO_MANY_REQUESTS);
    }

    const user = await this.prisma.user.findUnique({ where: { email }, include: { company: { select: { status: true } } } });
    const ok = !!user?.passwordHash && (await verifyPassword(password, user.passwordHash));
    if (!user || !ok) {
      await this.redis.client.multi().incr(failKey).expire(failKey, LOCKOUT_SEC).exec();
      await this.audit.recordSystem(
        { companyId: user?.companyId ?? null, userId: user?.id ?? null, ip: client.ip },
        { action: 'LOGIN_FAILED', entity: 'auth', details: { method: 'password', email } },
      );
      throw new UnauthorizedException('Invalid credentials');
    }
    await this.redis.client.del(failKey);
    return this.completeLogin(user, client, 'password');
  }

  async requestOtp(mobile: string): Promise<{ ok: true; devCode?: string }> {
    const recent = await this.prisma.otpCode.findFirst({ where: { mobile }, orderBy: { createdAt: 'desc' } });
    if (recent && Date.now() - recent.createdAt.getTime() < OTP_RESEND_MS) {
      throw new HttpException('Please wait 30 seconds before requesting another code', HttpStatus.TOO_MANY_REQUESTS);
    }
    const user = await this.prisma.user.findUnique({ where: { mobile }, select: { id: true, isActive: true, companyId: true } });
    // Unknown mobiles get the same response, so the endpoint cannot be used to discover accounts.
    if (!user?.isActive) return { ok: true };

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.prisma.otpCode.create({
      data: { mobile, codeHash: this.otpHash(mobile, code), expiresAt: new Date(Date.now() + OTP_TTL_MS) },
    });
    await this.sendOtpSms(user.companyId, mobile, code).catch((e: Error) => this.logger.error(`OTP SMS failed: ${e.message}`));
    if (!this.env.otpDevEcho) return { ok: true };
    this.logger.log(`[dev] OTP for ${mobile}: ${code}`);
    return { ok: true, devCode: code };
  }

  async verifyOtp(mobile: string, code: string, client: ClientInfo): Promise<LoginResponse> {
    const otp = await this.prisma.otpCode.findFirst({
      where: { mobile, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) throw new UnauthorizedException('Code expired or not requested');
    if (otp.attempts >= OTP_MAX_ATTEMPTS) throw new UnauthorizedException('Too many attempts. Request a new code');
    if (otp.codeHash !== this.otpHash(mobile, code)) {
      await this.prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      throw new UnauthorizedException('Invalid code');
    }
    const { count } = await this.prisma.otpCode.updateMany({
      where: { id: otp.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (count !== 1) throw new UnauthorizedException('Code already used');
    const user = await this.prisma.user.findUnique({ where: { mobile }, include: { company: { select: { status: true } } } });
    if (!user) throw new UnauthorizedException('Invalid code');
    return this.completeLogin(user, client, 'otp');
  }

  async logout(refreshToken: string, ip: string | null): Promise<{ ok: true }> {
    const userId = await this.tokens.revoke(refreshToken);
    if (userId) {
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { companyId: true } });
      await this.audit.recordSystem(
        { companyId: user?.companyId ?? null, userId, ip },
        { action: 'LOGOUT', entity: 'auth', entityId: userId },
      );
    }
    return { ok: true };
  }

  async forgotPassword(emailInput: string): Promise<{ ok: true; devLink?: string }> {
    const email = emailInput.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true, name: true, isActive: true, companyId: true } });
    if (!user?.isActive) return { ok: true };

    const token = randomToken(32);
    await this.prisma.passwordReset.create({
      data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
    });
    const link = `${this.env.webUrl}/reset-password?token=${encodeURIComponent(token)}`;
    await this.sendResetEmail(user, email, link);
    return this.env.mailDevEcho ? { ok: true, devLink: link } : { ok: true };
  }

  async resetPassword(token: string, password: string, ip: string | null): Promise<{ ok: true }> {
    const reset = await this.prisma.passwordReset.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { select: { id: true, companyId: true, email: true } } },
    });
    if (!reset || reset.usedAt || reset.expiresAt < new Date()) {
      throw new UnauthorizedException('Reset link is invalid or has expired');
    }
    const { count } = await this.prisma.passwordReset.updateMany({
      where: { id: reset.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (count !== 1) throw new UnauthorizedException('Reset link is invalid or has expired');
    await this.prisma.user.update({ where: { id: reset.userId }, data: { passwordHash: await hashPassword(password) } });
    await this.tokens.revokeAll(reset.userId);
    if (reset.user.email) await this.redis.client.del(RedisKeys.loginFailures(reset.user.email));
    await this.audit.recordSystem(
      { companyId: reset.user.companyId, userId: reset.userId, ip },
      { action: 'PASSWORD_RESET', entity: 'user', entityId: reset.userId },
    );
    return { ok: true };
  }

  private async completeLogin(user: UserWithCompany, client: ClientInfo, method: string): Promise<LoginResponse> {
    if (!user.isActive) throw new ForbiddenException('Account inactive');
    if (!user.isSuperAdmin && user.company.status !== 'ACTIVE') throw new ForbiddenException('Company suspended');
    const tokens = await this.tokens.issue(user, client);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.recordSystem(
      { companyId: user.companyId, userId: user.id, ip: client.ip },
      { action: 'LOGIN', entity: 'auth', entityId: user.id, details: { method } },
    );
    const ctx = await this.contexts.forUser(user.id, undefined, client.ip);
    return { ...tokens, me: await this.me.build(ctx) };
  }

  /** SYSTEM_OTP SMS (company override → system template); failures are logged, never surfaced to the caller. */
  private async sendOtpSms(companyId: string, mobile: string, code: string): Promise<void> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { name: true } });
    const vars = { code, expires_min: String(OTP_TTL_MS / 60_000), company: company?.name ?? 'VeeTracer' };
    const rendered = await this.messages.render(companyId, 'SYSTEM_OTP', 'SMS', vars);
    const text = rendered?.text ?? `${code} is your VeeTracer login code. It expires in ${vars.expires_min} minutes.`;
    let error: string | null = null;
    try {
      await this.messages.sms.send({ to: mobile, text, dltTemplateId: rendered?.dltTemplateId, senderId: rendered?.senderId, variables: rendered?.dltValues });
    } catch (e) {
      error = (e as Error).message;
      this.logger.warn(`OTP SMS to ${mobile} failed: ${error}`);
    }
    await this.messages.log({
      companyId,
      channel: 'SMS',
      recipient: mobile,
      templateId: rendered?.templateId ?? null,
      subject: null,
      body: text,
      status: error ? 'FAILED' : 'SENT',
      error,
      provider: this.messages.sms.name,
      secrets: [code],
    });
  }

  /** SYSTEM_PASSWORD_RESET e-mail (company override → system template). */
  private async sendResetEmail(user: { id: string; name: string; companyId: string }, email: string, link: string): Promise<void> {
    const company = await this.prisma.company.findUnique({ where: { id: user.companyId }, select: { name: true } });
    const vars = { user_name: user.name, reset_link: link, expires_min: String(RESET_TTL_MS / 60_000), company: company?.name ?? 'VeeTracer' };
    const rendered = await this.messages.render(user.companyId, 'SYSTEM_PASSWORD_RESET', 'EMAIL', vars);
    const subject = rendered?.subject ?? 'Reset your VeeTracer password';
    const html =
      rendered?.body ??
      `<p>Hi ${escapeHtml(user.name)},</p><p><a href="${escapeHtml(link)}">Reset your VeeTracer password</a> (valid for 30 minutes, single use).</p>`;
    const text = rendered?.text ?? `Hi ${user.name},\n\nReset your password within 30 minutes: ${link}`;
    await this.mailer.send({ to: email, subject, html, text });
    await this.messages.log({
      companyId: user.companyId,
      channel: 'EMAIL',
      recipient: email,
      templateId: rendered?.templateId ?? null,
      subject,
      body: html,
      status: 'SENT',
      provider: 'mailer',
      secrets: [link, escapeHtml(link)],
    });
  }

  private otpHash(mobile: string, code: string): string {
    return hmac(this.env.jwtSecret, `${mobile}:${code}`);
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
