import { ForbiddenException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { MobileTrackerStatusDto, sanitizeTrackerHealth, TrackerHealth } from '@veetracer/shared';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { AuthContext } from '../access/auth-context';
import { MailerService } from '../auth/mailer.service';
import { deviceScopeWhere } from '../access/access-rules';
import { PrismaService } from '../prisma/prisma.service';
import { positionsStreamMaxLen, RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { SystemMessagesService } from '../templates/system-messages.service';
import {
  CODE_MAX_ATTEMPTS,
  CODE_MAX_PER_DAY,
  CODE_RESEND_MS,
  CODE_TTL_MS,
  codeRecipients,
  DEFAULT_TRACKER_CONFIG,
  formatMobile,
  maskEmail,
  MAX_POINTS_PER_CALL,
  MOBILE_MODEL_PROTOCOL,
  normalizeMobile,
  parsePoint,
  toNormalized,
  TrackerConfig,
} from './mobile-tracker.logic';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
/** Sessions are re-checked against the database at most this often (revocation takes effect within it). */
const SESSION_CACHE_MS = 60_000;
const LAST_USED_WRITE_MS = 5 * 60_000;
const DAY_MS = 24 * 3600_000;
/** A phone's health report is written when it changes, else at most this often (it comes with every upload). */
const HEALTH_WRITE_MS = 10 * 60_000;

interface CachedSession {
  sessionId: string;
  deviceId: string;
  uniqueId: string;
  checkedAt: number;
  lastUsedWrite: number;
}

const trackerError = (status: number, code: string, message: string) => new HttpException({ statusCode: status, code, message }, status);
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => HTML_ESCAPES[c]);

/** Phones running the VeeTrax Tracker app: OTP activation, one active phone per number, position upload. */
@Injectable()
export class MobileTrackerService {
  private readonly logger = new Logger(MobileTrackerService.name);
  private readonly sessions = new Map<string, CachedSession>();
  private readonly healthWritten = new Map<string, { key: string; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly messages: SystemMessagesService,
    private readonly mailer: MailerService,
  ) {}

  config(): TrackerConfig {
    return DEFAULT_TRACKER_CONFIG;
  }

  private async deviceByMobile(mobile: string) {
    const uniqueId = normalizeMobile(mobile);
    if (!uniqueId) throw trackerError(400, 'BAD_NUMBER', 'Enter a valid mobile number');
    const device = await this.prisma.device.findFirst({
      where: { uniqueId, model: { protocol: MOBILE_MODEL_PROTOCOL } },
      select: {
        id: true,
        uniqueId: true,
        isActive: true,
        companyId: true,
        activationEmail: true,
        company: { select: { name: true } },
        assignments: { where: { toTime: null }, select: { object: { select: { id: true, name: true, branchId: true } } } },
      },
    });
    if (!device || !device.companyId) throw trackerError(404, 'NOT_REGISTERED', 'This number is not registered for tracking. Ask your administrator to add it in VeeTrax → Devices.');
    if (!device.isActive) throw trackerError(403, 'INACTIVE', 'Tracking for this number is switched off by your administrator.');
    return device;
  }

  async requestCode(mobile: string): Promise<{ ok: true; mobile: string; smsSent: boolean; emailSent: boolean; sentTo: string[]; expiresInSec: number }> {
    const device = await this.deviceByMobile(mobile);
    const recent = await this.prisma.mobileTrackerCode.findMany({
      where: { deviceId: device.id, createdAt: { gt: new Date(Date.now() - DAY_MS) } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (recent[0] && Date.now() - recent[0].createdAt.getTime() < CODE_RESEND_MS) throw trackerError(429, 'TOO_SOON', 'Please wait 30 seconds before asking for a new code.');
    if (recent.length >= CODE_MAX_PER_DAY) throw trackerError(429, 'TOO_MANY', 'Too many codes for this number today. Try again tomorrow or ask your administrator.');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const row = await this.prisma.mobileTrackerCode.create({ data: { deviceId: device.id, code, expiresAt: new Date(Date.now() + CODE_TTL_MS) } });
    const [smsSent, emailed] = await Promise.all([this.sendCode(device.companyId!, device.uniqueId, code), this.emailCode(device, code)]);
    if (smsSent || emailed.length) await this.prisma.mobileTrackerCode.update({ where: { id: row.id }, data: { smsSent, emailCount: emailed.length } });
    return { ok: true, mobile: device.uniqueId, smsSent, emailSent: emailed.length > 0, sentTo: emailed.map(maskEmail), expiresInSec: CODE_TTL_MS / 1000 };
  }

  /** E-mails the code to the device admins and the device's activation e-mail (see codeRecipients). Returns who got it. */
  private async emailCode(device: Awaited<ReturnType<MobileTrackerService['deviceByMobile']>>, code: string): Promise<string[]> {
    const object = device.assignments[0]?.object ?? null;
    const admins = await this.prisma.user.findMany({
      where: {
        companyId: device.companyId!,
        isActive: true,
        isSuperAdmin: false,
        email: { not: null },
        roles: { some: { role: { permissions: { some: { menu: 'devices', actions: { has: 'edit' } } } } } },
      },
      select: { email: true, roles: { select: { role: { select: { dataScope: true } } } }, branches: { select: { branchId: true } }, objects: { select: { objectId: true } } },
    });
    const to = codeRecipients(
      admins.map((a) => ({ email: a.email, scopes: a.roles.map((r) => r.role.dataScope), branchIds: a.branches.map((b) => b.branchId), objectIds: a.objects.map((o) => o.objectId) })),
      object,
      device.activationEmail,
    );
    const minutes = CODE_TTL_MS / 60_000;
    const phone = formatMobile(device.uniqueId);
    const who = object ? `${object.name} (${phone})` : phone;
    const subject = `${code} is the VeeTrax Tracker activation code for ${phone}`;
    const text =
      `Activation code for the VeeTrax Tracker app on ${who}: ${code}\nIt expires in ${minutes} minutes and works once.\n\n` +
      'Enter it in the app on that phone. If nobody is activating this phone right now, ignore this email; the code expires on its own.';
    const html =
      `<p>Activation code for the VeeTrax Tracker app on <b>${escapeHtml(who)}</b>:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p>` +
      `<p>It expires in ${minutes} minutes and works once. Enter it in the app on that phone.</p>` +
      '<p style="color:#666">If nobody is activating this phone right now, ignore this email; the code expires on its own.</p>';
    const sent: string[] = [];
    for (const addr of to) {
      let error: string | null = null;
      try {
        await this.mailer.send({ to: addr, subject, text, html });
        sent.push(addr);
      } catch (e) {
        error = (e as Error).message;
        this.logger.warn(`Tracker code email to ${addr} failed: ${error}`);
      }
      await this.messages.log({
        companyId: device.companyId!,
        channel: 'EMAIL',
        recipient: addr,
        templateId: null,
        subject,
        body: text,
        status: error ? 'FAILED' : 'SENT',
        error,
        provider: this.mailer.provider ?? 'file',
        secrets: [code],
      });
    }
    return sent;
  }

  /** SYSTEM_OTP SMS (the registered DLT template); false when no SMS provider is set up or sending failed. */
  private async sendCode(companyId: string, uniqueId: string, code: string): Promise<boolean> {
    if (this.messages.sms.name === 'console') return false;
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { name: true } });
    const vars = { code, expires_min: String(CODE_TTL_MS / 60_000), company: company?.name ?? 'VeeTrax' };
    const rendered = await this.messages.render(companyId, 'SYSTEM_OTP', 'SMS', vars);
    const text = rendered?.text ?? `${code} is your VeeTrax Tracker activation code. It expires in ${vars.expires_min} minutes.`;
    const to = `+${uniqueId}`;
    let error: string | null = null;
    try {
      await this.messages.sms.send({ to, text, dltTemplateId: rendered?.dltTemplateId, senderId: rendered?.senderId, variables: rendered?.dltValues });
    } catch (e) {
      error = (e as Error).message;
      this.logger.warn(`Tracker code SMS to ${to} failed: ${error}`);
    }
    await this.messages.log({ companyId, channel: 'SMS', recipient: to, templateId: rendered?.templateId ?? null, subject: null, body: text, status: error ? 'FAILED' : 'SENT', error, provider: this.messages.sms.name, secrets: [code] });
    return !error;
  }

  async verify(body: { mobile: string; code: string; deviceName?: string; appVersion?: string; platform?: string }) {
    const device = await this.deviceByMobile(body.mobile);
    const row = await this.prisma.mobileTrackerCode.findFirst({ where: { deviceId: device.id, consumedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    if (!row) throw trackerError(401, 'CODE_EXPIRED', 'The code has expired or was not requested. Ask for a new code.');
    if (row.attempts >= CODE_MAX_ATTEMPTS) throw trackerError(401, 'TOO_MANY', 'Too many wrong attempts. Ask for a new code.');
    if (row.code !== (body.code ?? '').trim()) {
      await this.prisma.mobileTrackerCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
      throw trackerError(401, 'WRONG_CODE', 'Wrong code.');
    }
    const { count } = await this.prisma.mobileTrackerCode.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (!count) throw trackerError(401, 'CODE_EXPIRED', 'The code was already used. Ask for a new code.');

    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    // One phone per number: activating here stops every earlier phone.
    await this.prisma.$transaction([
      this.prisma.mobileTrackerSession.updateMany({ where: { deviceId: device.id, revokedAt: null }, data: { revokedAt: now } }),
      this.prisma.mobileTrackerSession.create({
        data: { deviceId: device.id, tokenHash: hashToken(token), deviceName: body.deviceName?.slice(0, 80) ?? null, appVersion: body.appVersion?.slice(0, 20) ?? null, platform: body.platform?.slice(0, 20) ?? null, lastUsedAt: now },
      }),
    ]);
    for (const [k, s] of this.sessions) if (s.deviceId === device.id) this.sessions.delete(k);
    return { token, ...this.describe(device), config: this.config() };
  }

  private describe(device: { uniqueId: string; company: { name: string } | null; assignments: { object: { name: string } }[] }) {
    return { uniqueId: device.uniqueId, mobile: formatMobile(device.uniqueId), objectName: device.assignments[0]?.object.name ?? null, companyName: device.company?.name ?? null };
  }

  /** Resolves the Bearer token: 401 REVOKED / INVALID, 403 INACTIVE. */
  private async session(authorization: string | undefined): Promise<CachedSession> {
    const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
    if (!token) throw trackerError(401, 'INVALID', 'Not activated');
    const key = hashToken(token);
    const cached = this.sessions.get(key);
    if (cached && Date.now() - cached.checkedAt < SESSION_CACHE_MS) return cached;
    const row = await this.prisma.mobileTrackerSession.findUnique({ where: { tokenHash: key }, select: { id: true, revokedAt: true, deviceId: true, device: { select: { uniqueId: true, isActive: true, companyId: true } } } });
    if (!row) throw trackerError(401, 'INVALID', 'Please activate again');
    if (row.revokedAt) {
      this.sessions.delete(key);
      throw trackerError(401, 'REVOKED', 'Tracking moved to another phone with the same number');
    }
    if (!row.device.isActive || !row.device.companyId) throw trackerError(403, 'INACTIVE', 'Tracking switched off by your administrator');
    const next: CachedSession = { sessionId: row.id, deviceId: row.deviceId, uniqueId: row.device.uniqueId, checkedAt: Date.now(), lastUsedWrite: cached?.lastUsedWrite ?? 0 };
    this.sessions.set(key, next);
    return next;
  }

  async me(authorization: string | undefined) {
    const s = await this.session(authorization);
    const device = await this.prisma.device.findUniqueOrThrow({
      where: { id: s.deviceId },
      select: { uniqueId: true, company: { select: { name: true } }, assignments: { where: { toTime: null }, select: { object: { select: { name: true } } } } },
    });
    return { ...this.describe(device), config: this.config() };
  }

  /** Validates the points and adds them to the positions stream (the gateway's path into the processor). */
  async upload(authorization: string | undefined, points: unknown[], health?: unknown): Promise<{ ok: true; accepted: number; config: TrackerConfig }> {
    const s = await this.session(authorization);
    const now = Date.now();
    this.saveHealth(s.deviceId, sanitizeTrackerHealth(health), now);
    const config = this.config();
    const parsed = points
      .slice(0, MAX_POINTS_PER_CALL)
      .map((p) => parsePoint(p, now))
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .sort((a, b) => a.t - b.t);
    if (parsed.length) {
      const pipeline = this.redis.client.pipeline();
      const maxLen = positionsStreamMaxLen();
      for (const p of parsed) pipeline.xadd(RedisKeys.positionsStream, 'MAXLEN', '~', maxLen, '*', 'data', JSON.stringify(toNormalized(p, s.uniqueId, now, config)), 'remote', 'tracker-app');
      await pipeline.exec();
    }
    if (now - s.lastUsedWrite > LAST_USED_WRITE_MS) {
      s.lastUsedWrite = now;
      await this.prisma.mobileTrackerSession.update({ where: { id: s.sessionId }, data: { lastUsedAt: new Date(now) } }).catch(() => undefined);
    }
    return { ok: true, accepted: parsed.length, config };
  }

  /** Keeps the latest health report on the device: on change (ignoring counters), else every HEALTH_WRITE_MS. */
  private saveHealth(deviceId: string, health: TrackerHealth | null, now: number): void {
    if (!health) return;
    const { failures: _f, mode: _m, ...stable } = health;
    const key = JSON.stringify(stable);
    const last = this.healthWritten.get(deviceId);
    if (last && last.key === key && now - last.at < HEALTH_WRITE_MS) return;
    this.healthWritten.set(deviceId, { key, at: now });
    this.prisma.device
      .update({ where: { id: deviceId }, data: { trackerHealth: health as object, trackerHealthAt: new Date(now) } })
      .catch((e: Error) => this.logger.warn(`Tracker health for ${deviceId} not saved: ${e.message}`));
  }

  // ───────────── admin (Devices page) ─────────────

  private async ownDevice(ctx: AuthContext, deviceId: string) {
    const d = await this.prisma.device.findFirst({
      where: ctx.isSuperAdmin ? { id: deviceId } : { AND: [deviceScopeWhere(ctx), { id: deviceId }] },
      select: { id: true, uniqueId: true, activationEmail: true, trackerHealth: true, trackerHealthAt: true, model: { select: { protocol: true } } },
    });
    if (!d) throw new NotFoundException('Device not found');
    if (d.model.protocol !== MOBILE_MODEL_PROTOCOL) throw new ForbiddenException('Not a mobile tracker');
    return d;
  }

  /** Active phone, pending activation code (to read out when SMS isn't set up) and earlier phones. */
  async adminStatus(ctx: AuthContext, deviceId: string): Promise<MobileTrackerStatusDto> {
    const d = await this.ownDevice(ctx, deviceId);
    const [sessions, code] = await Promise.all([
      this.prisma.mobileTrackerSession.findMany({ where: { deviceId: d.id }, orderBy: { createdAt: 'desc' }, take: 5 }),
      this.prisma.mobileTrackerCode.findFirst({ where: { deviceId: d.id, consumedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } }),
    ]);
    return {
      mobile: formatMobile(d.uniqueId),
      pendingCode: code ? { code: code.code, expiresAt: code.expiresAt.toISOString(), smsSent: code.smsSent, emailCount: code.emailCount } : null,
      activationEmail: d.activationEmail,
      health: sanitizeTrackerHealth(d.trackerHealth),
      healthAt: d.trackerHealthAt?.toISOString() ?? null,
      sessions: sessions.map((x) => ({
        id: x.id,
        deviceName: x.deviceName,
        appVersion: x.appVersion,
        platform: x.platform,
        createdAt: x.createdAt.toISOString(),
        lastUsedAt: x.lastUsedAt?.toISOString() ?? null,
        active: x.revokedAt === null,
      })),
    };
  }

  /** Sets (or clears) the extra address that receives the activation code. */
  async adminSetActivationEmail(ctx: AuthContext, deviceId: string, email: string | null) {
    const d = await this.ownDevice(ctx, deviceId);
    await this.prisma.device.update({ where: { id: d.id }, data: { activationEmail: email } });
    return this.adminStatus(ctx, deviceId);
  }

  /** Stops the current phone (it must activate again). */
  async adminRevoke(ctx: AuthContext, deviceId: string) {
    const d = await this.ownDevice(ctx, deviceId);
    await this.prisma.mobileTrackerSession.updateMany({ where: { deviceId: d.id, revokedAt: null }, data: { revokedAt: new Date() } });
    for (const [k, s] of this.sessions) if (s.deviceId === d.id) this.sessions.delete(k);
    return this.adminStatus(ctx, deviceId);
  }
}

