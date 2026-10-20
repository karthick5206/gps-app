import { ConflictException, HttpException, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { normalizeMobile, stateByCode } from '@veetracer/shared';
import { randomInt } from 'node:crypto';
import { ensureSystemRoles } from '../access/system-roles';
import { MailerService } from '../auth/mailer.service';
import { hashPassword, hmac } from '../common/secrets';
import { loadEnv } from '../config/env';
import { LicenceSettingsService } from '../licences/licence-settings.service';
import { DEFAULT_PARTNER_SLUG } from '../masters/companies/companies.service';
import { PrismaService } from '../prisma/prisma.service';

export const SIGNUP_CODE_TTL_MS = 10 * 60_000;
const RESEND_MS = 30_000;
const MAX_ATTEMPTS = 5;
/** At most this many codes per email per day (abuse / mail-bombing guard). */
const MAX_CODES_PER_DAY = 10;
const DAY_MS = 86_400_000;

export interface SignupDetails {
  email: string;
  code: string;
  name: string;
  mobile?: string;
  password: string;
  stateCode: string;
  city?: string;
}

const tooMany = (message: string) => new HttpException({ statusCode: 429, message }, 429);

/**
 * Personal (individual) accounts, self-service: the email is verified with a 6-digit code (Zoho mail), then a company of
 * type INDIVIDUAL is created with its owner as Admin. Pay first: devices and phones need licences bought afterwards;
 * the owner gets the same starter login seat as a new company's first admin.
 */
@Injectable()
export class SignupService {
  private readonly logger = new Logger(SignupService.name);
  private readonly secret = loadEnv().jwtSecret;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly licences: LicenceSettingsService,
  ) {}

  private hash(email: string, code: string): string {
    return hmac(this.secret, `signup:${email}:${code}`);
  }

  private async assertEmailFree(email: string): Promise<void> {
    if (await this.prisma.user.count({ where: { email } })) throw new ConflictException('This email already has a VeeTrax account. Please sign in.');
  }

  async requestCode(rawEmail: string, ip: string | null): Promise<{ ok: true; email: string; expiresInSec: number }> {
    const email = rawEmail.trim().toLowerCase();
    await this.assertEmailFree(email);
    const recent = await this.prisma.signupCode.findMany({ where: { email, createdAt: { gt: new Date(Date.now() - DAY_MS) } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    if (recent[0] && Date.now() - recent[0].createdAt.getTime() < RESEND_MS) throw tooMany('Please wait 30 seconds before asking for a new code.');
    if (recent.length >= MAX_CODES_PER_DAY) throw tooMany('Too many codes for this email today. Try again tomorrow.');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const row = await this.prisma.signupCode.create({ data: { email, codeHash: this.hash(email, code), expiresAt: new Date(Date.now() + SIGNUP_CODE_TTL_MS), ip } });
    const minutes = SIGNUP_CODE_TTL_MS / 60_000;
    try {
      await this.mailer.send({
      to: email,
      subject: `${code} is your VeeTrax sign-up code`,
      text: `Your VeeTrax verification code is ${code}. It expires in ${minutes} minutes.\n\nIf you didn't try to create a VeeTrax account, ignore this email.`,
      html:
        `<p>Your VeeTrax verification code is</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p>` +
        `<p>It expires in ${minutes} minutes.</p><p style="color:#666">If you didn't try to create a VeeTrax account, ignore this email.</p>`,
      });
    } catch (e) {
      // e.g. the mail provider rejects the sender: don't count it against the user's limits, say what happened.
      this.logger.error(`Sign-up code email to ${email} failed: ${(e as Error).message}`);
      await this.prisma.signupCode.delete({ where: { id: row.id } }).catch(() => undefined);
      throw new ServiceUnavailableException("We couldn't send the email right now. Please try again later.");
    }
    return { ok: true, email, expiresInSec: SIGNUP_CODE_TTL_MS / 1000 };
  }

  /** Checks the code and creates the personal account. The caller then signs in with the email and password. */
  async complete(d: SignupDetails): Promise<{ ok: true; email: string }> {
    const email = d.email.trim().toLowerCase();
    const row = await this.prisma.signupCode.findFirst({ where: { email, consumedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    if (!row) throw new UnauthorizedException('The code has expired or was not requested. Ask for a new code.');
    if (row.attempts >= MAX_ATTEMPTS) throw new UnauthorizedException('Too many wrong attempts. Ask for a new code.');
    if (row.codeHash !== this.hash(email, d.code.trim())) {
      await this.prisma.signupCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
      throw new UnauthorizedException('Wrong code.');
    }
    await this.assertEmailFree(email);
    const mobile = d.mobile?.trim() ? normalizeMobile(d.mobile) : null;
    if (d.mobile?.trim() && !mobile) throw new ConflictException('Enter a valid mobile number');
    // Stored like the rest of the app: +91XXXXXXXXXX.
    const storedMobile = mobile ? `+${mobile}` : null;
    if (storedMobile && (await this.prisma.user.count({ where: { mobile: storedMobile } }))) throw new ConflictException('This mobile number already has a VeeTrax account. Please sign in.');
    const state = stateByCode(d.stateCode);
    if (!state) throw new ConflictException('Choose your state');

    const passwordHash = await hashPassword(d.password);
    const starterDays = (await this.licences.get()).overrideDays;
    const name = d.name.trim();
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.signupCode.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
      if (!count) throw new UnauthorizedException('The code was already used. Ask for a new code.');
      const partner = await tx.partner.findUnique({ where: { slug: DEFAULT_PARTNER_SLUG } });
      if (!partner) throw new ConflictException('Sign-up is not available right now');
      const company = await tx.company.create({ data: { partnerId: partner.id, name, accountType: 'INDIVIDUAL' } });
      const roles = await ensureSystemRoles(tx, company.id);
      const branch = await tx.branch.create({ data: { companyId: company.id, name: 'Home' } });
      const user = await tx.user.create({
        data: {
          companyId: company.id,
          name,
          email,
          mobile: storedMobile,
          passwordHash,
          roles: { create: [{ roleId: roles.get('Admin')! }] },
          branches: { create: [{ branchId: branch.id }] },
        },
      });
      // Same complimentary login seat as a new company's first admin, so the owner can sign in and buy licences.
      const now = new Date();
      await tx.licenceSeat.create({
        data: { type: 'USER', companyId: company.id, source: 'OVERRIDE', activatedAt: now, expiresAt: new Date(now.getTime() + starterDays * DAY_MS), userId: user.id, assignedAt: now, note: 'Starter seat: personal sign-up' },
      });
      await tx.billingProfile.create({ data: { companyId: company.id, billingName: name, address: '', city: d.city?.trim() ?? '', stateCode: state.code, email } });
    });
    this.logger.log(`Personal account created for ${email}`);
    return { ok: true, email };
  }
}
