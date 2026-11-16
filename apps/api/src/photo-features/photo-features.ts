import { ForbiddenException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  FEATURE_OFF,
  FEATURE_OFF_MESSAGES,
  hasPhotoType,
  photoFeaturesOf,
  type ObjectType,
  type PhotoFeatureKey,
  type PhotoFeatures,
  type PhotoFeaturesDto,
  type PhotoFeaturesUpdate,
} from '@veetracer/shared';
import { ADMIN_ROLE, hasPermission } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { setCompanySetting } from '../common/company-settings';

/** Company.settings key of the switches (see packages/shared/src/photo-features.ts). */
export const PHOTO_FEATURES_SETTING = 'photos';

/** 403 FEATURE_OFF: the company's switch for this feature is off (uploads / changes refused, data kept). */
export function featureOff(key: PhotoFeatureKey): ForbiddenException {
  return new ForbiddenException({ statusCode: 403, code: FEATURE_OFF, feature: key, message: FEATURE_OFF_MESSAGES[key] });
}

/** Throws FEATURE_OFF unless the switch is on in these company settings. */
export function assertPhotoFeature(settings: unknown, key: PhotoFeatureKey): void {
  if (!photoFeaturesOf(settings)[key]) throw featureOff(key);
}

/** The photo version a client may see: none while the owner company's person photos are off (the cartoon is drawn). */
export function visiblePhotoVersion(photoAt: Date | null | undefined, companySettings: unknown): number | null {
  return photoAt && photoFeaturesOf(companySettings).personPhotos ? photoAt.getTime() : null;
}

/** Whether an object's photo is shown at all (type with photos, switch on). */
export function photoShown(type: ObjectType, companySettings: unknown): boolean {
  return hasPhotoType(type) && photoFeaturesOf(companySettings).personPhotos;
}

/** The switches after applying a PUT body (only the keys sent change). */
export function mergePhotoFeatures(current: PhotoFeatures, update: PhotoFeaturesUpdate): PhotoFeatures {
  return {
    personPhotos: typeof update.personPhotos === 'boolean' ? update.personPhotos : current.personPhotos,
    photoNotes: typeof update.photoNotes === 'boolean' ? update.photoNotes : current.photoNotes,
  };
}

/**
 * Who may switch for the acting company (web / VeeTrax app): the Super Admin (any company it acts in), the company's
 * built-in Admin, or a whole-company (COMPANY scope) user with settings:edit, like the other company settings. Never
 * in the Super Admin's "all companies" view (there is no single company to change).
 */
export function companyEditBlock(ctx: Pick<AuthContext, 'isSuperAdmin' | 'isCompanyAdmin' | 'permissions' | 'dataScope' | 'allCompanies'>): PhotoFeaturesDto['blockedBy'] | null {
  if (ctx.allCompanies) return 'NOT_ADMIN';
  if (ctx.isSuperAdmin || ctx.isCompanyAdmin) return null;
  return hasPermission(ctx, 'settings', 'edit') && ctx.dataScope === 'COMPANY' ? null : 'NOT_ADMIN';
}

/**
 * Tracker app: only the account owner of a personal / family account may switch. A business account's phones only
 * show the state ("Ask your administrator"). The owner is an active admin user of the account whose own mobile number
 * is this phone's number (self-service sign-up creates exactly that user); a family member's phone is not the owner's.
 */
export function trackerEditBlock(accountType: string | null | undefined, phoneIsOwner: boolean): PhotoFeaturesDto['blockedBy'] | null {
  if (accountType !== 'INDIVIDUAL' && accountType !== 'FAMILY') return 'BUSINESS_ACCOUNT';
  return phoneIsOwner ? null : 'NOT_OWNER';
}

export function toPhotoFeaturesDto(settings: unknown, accountType: PhotoFeaturesDto['accountType'], blockedBy: PhotoFeaturesDto['blockedBy'] | null): PhotoFeaturesDto {
  return { ...photoFeaturesOf(settings), canEdit: !blockedBy, ...(blockedBy ? { blockedBy } : {}), accountType };
}

type Db = PrismaClient | Prisma.TransactionClient;

/** Writes the merged switches as their own settings key (atomic jsonb_set, F9). Returns the new switches. */
export async function writePhotoFeatures(db: Db, companyId: string, currentSettings: unknown, update: PhotoFeaturesUpdate): Promise<PhotoFeatures> {
  const next = mergePhotoFeatures(photoFeaturesOf(currentSettings), update);
  await setCompanySetting(db, companyId, PHOTO_FEATURES_SETTING, next);
  return next;
}

/**
 * The owner of a personal / family account as seen from one of its phones: an active user of the account with the
 * built-in Admin role (or a whole-company role with settings:edit) whose own mobile number is the phone's number.
 */
export async function accountOwnerOfPhone(db: Pick<PrismaClient, 'user'>, companyId: string, uniqueId: string): Promise<string | null> {
  const owner = await db.user.findFirst({
    where: {
      companyId,
      isActive: true,
      mobile: `+${uniqueId}`,
      roles: {
        some: {
          role: {
            companyId,
            OR: [{ isSystem: true, name: ADMIN_ROLE }, { dataScope: 'COMPANY', permissions: { some: { menu: 'settings', actions: { has: 'edit' } } } }],
          },
        },
      },
    },
    select: { id: true },
  });
  return owner?.id ?? null;
}

/** The switches as the Tracker app reads them with /me (canEdit: this phone is the owner of a personal / family account). */
export async function trackerPhotoFeatures(db: Pick<PrismaClient, 'user'>, company: { id: string; settings: unknown; accountType: string }, uniqueId: string): Promise<PhotoFeatures & { canEdit: boolean }> {
  const owner = company.accountType === 'BUSINESS' ? null : await accountOwnerOfPhone(db, company.id, uniqueId);
  return { ...photoFeaturesOf(company.settings), canEdit: !trackerEditBlock(company.accountType, !!owner) };
}
