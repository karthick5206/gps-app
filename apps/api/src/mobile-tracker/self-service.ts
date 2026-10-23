import { ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { formatMobile } from '@veetracer/shared';
import { Prisma } from '@prisma/client';
import { ensureSystemRoles } from '../access/system-roles';
import { MailerService } from '../auth/mailer.service';
import { randomToken, sha256 } from '../common/secrets';
import { loadEnv } from '../config/env';
import { LicenceSettingsService } from '../licences/licence-settings.service';
import { grantTrialSeat } from '../licences/trial';
import { DEFAULT_PARTNER_SLUG } from '../masters/companies/companies.service';
import { MOBILE_MODEL_PROTOCOL } from './mobile-tracker.logic';

const DAY_MS = 24 * 3600_000;
/** "Set your password" link in the tracking-started e-mail of a new account. */
const SET_PASSWORD_TTL_MS = 7 * DAY_MS;

type Tx = Prisma.TransactionClient;

export interface Owner {
  userId: string;
  companyId: string;
  accountType: string;
  hasPassword: boolean;
  name: string;
  email: string | null;
}

export interface Provisioned {
  deviceId: string;
  companyId: string;
  userId: string;
  newAccount: boolean;
  trialEndsAt: Date | null;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Tracker app self-service (numbers no administrator registered): the phone's number is verified by OTP, then the
 * phone joins the personal / family account of the e-mail (or mobile) entered, or a new personal account is created.
 * Company (business) users can't do this: their administrator adds phones in Devices. Each of an account's first
 * TRIAL_PHONES phones gets a TRIAL_DAYS free Mobile-tracker seat.
 */
@Injectable()
export class TrackerSelfService {
  private readonly logger = new Logger(TrackerSelfService.name);
  private readonly webUrl = loadEnv().webUrl;

  constructor(
    private readonly mailer: MailerService,
    private readonly licences: LicenceSettingsService,
  ) {}

  /** The existing account for this e-mail / mobile, or null (a new personal account will be created). */
  async findOwner(db: Tx, email: string, mobile: string): Promise<Owner | null> {
    const user = await db.user.findFirst({
      where: { OR: [{ email: { equals: email, mode: 'insensitive' } }, { mobile: `+${mobile}` }], isActive: true },
      select: { id: true, name: true, email: true, passwordHash: true, companyId: true, company: { select: { accountType: true, status: true } } },
      orderBy: { createdAt: 'asc' },
    });
    if (!user) return null;
    if (user.company.accountType === 'BUSINESS') {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'COMPANY_ACCOUNT',
        message: 'This e-mail / number belongs to a company account. Ask your administrator to add this phone in VeeTrax → Devices.',
      });
    }
    return { userId: user.id, companyId: user.companyId, accountType: user.company.accountType, hasPassword: !!user.passwordHash, name: user.name, email: user.email };
  }

  /** Creates (or reuses) the account, the phone tracker with its person object and, while the trial lasts, its seat. */
  async provision(tx: Tx, input: { mobile: string; email: string; name: string | null }): Promise<Provisioned> {
    const now = new Date();
    let owner = await this.findOwner(tx, input.email, input.mobile);
    let newAccount = false;
    if (!owner) {
      const partner = await tx.partner.findUnique({ where: { slug: DEFAULT_PARTNER_SLUG } });
      if (!partner) throw new ConflictException('Sign-up is not available right now');
      const name = input.name?.trim() || input.email.split('@')[0];
      const company = await tx.company.create({ data: { partnerId: partner.id, name, accountType: 'INDIVIDUAL' } });
      const roles = await ensureSystemRoles(tx, company.id);
      const branch = await tx.branch.create({ data: { companyId: company.id, name: 'Home' } });
      const user = await tx.user.create({
        data: {
          companyId: company.id,
          name,
          email: input.email,
          mobile: `+${input.mobile}`,
          roles: { create: [{ roleId: roles.get('Admin')! }] },
          branches: { create: [{ branchId: branch.id }] },
        },
      });
      const starterDays = (await this.licences.get()).overrideDays;
      await tx.licenceSeat.create({
        data: { type: 'USER', companyId: company.id, source: 'OVERRIDE', activatedAt: now, expiresAt: new Date(now.getTime() + starterDays * DAY_MS), userId: user.id, assignedAt: now, note: 'Starter seat: Tracker app sign-up' },
      });
      owner = { userId: user.id, companyId: company.id, accountType: 'INDIVIDUAL', hasPassword: false, name, email: input.email };
      newAccount = true;
    }

    const personName = input.name?.trim() || (newAccount ? owner.name : formatMobile(input.mobile));
    const { deviceId, trialEndsAt } = await this.addPhone(tx, owner, { mobile: input.mobile, email: input.email, name: personName });
    return { deviceId, companyId: owner.companyId, userId: owner.userId, newAccount: newAccount || !owner.hasPassword, trialEndsAt };
  }

  /**
   * Adds a phone tracker to a personal / family account: device, person object, free-trial seat (first TRIAL_PHONES
   * phones) or a bought free seat; two or more phones make the account FAMILY. Used by self-service activation and by
   * "Add family member" (after the member's OTP consent).
   */
  async addPhone(tx: Tx, owner: { companyId: string; accountType: string }, input: { mobile: string; email: string | null; name: string }): Promise<{ deviceId: string; trialEndsAt: Date | null }> {
    const now = new Date();
    const model = await tx.deviceModel.findFirst({ where: { protocol: MOBILE_MODEL_PROTOCOL }, select: { id: true } });
    if (!model) throw new ConflictException('Phone tracking is not set up on this server');
    if (await tx.device.count({ where: { uniqueId: input.mobile } })) throw new ConflictException('This number is already a tracker in VeeTrax');
    const home = await tx.branch.findFirst({ where: { companyId: owner.companyId }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    const personName = input.name;
    const device = await tx.device.create({
      data: { companyId: owner.companyId, modelId: model.id, uniqueId: input.mobile, activationEmail: input.email, ingestToken: randomToken(24) },
    });
    const object = await tx.trackedObject.create({ data: { companyId: owner.companyId, branchId: home?.id ?? null, name: personName, type: 'PERSON' } });
    await tx.deviceAssignment.create({ data: { deviceId: device.id, objectId: object.id, fromTime: now } });

    // A bought, unused Mobile-tracker seat first; otherwise the free trial (first TRIAL_PHONES phones); else locked.
    let trialEndsAt: Date | null = null;
    const bought = await tx.licenceSeat.findFirst({
      where: { companyId: owner.companyId, type: 'MOBILE_TRACKER', deviceId: null, expiresAt: { gt: now }, source: { not: 'TRIAL' } },
      orderBy: { expiresAt: 'asc' },
    });
    if (bought) {
      await tx.licenceSeat.update({ where: { id: bought.id }, data: { deviceId: device.id, assignedAt: now } });
    } else {
      trialEndsAt = (await grantTrialSeat(tx, owner.companyId, 'MOBILE_TRACKER', device.id))?.expiresAt ?? null;
    }
    // Two or more phones: a family account.
    const phones = await tx.device.count({ where: { companyId: owner.companyId, model: { protocol: MOBILE_MODEL_PROTOCOL } } });
    if (phones >= 2 && owner.accountType === 'INDIVIDUAL') await tx.company.update({ where: { id: owner.companyId }, data: { accountType: 'FAMILY' } });
    return { deviceId: device.id, trialEndsAt };
  }

  /** "Tracking started" e-mail: how to see the phone in the VeeTrax app, and a set-password link for a new account. */
  async notifyStarted(db: Tx | Prisma.TransactionClient, p: Provisioned & { mobile: string; email: string }): Promise<void> {
    try {
      let setPassword = '';
      if (p.newAccount) {
        const token = randomToken(32);
        await db.passwordReset.create({ data: { userId: p.userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + SET_PASSWORD_TTL_MS) } });
        setPassword = `${this.webUrl}/reset-password?token=${encodeURIComponent(token)}`;
      }
      const phone = formatMobile(p.mobile);
      const trial = p.trialEndsAt ? `Free tracking until ${p.trialEndsAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}.` : 'This phone needs a licence before its location can be viewed.';
      const lines = [
        `Phone ${phone} is now tracking in VeeTrax and is mapped to your account (${p.email}).`,
        trial,
        `See its location, history and alerts in the VeeTrax app or at ${this.webUrl}: sign in with ${p.email} or with an OTP on ${phone}.`,
        ...(setPassword ? [`First time? Set your password here (valid 7 days): ${setPassword}`] : []),
        'Download: ' + `${this.webUrl}/download`,
      ];
      const html =
        `<p>Phone <b>${escapeHtml(phone)}</b> is now tracking in VeeTrax and is mapped to your account (<b>${escapeHtml(p.email)}</b>).</p>` +
        `<p>${escapeHtml(trial)}</p>` +
        `<p>See its location, history and alerts in the <b>VeeTrax app</b> or at <a href="${this.webUrl}">${escapeHtml(this.webUrl)}</a>: sign in with <b>${escapeHtml(p.email)}</b> or with an OTP on <b>${escapeHtml(phone)}</b>.</p>` +
        (setPassword ? `<p><a href="${setPassword}" style="display:inline-block;background:#0e5e57;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Set your password</a><br><small>Link valid for 7 days.</small></p>` : '') +
        `<p><a href="${this.webUrl}/download">Download the VeeTrax app</a></p>` +
        `<p style="color:#666">Thanks for choosing Vibhav Enterprise Solutions VeeTrax. Support: 9444907658.</p>`;
      await this.mailer.send({ to: p.email, subject: `Tracking started for ${phone} · VeeTrax`, text: lines.join('\n\n'), html });
    } catch (e) {
      this.logger.warn(`Tracking-started e-mail to ${p.email} failed: ${(e as Error).message}`);
    }
  }
}
