/**
 * Per-company feature switches for the two photo features of v1.18 (owner decision: default OFF for every company,
 * existing and new; the company decides).
 *
 *   personPhotos: person / pet / asset photos (avatars) of tracked objects: upload in the web object form / drawer and
 *                 the Tracker app's "Profile photo", photo markers and the hover photo on the maps.
 *   photoNotes:   location photo notes ("Add photo here", the Photos & notes page, the photo-note map layers).
 *
 * Kept in `Company.settings.photos` ({ personPhotos, photoNotes }), written with the atomic setCompanySetting().
 * Unlike the add-ons (COMPANY_FEATURES, Super Admin only), a company admin switches these themselves: Settings →
 * Features on the web, Settings → Features in the VeeTrax app, and the account owner of a personal / family account in
 * the Tracker app. Switching a feature off hides it and refuses changes (403 FEATURE_OFF); uploaded photos and notes
 * are kept and come back when it is switched on again.
 */

export const PHOTO_FEATURE_KEYS = ['personPhotos', 'photoNotes'] as const;
export type PhotoFeatureKey = (typeof PHOTO_FEATURE_KEYS)[number];

/**
 * Company switches that gate menus (MenuDef.requires.companySetting). Generic name: other self-service switches can
 * be added here and read in companySwitchesOf().
 */
export type CompanySwitch = PhotoFeatureKey;

export type PhotoFeatures = Record<PhotoFeatureKey, boolean>;

export const PHOTO_FEATURES_OFF: PhotoFeatures = { personPhotos: false, photoNotes: false };

/** Error code of a refused upload / change while the company's switch is off (HTTP 403). */
export const FEATURE_OFF = 'FEATURE_OFF';

/** The switches from `Company.settings` (absent / malformed = off). */
export function photoFeaturesOf(settings: unknown): PhotoFeatures {
  const s = typeof settings === 'object' && settings !== null && !Array.isArray(settings) ? (settings as Record<string, unknown>).photos : undefined;
  const p = typeof s === 'object' && s !== null && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
  return { personPhotos: p.personPhotos === true, photoNotes: p.photoNotes === true };
}

/** The company switches that are ON (for menu gating). */
export function companySwitchesOf(settings: unknown): CompanySwitch[] {
  const p = photoFeaturesOf(settings);
  return PHOTO_FEATURE_KEYS.filter((k) => p[k]);
}

/** Who may change the switches, and why not (the apps show the reason). */
export type PhotoFeaturesEditBlock = 'NOT_ADMIN' | 'BUSINESS_ACCOUNT' | 'NOT_OWNER';

/** GET / PUT /api/company/photo-features and /api/tracker/v1/photo-features. */
export interface PhotoFeaturesDto extends PhotoFeatures {
  canEdit: boolean;
  /** Set when canEdit is false. */
  blockedBy?: PhotoFeaturesEditBlock;
  accountType?: 'BUSINESS' | 'INDIVIDUAL' | 'FAMILY';
}

/** PUT body: only the switches sent are changed. */
export type PhotoFeaturesUpdate = Partial<PhotoFeatures>;

/** Default message of FEATURE_OFF per feature (the apps translate it). */
export const FEATURE_OFF_MESSAGES: Record<PhotoFeatureKey, string> = {
  personPhotos: 'Person photos are switched off for this account.',
  photoNotes: 'Photo notes are switched off for this account.',
};
