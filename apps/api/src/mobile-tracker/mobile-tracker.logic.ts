import { MOBILE_TRACKER_PROTOCOL, NormalizedPosition } from '@veetracer/shared';

export { formatMobile, normalizeMobile } from '@veetracer/shared';

/** Protocol of positions from the VeeTrax Tracker app (and of its seeded device model). */
export const MOBILE_PROTOCOL = 'mobile';
export const MOBILE_MODEL_PROTOCOL = MOBILE_TRACKER_PROTOCOL;

export const CODE_TTL_MS = 10 * 60_000;
export const CODE_RESEND_MS = 30_000;
export const CODE_MAX_ATTEMPTS = 5;
/** Codes (and so code e-mails) per device per 24 h. */
export const CODE_MAX_PER_DAY = 10;
export const MAX_POINTS_PER_CALL = 500;

/** "ramesh@acme.com" → "r****@acme.com": shown in the app so the user knows where to look, without revealing it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '****';
  return `${email[0]}****${email.slice(at)}`;
}

export interface CodeCandidate {
  email: string | null;
  scopes: string[];
  branchIds: string[];
  objectIds: string[];
}

/**
 * Who gets a tracker activation code by e-mail: the device admins (Devices → edit, checked by the query) whose data
 * scope covers the device's object, plus the device's own activation e-mail. An unassigned device only reaches
 * company-wide admins. Never an address typed in the app (that would let anyone take a tracker over).
 */
export function codeRecipients(
  admins: CodeCandidate[],
  object: { id: string; branchId: string | null } | null,
  activationEmail: string | null,
): string[] {
  const out = new Map<string, string>();
  const add = (e: string | null) => {
    const v = e?.trim();
    if (v && v.includes('@')) out.set(v.toLowerCase(), v);
  };
  for (const a of admins) {
    const sees =
      a.scopes.includes('COMPANY') || (!!object && ((!!object.branchId && a.branchIds.includes(object.branchId)) || a.objectIds.includes(object.id)));
    if (sees) add(a.email);
  }
  add(activationEmail);
  return [...out.values()];
}

/** Sent to the app on activation and with every upload (it applies changes). */
export interface TrackerConfig {
  intervalSec: number;
  stoppedIntervalSec: number;
  distanceM: number;
  /** Fixes with a larger accuracy radius are stored as invalid (not drawn as movement). */
  maxAccuracyM: number;
  batchMax: number;
}

// One fix every 5 s while moving (was 10 s; the phones met that, p90 11 s). distanceM 10 still drops fixes when crawling.
export const DEFAULT_TRACKER_CONFIG: TrackerConfig = { intervalSec: 5, stoppedIntervalSec: 60, distanceM: 10, maxAccuracyM: 100, batchMax: 100 };

export interface TrackerPoint {
  t: number;
  lat: number;
  lng: number;
  acc?: number | null;
  spd?: number | null;
  brg?: number | null;
  alt?: number | null;
  bat?: number | null;
  chg?: boolean | null;
  mock?: boolean | null;
  sos?: boolean | null;
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Validates one uploaded point; returns null when it is unusable (bad coordinates or time). */
export function parsePoint(raw: unknown, now: number): TrackerPoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const t = finite(r.t);
  const lat = finite(r.lat);
  const lng = finite(r.lng);
  if (t === null || lat === null || lng === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  // Older than 30 days or more than a day ahead: a broken phone clock (the processor flags smaller skews).
  if (t < now - 30 * 86_400_000 || t > now + 86_400_000) return null;
  return {
    t,
    lat,
    lng,
    acc: finite(r.acc),
    spd: finite(r.spd),
    brg: finite(r.brg),
    alt: finite(r.alt),
    bat: finite(r.bat),
    chg: typeof r.chg === 'boolean' ? r.chg : null,
    mock: r.mock === true,
    sos: r.sos === true,
  };
}

/** One app point → the pipeline's position. Inaccurate and mock fixes are kept but marked invalid. */
export function toNormalized(p: TrackerPoint, uniqueId: string, receivedAt: number, config: TrackerConfig): NormalizedPosition {
  const accurate = p.acc === null || p.acc === undefined || p.acc <= config.maxAccuracyM;
  const attributes: Record<string, unknown> = {};
  if (p.acc !== null && p.acc !== undefined) attributes.accuracyM = Math.round(p.acc * 10) / 10;
  if (p.bat !== null && p.bat !== undefined) attributes.batteryLevel = Math.max(0, Math.min(100, Math.round(p.bat)));
  if (p.chg !== null && p.chg !== undefined) attributes.charging = p.chg;
  if (p.mock) attributes.mock = true;
  if (p.sos) attributes.alarm = 'sos';
  return {
    protocol: MOBILE_PROTOCOL,
    uniqueId,
    fixTime: new Date(p.t).toISOString(),
    receivedAt: new Date(receivedAt).toISOString(),
    lat: p.lat,
    lng: p.lng,
    speedKph: p.spd !== null && p.spd !== undefined && p.spd >= 0 ? Math.round(p.spd * 3.6 * 10) / 10 : 0,
    course: p.brg !== null && p.brg !== undefined && p.brg >= 0 ? Math.round(p.brg) % 360 : 0,
    altitude: p.alt ?? null,
    satellites: null,
    valid: accurate && !p.mock,
    ignition: null,
    attributes,
  };
}
