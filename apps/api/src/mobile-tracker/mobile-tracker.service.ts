import type { PhoneAttendanceDto, PhoneAttention } from '@veetracer/shared';
import { AttendanceService } from '../attendance/attendance.service';
import { ForbiddenException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException, Optional } from '@nestjs/common';
import { MobileTrackerStatusDto, sanitizeTrackerEvents, sanitizeTrackerHealth, TrackerEventKind, TrackerHealth } from '@veetracer/shared';
import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';
import { AuthContext } from '../access/auth-context';
import { OfflineAlertService } from '../alerts/offline-alerts.service';
import { AuditService } from '../audit/audit.service';
import { MailerService } from '../auth/mailer.service';
import { deviceScopeWhere } from '../access/access-rules';
import { PrismaService } from '../prisma/prisma.service';
import { positionsStreamMaxLen, RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { SystemMessagesService } from '../templates/system-messages.service';
import { TrackerSelfService } from './self-service';
import {
  CODE_MAX_ATTEMPTS,
  CODE_MAX_PER_DAY,
  CODE_RESEND_MS,
  CODE_TTL_MS,
  codeRecipients,
  DEFAULT_TRACKER_CONFIG,
  formatMobile,
  trackerOnOffChanges,
  isDifferentPhone,
  maskEmail,
  MAX_POINTS_PER_CALL,
  MOBILE_MODEL_PROTOCOL,
  normalizeMobile,
  parsePoint,
  rejectReason,
  roughSpikes,
  summarizeRejected,
  toNormalized,
  TrackerConfig,
  phoneReturn,
  phoneReturnMessage,
} from './mobile-tracker.logic';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
/** Install ids are kept as an HMAC (keyed by the server secret), never in clear. */
const hashInstallId = (id: string | undefined) => (id && id.length >= 8 ? createHmac('sha256', process.env.JWT_SECRET ?? 'veetrax').update(`tracker-install:${id}`).digest('hex') : null);
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
  required: boolean;
  /** Set when the number moved to another phone: only for delivering what this phone recorded before that. */
  revokedAt?: number;
  checkedAt: number;
  lastUsedWrite: number;
  /** App version last stored for this session (updated when the phone reports a new one). */
  appVersion?: string | null;
}

const trackerError = (status: number, code: string, message: string) => new HttpException({ statusCode: status, code, message }, status);
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => HTML_ESCAPES[c]);

/** Phones running the VeeTrax Tracker app: OTP activation, one active phone per number, position upload. */
const NOTICE_CACHE_MS = 60_000;

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
    private readonly self: TrackerSelfService,
    private readonly audit: AuditService,
    private readonly alerts: OfflineAlertService,
    @Optional() private readonly attendance?: AttendanceService,
  ) {}

  /** Latest attendance notice per phone: uploads come every few seconds, the answer changes far less often. */
  private readonly notices = new Map<string, { at: number; value: PhoneAttention | null }>();

  config(): TrackerConfig {
    return DEFAULT_TRACKER_CONFIG;
  }

  /**
   * App-store review: TRACKER_REVIEW_MOBILE always gets the fixed TRACKER_REVIEW_CODE (reviewers can't receive our
   * SMS). Only that one number, only when both are configured.
   */
  private reviewCode(uniqueId: string): string | null {
    const mobile = normalizeMobile(process.env.TRACKER_REVIEW_MOBILE ?? '');
    const code = process.env.TRACKER_REVIEW_CODE ?? '';
    return mobile && mobile === uniqueId && /^[0-9]{6}$/.test(code) ? code : null;
  }

  private normalize(mobile: string): string {
    const uniqueId = normalizeMobile(mobile);
    if (!uniqueId) throw trackerError(400, 'BAD_NUMBER', 'Enter a valid mobile number');
    return uniqueId;
  }

  private async deviceByMobile(mobile: string) {
    const device = await this.findDevice(this.normalize(mobile));
    if (!device || !device.companyId) throw trackerError(404, 'NOT_REGISTERED', 'This number is not registered for tracking. Ask your administrator to add it in VeeTrax → Devices.');
    if (!device.isActive) throw trackerError(403, 'INACTIVE', 'Tracking for this number is switched off by your administrator.');
    return device;
  }

  private findDevice(uniqueId: string) {
    return this.prisma.device.findFirst({
      where: { uniqueId, model: { protocol: MOBILE_MODEL_PROTOCOL } },
      select: {
        id: true,
        uniqueId: true,
        isActive: true,
        companyId: true,
        activationEmail: true,
        company: { select: { name: true, accountType: true } },
        licenceSeat: { select: { source: true, expiresAt: true } },
        assignments: { where: { toTime: null }, select: { object: { select: { id: true, name: true, branchId: true, plateNumber: true, speedLimitKph: true } } } },
      },
    });
  }

  async requestCode(
    mobile: string,
    email?: string,
    name?: string,
  ): Promise<{ ok: true; mobile: string; smsSent: boolean; emailSent: boolean; sentTo: string[]; expiresInSec: number; selfService: boolean }> {
    const uniqueId = this.normalize(mobile);
    const existing = await this.findDevice(uniqueId);
    if (!existing || !existing.companyId) return this.requestSelfService(uniqueId, email, name);
    const device = await this.deviceByMobile(mobile);
    // Registered phone: the e-mail / name typed in the app are applied once the code is verified (see applyContact).
    const contact = email?.trim().toLowerCase() || null;
    const recent = await this.prisma.mobileTrackerCode.findMany({
      where: { deviceId: device.id, createdAt: { gt: new Date(Date.now() - DAY_MS) } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (recent[0] && Date.now() - recent[0].createdAt.getTime() < CODE_RESEND_MS) throw trackerError(429, 'TOO_SOON', 'Please wait 30 seconds before asking for a new code.');
    if (recent.length >= CODE_MAX_PER_DAY) throw trackerError(429, 'TOO_MANY', 'Too many codes for this number today. Try again tomorrow or ask your administrator.');
    const review = this.reviewCode(device.uniqueId);
    const code = review ?? String(randomInt(0, 1_000_000)).padStart(6, '0');
    const row = await this.prisma.mobileTrackerCode.create({ data: { deviceId: device.id, code, email: contact, name: name?.trim() || null, expiresAt: new Date(Date.now() + CODE_TTL_MS) } });
    // A phone without any contact yet also gets the code at the typed address.
    if (contact && !device.activationEmail) device.activationEmail = contact;
    // Store review number: fixed code, nothing is sent.
    const [smsSent, emailed] = review ? [true, [] as string[]] : await Promise.all([this.sendOtpSms(device.companyId!, device.uniqueId, code), this.emailCode(device, code)]);
    if (smsSent || emailed.length) await this.prisma.mobileTrackerCode.update({ where: { id: row.id }, data: { smsSent, emailCount: emailed.length } });
    return { ok: true, mobile: device.uniqueId, smsSent, emailSent: emailed.length > 0, sentTo: emailed.map(maskEmail), expiresInSec: CODE_TTL_MS / 1000, selfService: false };
  }

  /**
   * Number not registered by an administrator: OTP by SMS to the phone (and to the e-mail as a fallback). On verify the
   * phone joins the personal / family account of that e-mail or mobile, or a new personal account is created.
   */
  private async requestSelfService(uniqueId: string, email: string | undefined, name: string | undefined) {
    const mail = email?.trim().toLowerCase();
    if (!mail) throw trackerError(400, 'EMAIL_REQUIRED', 'This number is not registered yet. Enter your e-mail address: the phone will be added to your VeeTrax account (or a new one).');
    const owner = await this.self.findOwner(this.prisma, mail, uniqueId);
    const recent = await this.prisma.mobileTrackerCode.findMany({
      where: { deviceId: null, mobile: uniqueId, createdAt: { gt: new Date(Date.now() - DAY_MS) } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (recent[0] && Date.now() - recent[0].createdAt.getTime() < CODE_RESEND_MS) throw trackerError(429, 'TOO_SOON', 'Please wait 30 seconds before asking for a new code.');
    if (recent.length >= CODE_MAX_PER_DAY) throw trackerError(429, 'TOO_MANY', 'Too many codes for this number today. Try again tomorrow.');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const row = await this.prisma.mobileTrackerCode.create({
      data: { mobile: uniqueId, email: mail, name: name?.trim() || null, companyId: owner?.companyId ?? null, code, expiresAt: new Date(Date.now() + CODE_TTL_MS) },
    });
    const minutes = CODE_TTL_MS / 60_000;
    const [smsSent, mailed] = await Promise.all([
      this.sendOtpSms(owner?.companyId ?? null, uniqueId, code),
      this.mailer
        .send({
          to: mail,
          subject: `${code} is your VeeTrax Tracker code for ${formatMobile(uniqueId)}`,
          text: `Your VeeTrax Tracker code for ${formatMobile(uniqueId)} is ${code}. It expires in ${minutes} minutes. Do not share it with anyone.`,
          html: `<p>Your VeeTrax Tracker code for <b>${formatMobile(uniqueId)}</b> is</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>It expires in ${minutes} minutes. Do not share it with anyone.</p>`,
        })
        .then(() => true)
        .catch((e: Error) => (this.logger.warn(`Tracker code email to ${mail} failed: ${e.message}`), false)),
    ]);
    if (smsSent || mailed) await this.prisma.mobileTrackerCode.update({ where: { id: row.id }, data: { smsSent, emailCount: mailed ? 1 : 0 } });
    return { ok: true as const, mobile: uniqueId, smsSent, emailSent: mailed, sentTo: mailed ? [maskEmail(mail)] : [], expiresInSec: CODE_TTL_MS / 1000, selfService: true };
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
  async sendOtpSms(companyId: string | null, uniqueId: string, code: string): Promise<boolean> {
    if (this.messages.sms.name === 'console') return false;
    const company = companyId ? await this.prisma.company.findUnique({ where: { id: companyId }, select: { name: true } }) : null;
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
    if (companyId) await this.messages.log({ companyId, channel: 'SMS', recipient: to, templateId: rendered?.templateId ?? null, subject: null, body: text, status: error ? 'FAILED' : 'SENT', error, provider: this.messages.sms.name, secrets: [code] });
    return !error;
  }

  async verify(body: { mobile: string; code: string; deviceName?: string; appVersion?: string; platform?: string; installId?: string }) {
    const uniqueId = this.normalize(body.mobile);
    const known = await this.findDevice(uniqueId);
    if (!known || !known.companyId) return this.verifySelfService(uniqueId, body);
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
    await this.applyContact(device, row.email, row.name);
    return this.startSession(await this.deviceByMobile(body.mobile), body);
  }

  /**
   * After a verified code on a registered phone: the e-mail typed in the app becomes the device's contact, and for
   * personal / family accounts the typed name renames the tracked person (business vehicles keep the admin's name).
   */
  private async applyContact(device: Awaited<ReturnType<MobileTrackerService['deviceByMobile']>>, email: string | null, name: string | null) {
    if (email && email !== device.activationEmail) await this.prisma.device.update({ where: { id: device.id }, data: { activationEmail: email } });
    const object = device.assignments[0]?.object;
    const personal = device.company?.accountType === 'INDIVIDUAL' || device.company?.accountType === 'FAMILY';
    if (name && object && personal && name !== object.name) await this.prisma.trackedObject.update({ where: { id: object.id }, data: { name } });
  }

  /**
   * Activation screen, after the number is typed: whether it is registered and its e-mail / name. Full details only
   * when this phone (install id) activated that number before; otherwise just a masked e-mail hint, so typing someone
   * else's number reveals nothing useful.
   */
  async lookup(mobile: string, installId?: string): Promise<{ registered: boolean; samePhone: boolean; email: string | null; name: string | null; emailHint: string | null }> {
    const uniqueId = this.normalize(mobile);
    const device = await this.findDevice(uniqueId);
    if (!device || !device.companyId) return { registered: false, samePhone: false, email: null, name: null, emailHint: null };
    let email = device.activationEmail;
    if (!email && device.company?.accountType !== 'BUSINESS') {
      const owner = await this.prisma.user.findFirst({ where: { companyId: device.companyId, isActive: true, email: { not: null } }, orderBy: { createdAt: 'asc' }, select: { email: true } });
      email = owner?.email ?? null;
    }
    const hash = hashInstallId(installId);
    const samePhone = !!hash && (await this.prisma.mobileTrackerSession.count({ where: { deviceId: device.id, installIdHash: hash } })) > 0;
    const name = device.assignments[0]?.object.name ?? null;
    return samePhone
      ? { registered: true, samePhone, email, name, emailHint: null }
      : { registered: true, samePhone, email: null, name: null, emailHint: email ? maskEmail(email) : null };
  }

  /**
   * Reinstall / app data lost on the phone that is still the active one for its number: the same install id gets a new
   * token without a code. Only while that session was never signed out or stopped (revoked) and the device is on.
   */
  async restore(body: { installId: string; deviceName?: string; appVersion?: string; platform?: string }) {
    const hash = hashInstallId(body.installId);
    const row = hash
      ? await this.prisma.mobileTrackerSession.findFirst({ where: { installIdHash: hash, revokedAt: null }, orderBy: { createdAt: 'desc' }, select: { device: { select: { uniqueId: true } } } })
      : null;
    if (!row) throw trackerError(404, 'NOT_FOUND', 'No earlier activation of this phone.');
    const device = await this.deviceByMobile(row.device.uniqueId);
    this.logger.log(`Tracker ${device.uniqueId} restored after reinstall (app ${body.appVersion ?? '?'})`);
    return this.startSession(device, body);
  }

  /** Self-service verify: the code proves the number; the phone joins / creates the personal account, then starts. */
  private async verifySelfService(uniqueId: string, body: { code: string; deviceName?: string; appVersion?: string; platform?: string; installId?: string }) {
    const row = await this.prisma.mobileTrackerCode.findFirst({
      where: { deviceId: null, mobile: uniqueId, purpose: 'ACTIVATE', consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!row || !row.email) throw trackerError(401, 'CODE_EXPIRED', 'The code has expired or was not requested. Ask for a new code.');
    if (row.attempts >= CODE_MAX_ATTEMPTS) throw trackerError(401, 'TOO_MANY', 'Too many wrong attempts. Ask for a new code.');
    if (row.code !== (body.code ?? '').trim()) {
      await this.prisma.mobileTrackerCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
      throw trackerError(401, 'WRONG_CODE', 'Wrong code.');
    }
    const email = row.email;
    const provisioned = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.mobileTrackerCode.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
      if (!count) throw trackerError(401, 'CODE_EXPIRED', 'The code was already used. Ask for a new code.');
      return this.self.provision(tx, { mobile: uniqueId, email, name: row.name });
    });
    this.logger.log(`Self-service tracker ${uniqueId} → company ${provisioned.companyId}${provisioned.newAccount ? ' (new account)' : ''}`);
    const device = await this.deviceByMobile(uniqueId);
    void this.self.notifyStarted(this.prisma, { ...provisioned, mobile: uniqueId, email });
    return this.startSession(device, body);
  }

  private async startSession(device: Awaited<ReturnType<MobileTrackerService['deviceByMobile']>>, body: { deviceName?: string; appVersion?: string; platform?: string; installId?: string }) {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const next = { installIdHash: hashInstallId(body.installId), deviceName: body.deviceName?.slice(0, 80) ?? null };
    const previous = await this.prisma.mobileTrackerSession.findFirst({ where: { deviceId: device.id }, orderBy: { createdAt: 'desc' }, select: { installIdHash: true, deviceName: true, revokedAt: true, lastUsedAt: true } });
    // One phone per number: activating here stops every earlier phone.
    await this.prisma.$transaction([
      this.prisma.mobileTrackerSession.updateMany({ where: { deviceId: device.id, revokedAt: null }, data: { revokedAt: now } }),
      this.prisma.mobileTrackerSession.create({
        data: { deviceId: device.id, tokenHash: hashToken(token), deviceName: next.deviceName, appVersion: body.appVersion?.slice(0, 20) ?? null, platform: body.platform?.slice(0, 20) ?? null, installIdHash: next.installIdHash, lastUsedAt: now },
      }),
    ]);
    for (const [k, s] of this.sessions) if (s.deviceId === device.id) this.sessions.delete(k);
    const object = device.assignments[0]?.object;
    if (object && device.companyId && isDifferentPhone(previous, next)) {
      // After the new phone is active; a failed alert must not fail the activation.
      void this.alerts
        .trackerDeviceChanged({ companyId: device.companyId, deviceId: device.id, object, mobile: formatMobile(device.uniqueId), from: previous?.deviceName ?? null, to: next.deviceName }, now.getTime())
        .catch((e: Error) => this.logger.error(`Tracker device changed alert for ${device.id} failed: ${e.message}`));
    } else if (object && device.companyId) {
      void this.alertPhoneReturn({ companyId: device.companyId, deviceId: device.id, object }, device.uniqueId, previous, next, now).catch((e: Error) => this.logger.error(`Tracker reactivated alert for ${device.id} failed: ${e.message}`));
    }
    return { token, ...this.describe(device), config: this.config() };
  }

  /** The number set up again: on the same phone (reinstalled, signed out or stopped by an administrator) or on a different phone. */
  private async alertPhoneReturn(
    target: { companyId: string; deviceId: string; object: { id: string; name: string; branchId: string | null; plateNumber: string | null; speedLimitKph: number | null } },
    uniqueId: string,
    previous: Parameters<typeof phoneReturn>[0],
    next: { installIdHash: string | null; deviceName: string | null },
    now: Date,
  ): Promise<void> {
    const signedOut = previous?.revokedAt
      ? (await this.prisma.trackerEvent.count({ where: { deviceId: target.deviceId, kind: 'stop', why: 'signed out', at: { gte: previous.revokedAt } } })) > 0
      : false;
    const back = phoneReturn(previous, next, signedOut, now.getTime());
    if (!back) return;
    const mobile = formatMobile(uniqueId);
    await this.alerts.trackerReactivated({ ...target, mobile, how: back.how, message: phoneReturnMessage(mobile, next.deviceName, back.how, back.awayMs, previous?.deviceName ?? null) }, now.getTime());
  }

  /** What the Tracker app shows: who / what is tracked, the account (type, e-mail) and the free-trial end. */
  private describe(device: {
    uniqueId: string;
    activationEmail?: string | null;
    company: { name: string; accountType?: string } | null;
    licenceSeat?: { source: string; expiresAt: Date } | null;
    assignments: { object: { name: string } }[];
  }) {
    return {
      uniqueId: device.uniqueId,
      mobile: formatMobile(device.uniqueId),
      objectName: device.assignments[0]?.object.name ?? null,
      companyName: device.company?.name ?? null,
      accountType: device.company?.accountType ?? null,
      email: device.activationEmail ?? null,
      trialEndsAt: device.licenceSeat?.source === 'TRIAL' ? device.licenceSeat.expiresAt.toISOString() : null,
      licenceEndsAt: device.licenceSeat?.expiresAt.toISOString() ?? null,
    };
  }

  /** Resolves the Bearer token: 401 REVOKED / INVALID, 403 INACTIVE. */
  private async session(authorization: string | undefined, allowRevoked = false): Promise<CachedSession> {
    const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
    if (!token) throw trackerError(401, 'INVALID', 'Not activated');
    const key = hashToken(token);
    const cached = this.sessions.get(key);
    if (cached && Date.now() - cached.checkedAt < SESSION_CACHE_MS) return cached;
    const row = await this.prisma.mobileTrackerSession.findUnique({ where: { tokenHash: key }, select: { id: true, revokedAt: true, deviceId: true, appVersion: true, device: { select: { uniqueId: true, isActive: true, companyId: true, trackingRequired: true, company: { select: { status: true } }, assignments: { where: { toTime: null }, select: { object: { select: { isActive: true } } } } } } } });
    if (!row) throw trackerError(401, 'INVALID', 'Please activate again');
    // The same test as the processor's (device-cache): it would discard what we accept, and the phone would delete it.
    const blocked = !row.device.isActive || !row.device.companyId || row.device.company?.status !== 'ACTIVE' || row.device.assignments[0]?.object.isActive === false;
    if (row.revokedAt) {
      this.sessions.delete(key);
      if (allowRevoked && blocked) throw trackerError(403, 'INACTIVE', 'Tracking switched off by your administrator');
      if (allowRevoked) return { sessionId: row.id, deviceId: row.deviceId, uniqueId: row.device.uniqueId, required: false, revokedAt: row.revokedAt.getTime(), checkedAt: 0, lastUsedWrite: Date.now() };
      throw trackerError(401, 'REVOKED', 'Tracking moved to another phone with the same number');
    }
    if (blocked) throw trackerError(403, 'INACTIVE', 'Tracking switched off by your administrator');
    const next: CachedSession = { sessionId: row.id, deviceId: row.deviceId, uniqueId: row.device.uniqueId, required: row.device.trackingRequired, checkedAt: Date.now(), lastUsedWrite: cached?.lastUsedWrite ?? 0, appVersion: row.appVersion };
    this.sessions.set(key, next);
    return next;
  }

/** The app's "Sign out / deactivate": ends this phone's session (a reinstall then needs a new code). */
  async signOut(authorization: string | undefined): Promise<{ ok: true }> {
    const s = await this.session(authorization).catch(() => null);
    if (s) {
      await this.prisma.mobileTrackerSession.updateMany({ where: { id: s.sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
      for (const [k, c] of this.sessions) if (c.sessionId === s.sessionId) this.sessions.delete(k);
      await this.recordSignOut(s).catch((e: Error) => this.logger.error(`Sign-out of tracker ${s.deviceId} not recorded: ${e.message}`));
    }
    return { ok: true };
  }

  /** Signing out wipes the phone's event list, so the server records this stop itself. It never fails the sign-out. */
  private async recordSignOut(s: CachedSession): Promise<void> {
    const at = new Date();
    await this.prisma.trackerEvent.createMany({ data: [{ deviceId: s.deviceId, kind: 'stop', at, why: 'signed out' }], skipDuplicates: true });
    const target = await this.alertTarget(s.deviceId);
    if (target) await this.alerts.trackerSwitched({ ...target, mobile: formatMobile(s.uniqueId), on: false, why: 'signed out of the tracker app' }, at.getTime());
  }

  /** The phone's app version (header or health report) when it differs from the stored one: an in-place update. */
  private async noteVersion(s: CachedSession, raw: unknown): Promise<void> {
    const v = typeof raw === 'string' ? raw.trim().slice(0, 20) : '';
    if (!v || !/^[0-9A-Za-z.+-]+$/.test(v) || v === s.appVersion || s.revokedAt) return;
    s.appVersion = v;
    await this.prisma.mobileTrackerSession.update({ where: { id: s.sessionId }, data: { appVersion: v } }).catch(() => undefined);
  }

  async me(authorization: string | undefined, appVersion?: string) {
    const s = await this.session(authorization);
    await this.noteVersion(s, appVersion);
    const device = await this.prisma.device.findUniqueOrThrow({
      where: { id: s.deviceId },
      select: {
        uniqueId: true,
        activationEmail: true,
        company: { select: { name: true, accountType: true } },
        licenceSeat: { select: { source: true, expiresAt: true } },
        assignments: { where: { toTime: null }, select: { object: { select: { name: true } } } },
      },
    });
    return { ...this.describe(device), config: this.config(), required: s.required };
  }

  /** Validates the points and adds them to the positions stream (the gateway's path into the processor). */
  async upload(authorization: string | undefined, points: unknown[], health?: unknown): Promise<{ ok: true; accepted: number; config: TrackerConfig; required: boolean; revoked?: true }> {
    // App 1.3.4+ says it can deliver its queue after the number moved to another phone (older apps get the 401 and stop).
    const canDrain = (health as { drain?: unknown } | null | undefined)?.drain === true;
    const s = await this.session(authorization, canDrain);
    await this.noteVersion(s, (health as { app?: unknown } | null | undefined)?.app);
    const now = Date.now();
    // An old phone's report must not overwrite the new phone's.
    if (s.revokedAt === undefined) {
      this.saveHealth(s.deviceId, sanitizeTrackerHealth(health), now);
      this.saveEvents(s, sanitizeTrackerEvents(health), now);
    }
    const config = this.config();
    const parsed: NonNullable<ReturnType<typeof parsePoint>>[] = [];
    const rejected: { raw: unknown; reason: string }[] = [];
    for (const raw of points.slice(0, MAX_POINTS_PER_CALL)) {
      const p = parsePoint(raw, now);
      if (!p) rejected.push({ raw, reason: rejectReason(raw, now) });
      else if (s.revokedAt !== undefined && p.t > s.revokedAt) rejected.push({ raw, reason: 'after moving to another phone' });
      else parsed.push(p);
    }
    parsed.sort((a, b) => a.t - b.t);
    if (parsed.length) {
      const pipeline = this.redis.client.pipeline();
      const maxLen = positionsStreamMaxLen();
      const spikes = roughSpikes(parsed);
      parsed.forEach((p, i) => pipeline.xadd(RedisKeys.positionsStream, 'MAXLEN', '~', maxLen, '*', 'data', JSON.stringify(toNormalized(p, s.uniqueId, now, config, spikes.has(i))), 'remote', 'tracker-app'));
      // The phone deletes what we confirm, so a failed write must not be confirmed.
      const results = await pipeline.exec();
      if (!results || results.some(([error]) => error)) throw new ServiceUnavailableException('Positions could not be saved, try again.');
    }
    await this.saveRejected(s, rejected, now);
    if (s.revokedAt !== undefined) return { ok: true, accepted: parsed.length, config, required: false, revoked: true };
    if (now - s.lastUsedWrite > LAST_USED_WRITE_MS) {
      s.lastUsedWrite = now;
      await this.prisma.mobileTrackerSession.update({ where: { id: s.sessionId }, data: { lastUsedAt: new Date(now) } }).catch(() => undefined);
    }
    const attention = await this.noticeFor(s.deviceId, now);
    return { ok: true, accepted: parsed.length, config, required: s.required, ...(attention ? { attention } : {}) };
  }

  /** Never fails an upload: the phone has its points to deliver. */
  private async noticeFor(deviceId: string, now: number): Promise<PhoneAttention | null> {
    const hit = this.notices.get(deviceId);
    if (hit && now - hit.at < NOTICE_CACHE_MS) return hit.value;
    const value = (await this.attendance?.phoneNotice(deviceId).catch(() => null)) ?? null;
    this.notices.set(deviceId, { at: now, value });
    return value;
  }

  // ───────────── attendance on the phone ─────────────

  private requireAttendance(): AttendanceService {
    if (!this.attendance) throw new NotFoundException('Attendance is not available');
    return this.attendance;
  }

  async attendanceStatus(authorization: string | undefined): Promise<PhoneAttendanceDto> {
    const s = await this.session(authorization);
    return this.requireAttendance().phoneStatus(s.deviceId);
  }

  async attendanceAnswer(authorization: string | undefined, b: { leftAt: string; kind: 'OFFICIAL' | 'PERSONAL'; note?: string }): Promise<PhoneAttendanceDto> {
    const s = await this.session(authorization);
    this.notices.delete(s.deviceId);
    return this.requireAttendance().phoneAnswer(s.deviceId, b);
  }

  async attendanceSelfie(authorization: string | undefined, file: { buffer: Buffer; mimetype?: string } | undefined): Promise<PhoneAttendanceDto> {
    const s = await this.session(authorization);
    this.notices.delete(s.deviceId);
    return this.requireAttendance().phoneSelfie(s.deviceId, file);
  }

  async attendanceVideo(authorization: string | undefined, file: { buffer: Buffer; mimetype?: string } | undefined): Promise<PhoneAttendanceDto> {
    const s = await this.session(authorization);
    this.notices.delete(s.deviceId);
    return this.requireAttendance().phoneVideo(s.deviceId, file);
  }

  /** Points we refuse are kept for inspection (raw packets, protocol mobile-rejected) and explained in the phone's history. */
  private async saveRejected(s: CachedSession, rejected: { raw: unknown; reason: string }[], now: number): Promise<void> {
    if (!rejected.length) return;
    const at = new Date(now);
    const why = `server rejected ${rejected.length}: ${summarizeRejected(rejected.map((r) => r.reason))}`.slice(0, 80);
    this.logger.warn(`Tracker ${s.uniqueId}: ${why}`);
    await Promise.all([
      this.prisma.rawPacket.createMany({ data: rejected.map((r) => ({ uniqueId: s.uniqueId, protocol: 'mobile-rejected', receivedAt: at, hex: JSON.stringify({ reason: r.reason, point: r.raw }).slice(0, 2000) })) }),
      this.prisma.trackerEvent.createMany({ data: [{ deviceId: s.deviceId, kind: 'discard', at, why }], skipDuplicates: true }),
    ]).catch((e: Error) => this.logger.warn(`Rejected points of ${s.uniqueId} not saved: ${e.message}`));
  }

  /** The phone re-sends events until an upload succeeds, so repeats are expected and ignored. */
  private saveEvents(s: CachedSession, events: { kind: TrackerEventKind; at: number; why: string }[], now: number): void {
    if (!events.length) return;
    const { deviceId } = s;
    this.prisma.trackerEvent
      // Only the rows really added come back, so a re-sent event never raises its alert twice.
      .createManyAndReturn({ data: events.map((e) => ({ deviceId, kind: e.kind, at: new Date(e.at), why: e.why })), skipDuplicates: true, select: { kind: true, at: true, why: true } })
      .then((added) => this.alertOnOff(s, added, now))
      .catch((e: Error) => this.logger.warn(`Tracker events for ${deviceId} not saved: ${e.message}`));
  }

  /** Tracking switched off / on at the phone: alerts for the company, with the reason the phone gave. */
  private async alertOnOff(s: CachedSession, added: { kind: string; at: Date; why: string }[], now: number): Promise<void> {
    const events = added.filter((e) => e.kind === 'start' || e.kind === 'stop').sort((a, b) => a.at.getTime() - b.at.getTime());
    if (!events.length) return;
    const before = await this.prisma.trackerEvent.findFirst({
      where: { deviceId: s.deviceId, kind: { in: ['start', 'stop'] }, at: { lt: events[0].at } },
      orderBy: { at: 'desc' },
      select: { kind: true, why: true },
    });
    const changes = trackerOnOffChanges(before, events);
    if (!changes.length) return;
    const target = await this.alertTarget(s.deviceId);
    if (!target) return;
    const mobile = formatMobile(s.uniqueId);
    // The phone's clock is only trusted up to now: an alert from the future would sort above everything.
    for (const e of changes) await this.alerts.trackerSwitched({ ...target, mobile, on: e.kind === 'start', why: e.why === 'app' ? 'from the tracker app' : e.why }, Math.min(e.at.getTime(), now));
  }

  /** The company and vehicle an alert about this phone belongs to; null when it isn't assigned to one. */
  private async alertTarget(deviceId: string) {
    const d = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { companyId: true, assignments: { where: { toTime: null }, select: { object: { select: { id: true, name: true, branchId: true, plateNumber: true, speedLimitKph: true } } } } },
    });
    const object = d?.assignments[0]?.object;
    return d?.companyId && object ? { companyId: d.companyId, deviceId, object } : null;
  }

  /** Keeps the latest health report on the device: on change (ignoring counters), else every HEALTH_WRITE_MS. */
  private saveHealth(deviceId: string, health: TrackerHealth | null, now: number): void {
    if (!health) return;
    const { failures: _f, mode: _m, queue: _q, lastFixAt: _l, ...stable } = health;
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
      select: { id: true, companyId: true, uniqueId: true, activationEmail: true, trackingRequired: true, trackerHealth: true, trackerHealthAt: true, company: { select: { accountType: true } }, model: { select: { protocol: true } } },
    });
    if (!d) throw new NotFoundException('Device not found');
    if (d.model.protocol !== MOBILE_MODEL_PROTOCOL) throw new ForbiddenException('Not a mobile tracker');
    return d;
  }

  /** Active phone, pending activation code (to read out when SMS isn't set up) and earlier phones. */
  async adminStatus(ctx: AuthContext, deviceId: string): Promise<MobileTrackerStatusDto> {
    const d = await this.ownDevice(ctx, deviceId);
    const [sessions, code, events] = await Promise.all([
      this.prisma.mobileTrackerSession.findMany({ where: { deviceId: d.id }, orderBy: { createdAt: 'desc' }, take: 5 }),
      this.prisma.mobileTrackerCode.findFirst({ where: { deviceId: d.id, consumedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } }),
      this.prisma.trackerEvent.findMany({ where: { deviceId: d.id }, orderBy: { at: 'desc' }, take: 30 }),
    ]);
    return {
      mobile: formatMobile(d.uniqueId),
      events: events.map((e) => ({ kind: e.kind as TrackerEventKind, at: e.at.toISOString(), why: e.why })),
      pendingCode: code ? { code: code.code, expiresAt: code.expiresAt.toISOString(), smsSent: code.smsSent, emailCount: code.emailCount } : null,
      activationEmail: d.activationEmail,
      trackingRequired: d.trackingRequired,
      canRequireTracking: d.company?.accountType === 'BUSINESS',
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

  /**
   * Company phones only: tracking stays on whatever happens on the phone. People's own phones on personal and family
   * accounts always keep their Stop button.
   */
  async adminSetRequired(ctx: AuthContext, deviceId: string, required: boolean) {
    const d = await this.ownDevice(ctx, deviceId);
    if (d.company?.accountType !== 'BUSINESS') throw new ForbiddenException('Tracking can only be required on company phones.');
    await this.prisma.device.update({ where: { id: d.id }, data: { trackingRequired: required } });
    for (const [k, c] of this.sessions) if (c.deviceId === d.id) this.sessions.delete(k);
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'Device', entityId: d.id, before: { trackingRequired: d.trackingRequired }, after: { trackingRequired: required } });
    return this.adminStatus(ctx, deviceId);
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

