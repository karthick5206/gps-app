import { MOBILE_TRACKER_PROTOCOL, NormalizedPosition } from '@veetracer/shared';
import { formatDuration } from '../alerts/logic/time-window';

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

// As many fixes as is sensible, the server filters: every 3 s while moving (phones met 10 s and 5 s exactly), no
// minimum distance (so crawling in traffic is recorded), every 30 s when parked (battery-saver location).
export const DEFAULT_TRACKER_CONFIG: TrackerConfig = { intervalSec: 3, stoppedIntervalSec: 30, distanceM: 0, maxAccuracyM: 100, batchMax: 200 };

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
  /** App 1.3.2+: the phone's own verdict when it doubts the fix (it sends it anyway; the server decides). */
  flt?: TrackerFilterVerdict | null;
  /** Location provider (fused / gps / network), speed accuracy (m/s), satellites used, app GPS mode. */
  prov?: string | null;
  sacc?: number | null;
  sat?: number | null;
  mode?: 'moving' | 'stationary' | null;
}

export const TRACKER_FILTER_VERDICTS = ['inaccurate', 'jump', 'mock', 'still'] as const;
export type TrackerFilterVerdict = (typeof TRACKER_FILTER_VERDICTS)[number];

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const oneOf = <T extends string>(v: unknown, values: readonly T[]): T | null => (typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : null);

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
    flt: oneOf(r.flt, TRACKER_FILTER_VERDICTS),
    prov: typeof r.prov === 'string' && /^[a-z_]{1,16}$/.test(r.prov) ? r.prov : null,
    sacc: finite(r.sacc),
    sat: finite(r.sat) !== null && (r.sat as number) >= 0 && (r.sat as number) < 100 ? Math.round(r.sat as number) : null,
    mode: oneOf(r.mode, ['moving', 'stationary'] as const),
  };
}

/** A rough fix (Android's Wi-Fi / cell fallback) is coarser than this. */
const SPIKE_COARSE_M = 50;
/** A sharp GPS fix is at least this good. */
const SPIKE_SHARP_M = 25;
/** The sharp fix that disproves a rough one must follow within this time… */
const SPIKE_LOOKAHEAD_MS = 120_000;
/** …and be this fast away from it (nobody carrying a phone moves faster), */
const SPIKE_IMPOSSIBLE_KPH = 200;
/** …and further than this (and 3 × the rough fix's own error radius). */
const SPIKE_MIN_M = 300;
/** Two sharp fixes this close agree with each other. */
const SPIKE_AGREE_M = 200;

const distM = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
};
const sharp = (p: TrackerPoint) => p.acc !== null && p.acc !== undefined && p.acc <= SPIKE_SHARP_M && !p.mock && p.flt !== 'inaccurate' && p.flt !== 'mock';

/**
 * Rough-fix spikes in one upload (points sorted by time): a Wi-Fi / cell fix (accuracy over 50 m) that a sharp GPS fix
 * arriving soon after shows to be far away at an impossible speed — seen: a 77 m "accurate" fix 2.5 km off, then GPS
 * back 4 s later. Only the rough fix is dropped. A real move after a pause is kept: its rough fix lies near the sharp
 * ones that follow, and a long pause makes the distance plausible. The sharp fix must be confirmed by the one after it
 * when there is one, so a single odd GPS fix never removes anything.
 */
export function roughSpikes(points: TrackerPoint[]): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.acc === null || p.acc === undefined || p.acc <= SPIKE_COARSE_M) continue;
    let j = i + 1;
    while (j < points.length && points[j].t - p.t <= SPIKE_LOOKAHEAD_MS && !sharp(points[j])) j++;
    if (j >= points.length || points[j].t - p.t > SPIKE_LOOKAHEAD_MS) continue;
    const q = points[j];
    const after = points.slice(j + 1).find(sharp);
    if (after && distM(q, after) > SPIKE_AGREE_M + ((after.t - q.t) / 1000) * (SPIKE_IMPOSSIBLE_KPH / 3.6)) continue;
    const d = distM(p, q);
    const kph = (d / Math.max((q.t - p.t) / 1000, 1)) * 3.6;
    if (d > Math.max(SPIKE_MIN_M, p.acc * 3) && kph > SPIKE_IMPOSSIBLE_KPH) out.add(i);
  }
  return out;
}

/** One app point → the pipeline's position. Inaccurate and mock fixes are kept but marked invalid. */
export function toNormalized(p: TrackerPoint, uniqueId: string, receivedAt: number, config: TrackerConfig, spike = false): NormalizedPosition {
  const accurate = p.acc === null || p.acc === undefined || p.acc <= config.maxAccuracyM;
  const attributes: Record<string, unknown> = {};
  if (p.acc !== null && p.acc !== undefined) attributes.accuracyM = Math.round(p.acc * 10) / 10;
  if (p.bat !== null && p.bat !== undefined) attributes.batteryLevel = Math.max(0, Math.min(100, Math.round(p.bat)));
  if (p.chg !== null && p.chg !== undefined) attributes.charging = p.chg;
  if (p.mock) attributes.mock = true;
  if (p.sos) attributes.alarm = 'sos';
  if (p.flt) attributes.phoneFilter = p.flt;
  if (spike) attributes.serverFilter = 'spike';
  if (p.prov) attributes.provider = p.prov;
  if (p.sacc !== null && p.sacc !== undefined) attributes.speedAccuracy = Math.round(p.sacc * 10) / 10;
  if (p.mode) attributes.appMode = p.mode;
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
    satellites: p.sat ?? null,
    // Too vague or fake: stored, but never used for the map, trips or alerts. Jumps and parked drift are judged by
    // the processor's own filter (the phone's verdict is kept in attributes for analysis).
    valid: accurate && !spike && !p.mock && p.flt !== 'inaccurate' && p.flt !== 'mock',
    ignition: null,
    attributes,
    // Every app point as received, kept in RawPacket (7 days) for analysis.
    raw: JSON.stringify(p),
  };
}

/** Whether a new activation is on a different phone than the number's latest one (never true for the first activation). */
export function isDifferentPhone(previous: { installIdHash: string | null; deviceName: string | null } | null, next: { installIdHash: string | null; deviceName: string | null }): boolean {
  if (!previous) return false;
  if (previous.installIdHash && next.installIdHash) return previous.installIdHash !== next.installIdHash;
  // Sessions from before install ids: the phone's name is the best evidence there is.
  return !!previous.deviceName && !!next.deviceName && previous.deviceName !== next.deviceName;
}

/** NEW_PHONE: the number was set up on a different handset (its Android device id differs). */
export type PhoneReturn = 'REINSTALLED' | 'SIGNED_OUT' | 'STOPPED' | 'NEW_PHONE';

/** Shorter silences are ordinary gaps, not worth mentioning in the alert. */
const AWAY_WORTH_MENTIONING_MS = 10 * 60_000;

/**
 * A new activation on the number's latest phone: how it came back and how long it was away. Null for a first activation,
 * another phone (TRACKER_DEVICE_CHANGED covers that) or when there is no evidence it is the same phone.
 * A session still open means the phone lost its token: the app was removed or its data cleared.
 */
export function phoneReturn(
  previous: { installIdHash: string | null; deviceName: string | null; revokedAt: Date | null; lastUsedAt: Date | null } | null,
  next: { installIdHash: string | null; deviceName: string | null },
  signedOut: boolean,
  now: number,
): { how: PhoneReturn; awayMs: number | null } | null {
  if (!previous) return null;
  const since = previous.revokedAt ?? previous.lastUsedAt;
  // Both sides have the phone's device id and it differs: the tracker moved to another handset.
  if (previous.installIdHash && next.installIdHash && previous.installIdHash !== next.installIdHash) return { how: 'NEW_PHONE', awayMs: since ? Math.max(0, now - since.getTime()) : null };
  const same = previous.installIdHash && next.installIdHash ? previous.installIdHash === next.installIdHash : !!previous.deviceName && previous.deviceName === next.deviceName;
  if (!same) return null;
  const how = !previous.revokedAt ? 'REINSTALLED' : signedOut ? 'SIGNED_OUT' : 'STOPPED';
  return { how, awayMs: since ? Math.max(0, now - since.getTime()) : null };
}

/** The alert text for phoneReturn, for example "Tracker app reinstalled on +91 90000 00000 (Pixel 8): ...". */
export function phoneReturnMessage(mobile: string, phone: string | null, how: PhoneReturn, awayMs: number | null, previousPhone: string | null = null): string {
  const where = `${mobile}${phone ? ` (${phone})` : ''}`;
  if (how === 'NEW_PHONE') {
    const from = previousPhone ?? 'the previous phone';
    const to = phone ?? 'another phone';
    return `Tracker for ${mobile} moved to a different phone: ${from === to ? `another ${to}` : `${from} → ${to}`}. The old phone stops tracking.`;
  }
  const away = awayMs !== null && awayMs >= AWAY_WORTH_MENTIONING_MS ? formatDuration(Math.round(awayMs / 1000)) : null;
  if (how === 'REINSTALLED') return `Tracker app reinstalled on ${where}: it was removed or its data was cleared, then set up again on the same phone.${away ? ` No contact for ${away} before this.` : ''}`;
  const after = how === 'SIGNED_OUT' ? 'it was signed out' : 'an administrator stopped it';
  return `Tracker app activated again on ${where}${away ? `, ${away} after ${after}` : ` after ${after}`}.`;
}

/** Why parsePoint refused a point (kept with the rejected point and shown in the phone's Tracking history). */
export function rejectReason(raw: unknown, now: number): string {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const t = finite(r.t);
  if (t === null) return 'no time';
  if (t < now - 30 * 86_400_000) return 'older than 30 days';
  if (t > now + 86_400_000) return 'phone clock ahead';
  return 'bad coordinates';
}

/** "2 older than 30 days, 1 bad coordinates" */
export function summarizeRejected(reasons: string[]): string {
  const counts = new Map<string, number>();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts].map(([r, n]) => `${n} ${r}`).join(', ');
}

const KILLED_BY_PHONE = 'killed while tracking';

/** A stop the person at the phone chose. Not the phone killing the app (offline alerts cover it) or a server decision. A sign-out is raised by the server. */
const isPersonStop = (why: string) => why !== KILLED_BY_PHONE && why !== 'signed out' && !why.startsWith('server') && !why.startsWith('moved to');

/**
 * Which new start / stop events mean tracking was really switched off or on. A restart after the phone killed the app is
 * not "switched on", and neither is a start while the last thing we know is that tracking was already running.
 * `before` is the device's latest start / stop older than `events`; `events` is sorted by time.
 */
export function trackerOnOffChanges<E extends { kind: string; why: string }>(before: { kind: string; why: string } | null, events: E[]): E[] {
  const out: E[] = [];
  let last = before;
  for (const e of events) {
    if (e.kind === 'stop') {
      if (isPersonStop(e.why)) out.push(e);
    } else if (e.kind === 'start') {
      if (last ? last.kind === 'stop' && last.why !== KILLED_BY_PHONE : e.why === 'app') out.push(e);
    } else continue;
    last = e;
  }
  return out;
}
