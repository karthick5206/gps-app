import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { photoFeaturesOf, type PhotoFeaturesDto, type PhotoFeaturesUpdate } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { accountOwnerOfPhone, companyEditBlock, PHOTO_FEATURES_SETTING, toPhotoFeaturesDto, trackerEditBlock, writePhotoFeatures } from './photo-features';

type AccountType = PhotoFeaturesDto['accountType'];

const notAllowed = (blockedBy: string) =>
  new ForbiddenException({
    statusCode: 403,
    code: 'FEATURES_NOT_ALLOWED',
    blockedBy,
    message: blockedBy === 'BUSINESS_ACCOUNT' ? 'Ask your administrator to change this.' : blockedBy === 'NOT_OWNER' ? 'Only the account owner can change this.' : 'Only an administrator can change this.',
  });

/** Person photos / photo notes switches of a company (see packages/shared/src/photo-features.ts). */
@Injectable()
export class PhotoFeaturesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  // ───────────── web / VeeTrax app (acting company) ─────────────

  async get(ctx: AuthContext): Promise<PhotoFeaturesDto> {
    const c = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { settings: true, accountType: true } });
    return toPhotoFeaturesDto(c.settings, c.accountType as AccountType, companyEditBlock(ctx));
  }

  async set(ctx: AuthContext, update: PhotoFeaturesUpdate): Promise<PhotoFeaturesDto> {
    const block = companyEditBlock(ctx);
    if (block) throw notAllowed(block);
    const before = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { settings: true, accountType: true } });
    const next = await writePhotoFeatures(this.prisma, ctx.companyId, before.settings, update);
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'company', entityId: ctx.companyId, before: { [PHOTO_FEATURES_SETTING]: photoFeaturesOf(before.settings) }, after: { [PHOTO_FEATURES_SETTING]: next } });
    await this.changed();
    return { ...next, canEdit: true, accountType: before.accountType as AccountType };
  }

  // ───────────── Tracker app (the phone's account) ─────────────

  async trackerGet(deviceId: string, uniqueId: string): Promise<PhotoFeaturesDto> {
    const t = await this.trackerTarget(deviceId, uniqueId);
    return toPhotoFeaturesDto(t.settings, t.accountType, trackerEditBlock(t.accountType, !!t.ownerUserId));
  }

  async trackerSet(deviceId: string, uniqueId: string, update: PhotoFeaturesUpdate): Promise<PhotoFeaturesDto> {
    const t = await this.trackerTarget(deviceId, uniqueId);
    const block = trackerEditBlock(t.accountType, !!t.ownerUserId);
    if (block) throw notAllowed(block);
    const next = await writePhotoFeatures(this.prisma, t.companyId, t.settings, update);
    await this.audit.recordSystem(
      { companyId: t.companyId, userId: t.ownerUserId, ip: null },
      { action: 'UPDATE', entity: 'company', entityId: t.companyId, before: { [PHOTO_FEATURES_SETTING]: photoFeaturesOf(t.settings) }, after: { [PHOTO_FEATURES_SETTING]: next }, details: { via: 'tracker app', deviceId } },
    );
    await this.changed();
    return { ...next, canEdit: true, accountType: t.accountType };
  }

  /** The phone's company and, when the phone's number is an admin user of a personal / family account, that owner. */
  private async trackerTarget(deviceId: string, uniqueId: string) {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId }, select: { companyId: true, company: { select: { settings: true, accountType: true } } } });
    if (!device?.companyId || !device.company) throw new NotFoundException('This phone is not linked to an account');
    const accountType = device.company.accountType as AccountType;
    const ownerUserId = accountType === 'BUSINESS' ? null : await accountOwnerOfPhone(this.prisma, device.companyId, uniqueId);
    return { companyId: device.companyId, settings: device.company.settings, accountType, ownerUserId };
  }

  /** Lists and the live map re-read objects (photo versions) and companies. */
  private async changed(): Promise<void> {
    await this.redis.invalidateCache('company').catch(() => undefined);
    await this.redis.invalidateCache('object').catch(() => undefined);
  }
}
