/**
 * Phones running the VeeTrax Tracker app (docs/mobile-tracker/API.md). The device's uniqueId is the mobile number in
 * E.164 digits without '+', e.g. 919876543210; the phone activates with that number by OTP.
 */

/** Device-model protocol of the seeded "VeeTrax · Mobile tracker (Android)" model. */
export const MOBILE_TRACKER_PROTOCOL = 'MOBILE';

/** "+91 98765 43210", "09876543210", "9876543210" → "919876543210"; null when it isn't a mobile number. */
export function normalizeMobile(input: string): string | null {
  const digits = (input ?? '').replace(/\D/g, '');
  if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`;
  if (/^0[6-9]\d{9}$/.test(digits)) return `91${digits.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(digits)) return digits;
  // Other countries: full E.164 with country code (11–15 digits; a bare 10-digit number is Indian or invalid).
  if (/^[1-9]\d{10,14}$/.test(digits) && !digits.startsWith('91')) return digits;
  return null;
}

/** "919876543210" → "+91 98765 43210" (display). */
export function formatMobile(uniqueId: string): string {
  return /^91\d{10}$/.test(uniqueId) ? `+91 ${uniqueId.slice(2, 7)} ${uniqueId.slice(7)}` : `+${uniqueId}`;
}

/** GET /devices/:id/mobile-tracker */
export interface MobileTrackerStatusDto {
  mobile: string;
  /** Pending activation code: read it out to the user when SMS isn't set up. */
  pendingCode: { code: string; expiresAt: string; smsSent: boolean; emailCount: number } | null;
  /** Extra address that gets the activation code by e-mail (device admins always get it). */
  activationEmail: string | null;
  /** Latest phones first; at most one is active. */
  sessions: { id: string; deviceName: string | null; appVersion: string | null; platform: string | null; createdAt: string; lastUsedAt: string | null; active: boolean }[];
}
