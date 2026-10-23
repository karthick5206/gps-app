import { ForbiddenException, HttpException, Injectable, Logger } from '@nestjs/common';
import { formatMobile, normalizeMobile, TRIAL_PHONES, type FamilyMembersDto } from '@veetracer/shared';
import { randomInt } from 'node:crypto';
import { AuthContext } from '../access/auth-context';
import { PrismaService } from '../prisma/prisma.service';
import { CODE_MAX_ATTEMPTS, CODE_MAX_PER_DAY, CODE_RESEND_MS, CODE_TTL_MS, MOBILE_MODEL_PROTOCOL } from './mobile-tracker.logic';
import { MobileTrackerService } from './mobile-tracker.service';
import { TrackerSelfService } from './self-service';

const DAY_MS = 24 * 3600_000;
const err = (status: number, code: string, message: string) => new HttpException({ statusCode: status, code, message }, status);

/**
 * Personal / family accounts: add another person's phone. The member's consent is an OTP sent by SMS to their phone,
 * which they read out to the account owner; then the phone is added (with a free-trial seat while the trial lasts)
 * and the member activates the VeeTrax Tracker app with their number as usual.
 */
@Injectable()
export class FamilyService {
  private readonly logger = new Logger(FamilyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trackers: MobileTrackerService,
    private readonly self: TrackerSelfService,
  ) {}

  private async personalCompany(ctx: AuthContext) {
    const c = await this.prisma.company.findUnique({ where: { id: ctx.companyId }, select: { id: true, accountType: true } });
    if (!c || c.accountType === 'BUSINESS') throw new ForbiddenException('Family members are for personal accounts. Business accounts add phones in Devices.');
    return c;
  }

  async list(ctx: AuthContext): Promise<FamilyMembersDto> {
    const c = await this.personalCompany(ctx);
    const devices = await this.prisma.device.findMany({
      where: { companyId: c.id, model: { protocol: MOBILE_MODEL_PROTOCOL } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        uniqueId: true,
        lastSeenAt: true,
        licenceSeat: { select: { source: true, expiresAt: true } },
        assignments: { where: { toTime: null }, select: { object: { select: { name: true } } } },
        trackerSessions: { where: { revokedAt: null }, select: { id: true }, take: 1 },
      },
    });
    const trialsUsed = await this.prisma.licenceSeat.count({ where: { companyId: c.id, source: 'TRIAL' } });
    return {
      accountType: c.accountType as FamilyMembersDto['accountType'],
      trialPhones: { used: trialsUsed, max: TRIAL_PHONES },
      members: devices.map((d) => ({
        deviceId: d.id,
        mobile: formatMobile(d.uniqueId),
        name: d.assignments[0]?.object.name ?? formatMobile(d.uniqueId),
        activated: d.trackerSessions.length > 0,
        lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
        trialEndsAt: d.licenceSeat?.source === 'TRIAL' ? d.licenceSeat.expiresAt.toISOString() : null,
        licenceEndsAt: d.licenceSeat?.expiresAt.toISOString() ?? null,
      })),
    };
  }

  /** Sends the consent OTP to the member's phone (DLT SMS). */
  async request(ctx: AuthContext, input: { name: string; mobile: string }): Promise<{ ok: true; mobile: string; smsSent: boolean; expiresInSec: number }> {
    const c = await this.personalCompany(ctx);
    const mobile = normalizeMobile(input.mobile);
    if (!mobile) throw err(400, 'BAD_NUMBER', 'Enter a valid mobile number');
    if (await this.prisma.device.count({ where: { uniqueId: mobile } })) throw err(409, 'TAKEN', 'This number is already a tracker in VeeTrax.');
    const recent = await this.prisma.mobileTrackerCode.findMany({ where: { mobile, purpose: 'FAMILY_ADD', createdAt: { gt: new Date(Date.now() - DAY_MS) } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    if (recent[0] && Date.now() - recent[0].createdAt.getTime() < CODE_RESEND_MS) throw err(429, 'TOO_SOON', 'Please wait 30 seconds before asking for a new code.');
    if (recent.length >= CODE_MAX_PER_DAY) throw err(429, 'TOO_MANY', 'Too many codes for this number today. Try again tomorrow.');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.mobileTrackerCode.create({ data: { purpose: 'FAMILY_ADD', companyId: c.id, mobile, name: input.name.trim(), code, expiresAt: new Date(Date.now() + CODE_TTL_MS) } });
    const smsSent = await this.trackers.sendOtpSms(c.id, mobile, code);
    if (!smsSent) this.logger.warn(`Family consent SMS to ${mobile} not sent`);
    return { ok: true, mobile: formatMobile(mobile), smsSent, expiresInSec: CODE_TTL_MS / 1000 };
  }

  /** The owner enters the code the member received: the phone joins the account. */
  async verify(ctx: AuthContext, input: { mobile: string; code: string }): Promise<FamilyMembersDto> {
    const c = await this.personalCompany(ctx);
    const mobile = normalizeMobile(input.mobile);
    if (!mobile) throw err(400, 'BAD_NUMBER', 'Enter a valid mobile number');
    const row = await this.prisma.mobileTrackerCode.findFirst({
      where: { mobile, purpose: 'FAMILY_ADD', companyId: c.id, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) throw err(400, 'CODE_EXPIRED', 'The code has expired. Send a new one.');
    if (row.attempts >= CODE_MAX_ATTEMPTS) throw err(400, 'TOO_MANY', 'Too many wrong attempts. Send a new code.');
    if (row.code !== input.code.trim()) {
      await this.prisma.mobileTrackerCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
      throw err(400, 'WRONG_CODE', 'Wrong code.');
    }
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.mobileTrackerCode.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
      if (!count) throw err(400, 'CODE_EXPIRED', 'The code was already used. Send a new one.');
      await this.self.addPhone(tx, { companyId: c.id, accountType: c.accountType }, { mobile, email: null, name: row.name || formatMobile(mobile) });
    });
    this.logger.log(`Family member ${mobile} added to company ${c.id} by ${ctx.userId}`);
    return this.list(ctx);
  }
}
