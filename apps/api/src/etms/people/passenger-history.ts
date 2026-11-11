import { PASSENGER_HISTORY_REDACTED, maskEmail, maskPhone, shortName, type AuditLogDto } from '@veetracer/shared';
import type { PassengerView } from './people-access';

/**
 * Passenger history (GET /api/transport/passengers/:id/history) built from the audit log, redacted per view level
 * (doc 10 §2 minimum data profile, §4 PD H minimisation):
 * - Home, health and emergency-contact values are never returned, only the marker "changed" (the writes already store
 *   a salted hash, profileSnapshot in people.service.ts; the hash is a fingerprint, so it is dropped here too).
 * - FULL (corporate admin): every field, contacts in clear, sensitive reads (ACCESS) included, actor and IP shown.
 * - STANDARD (dispatcher): no home-location fields at all (no addresses), no emergency contacts, no ACCESS rows, no IP.
 * - MINIMAL (provider under VIEW_PASSENGER_MINIMAL): only the fields of the MINIMAL projection (employee code, short
 *   name, office, status, default stop while routing consent is active), contacts per the agreement (none / masked /
 *   clear), only profile entries, no actor identity and no IP. A provider without the grant never reaches this (404).
 * Diffs (`{ field: { from, to } }`) are returned as `{ before, after }` so the web ChangesView renders a table.
 */

/** Profile columns whose values are PD H: shown only as "changed". */
export const SENSITIVE_KEYS = new Set(['homeAddress', 'homeLat', 'homeLng', 'accessibility', 'emergencyContacts']);
/** Home-location columns a dispatcher never sees (doc 02 §4.2: STANDARD hides the address). */
export const HOME_KEYS = new Set(['homeAddress', 'homeLat', 'homeLng', 'homeGeocodeSource', 'homeGeocodeConfidence']);
/** The fields a provider (MINIMAL) may follow; contacts and the default stop are added conditionally. */
const MINIMAL_KEYS = new Set(['employeeCode', 'displayName', 'officePoiId', 'isActive']);
const CONTACT_KEYS = new Set(['mobile', 'email']);

type Diff = Record<string, { from: unknown; to: unknown }>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An AuditService diff: every value is exactly `{ from, to }`. */
export function isDiff(v: unknown): v is Diff {
  if (!isRecord(v)) return false;
  const values = Object.values(v);
  return values.length > 0 && values.every((x) => isRecord(x) && Object.keys(x).length === 2 && 'from' in x && 'to' in x);
}

const marker = (v: unknown): unknown => (v === null || v === undefined ? null : PASSENGER_HISTORY_REDACTED);

export interface HistoryContext {
  view: PassengerView;
  /** Passenger's routing consent is active now (a provider then also follows the default stop). */
  routingConsent: boolean;
  /** Entity name of the profile rows (others: consent, User). */
  profileEntity: string;
}

/** Value of one field for the caller, or `undefined` to drop the field. */
function fieldValue(key: string, value: unknown, h: HistoryContext): unknown {
  const p = h.view.projection;
  if (p === 'MINIMAL') {
    if (CONTACT_KEYS.has(key)) {
      if (h.view.contact === 'NONE') return undefined;
      if (h.view.contact === 'MASKED' && typeof value === 'string') return key === 'mobile' ? maskPhone(value) : maskEmail(value);
      return value;
    }
    if (key === 'defaultStopPoiId') return h.routingConsent ? value : undefined;
    if (!MINIMAL_KEYS.has(key)) return undefined;
    if (key === 'displayName' && typeof value === 'string') return shortName(value);
    return value;
  }
  if (p === 'STANDARD' && (HOME_KEYS.has(key) || key === 'emergencyContacts')) return undefined;
  if (SENSITIVE_KEYS.has(key)) return marker(value);
  // Defensive: a salted-hash marker written by profileSnapshot under any other key.
  if (typeof value === 'string' && value.startsWith(`${PASSENGER_HISTORY_REDACTED}:`)) return PASSENGER_HISTORY_REDACTED;
  return value;
}

/** One audit entry as the caller may see it, or null when nothing of it is visible. */
export function redactHistoryEntry(entry: AuditLogDto, h: HistoryContext): AuditLogDto | null {
  const p = h.view.projection;
  if (entry.action === 'ACCESS' && p !== 'FULL') return null;
  if (p === 'MINIMAL' && entry.entity !== h.profileEntity) return null;
  const actor = p === 'MINIMAL' ? { userId: null, userName: null } : { userId: entry.userId, userName: entry.userName };
  const ip = p === 'FULL' ? entry.ip : null;

  let changes: unknown = null;
  if (isDiff(entry.changes)) {
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [k, { from, to }] of Object.entries(entry.changes)) {
      const f = fieldValue(k, from, h);
      const t = fieldValue(k, to, h);
      if (f === undefined && t === undefined) continue;
      before[k] = f ?? null;
      after[k] = t ?? null;
    }
    if (!Object.keys(after).length) return null;
    changes = { before, after };
  } else if (isRecord(entry.changes)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry.changes)) {
      const x = fieldValue(k, v, h);
      if (x !== undefined) out[k] = x;
    }
    if (p === 'MINIMAL' && !Object.keys(out).length) return null;
    changes = out;
  } else if (p === 'MINIMAL') {
    return null;
  }
  return { ...entry, ...actor, ip, changes };
}
