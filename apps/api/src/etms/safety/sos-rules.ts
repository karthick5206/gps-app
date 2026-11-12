import { Prisma } from '@prisma/client';
import {
  INCIDENT_RESOLUTIONS,
  isValidIdempotencyKey,
  SOS_LIMITS,
  type IncidentResolution,
  type IncidentStatus,
  type SosFix,
  type SosNotifyState,
  type SosReceipt,
} from '@veetracer/shared';
import { randomUUID } from 'crypto';
import { AuthContext } from '../../access/auth-context';
import { hasTransportGrant } from '../../access/transport-scope';
import { requestHash, validPoint } from '../dispatch/e3-common';

/**
 * Pure rules of the durable SOS (WP 5.4; doc 05 §3.7, doc 10 §6). Kept free of I/O so they are unit-tested directly.
 */

/** Cleaned SOS request: a malformed optional field is DROPPED, never a reason to refuse an SOS. */
export interface CleanSos {
  key: string;
  /** The client sent no usable Idempotency-Key: a server key was made (replays then merge into the open SOS). */
  serverKey: boolean;
  tripId: string | null;
  /** A tripId was sent (valid or not): if it cannot be linked the receipt says tripLinked: false. */
  tripRequested: boolean;
  fix: SosFix | null;
  note: string | null;
  raisedAt: Date;
  hash: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accepts any body shape. Never throws: the only thing that matters is that the SOS is recorded. Bad pieces are dropped
 * (fix outside the globe, unparsable times, non-UUID trip id); the note is cut to SOS_LIMITS.noteMax; a raisedAt in the
 * future (device clock) or more than 48 h back is replaced by the server time.
 */
export function cleanSos(body: unknown, headerKey: string | undefined, now: number = Date.now()): CleanSos {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const rawKey = typeof headerKey === 'string' ? headerKey.trim() : '';
  const serverKey = !isValidIdempotencyKey(rawKey);
  const key = serverKey ? `srv-${randomUUID()}` : rawKey.toLowerCase();
  const tripRequested = b.tripId !== undefined && b.tripId !== null && b.tripId !== '';
  const tripId = typeof b.tripId === 'string' && UUID_RE.test(b.tripId) ? b.tripId.toLowerCase() : null;
  let fix: SosFix | null = null;
  const f = b.fix as Record<string, unknown> | undefined;
  if (f && typeof f === 'object' && validPoint(f as { lat?: unknown; lng?: unknown })) {
    const at = typeof f.at === 'string' ? Date.parse(f.at) : NaN;
    const acc = typeof f.accuracyM === 'number' && Number.isFinite(f.accuracyM) && f.accuracyM >= 0 && f.accuracyM < 100_000 ? f.accuracyM : undefined;
    fix = { lat: f.lat as number, lng: f.lng as number, ...(acc !== undefined ? { accuracyM: acc } : {}), at: new Date(Number.isFinite(at) && at <= now + 120_000 ? at : now).toISOString() };
  }
  const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, SOS_LIMITS.noteMax) : null;
  const tap = typeof b.raisedAt === 'string' ? Date.parse(b.raisedAt) : NaN;
  const raisedAt = new Date(Number.isFinite(tap) && tap <= now + 120_000 && tap >= now - 48 * 3_600_000 ? tap : now);
  // The hash covers what the client sent (not server defaults), so an exact replay always matches.
  const hash = requestHash({ tripId: b.tripId ?? null, fix: b.fix ?? null, note: b.note ?? null, raisedAt: b.raisedAt ?? null });
  return { key, serverKey, tripId, tripRequested, fix, note, raisedAt, hash };
}

/** Incident row fields the receipt / visibility rules read. */
export interface IncidentRef {
  id: string;
  status: string;
  raiserType: string;
  providerCompanyId: string | null;
  customerCompanyId: string | null;
  receivedAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  tripId: string | null;
}

export function toReceipt(row: IncidentRef, opts: { merged: boolean; tripLinked: boolean; notify: SosNotifyState; ackByName: string | null }): SosReceipt {
  return {
    incidentId: row.id,
    status: 'RECEIVED_BY_SERVER',
    receivedAt: row.receivedAt.toISOString(),
    incidentStatus: row.status as IncidentStatus,
    acknowledgement: row.acknowledgedAt ? { by: firstName(opts.ackByName) ?? 'Dispatcher', at: row.acknowledgedAt.toISOString() } : null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    merged: opts.merged,
    tripLinked: opts.tripLinked,
    notify: opts.notify,
  };
}

export function firstName(name: string | null | undefined): string | null {
  const n = (name ?? '').trim();
  return n ? n.split(/\s+/)[0]! : null;
}

/** "Priya R." from "Priya Raman" (agreement views: no full names of another company's people). */
export function shortName(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '—';
  return parts.length === 1 ? parts[0]! : `${parts[0]} ${parts[parts.length - 1]![0]}.`;
}

/** Outbox state → the honest notify state shown to the raiser. */
export function notifyState(outbox: { publishedAt: Date | null; deadAt: Date | null } | null | undefined): SosNotifyState {
  if (!outbox) return 'QUEUED';
  if (outbox.deadAt) return 'FAILED';
  return outbox.publishedAt ? 'SENT_TO_DISPATCH' : 'QUEUED';
}

// ───────────────────────────── Visibility (dispatcher side) ─────────────────────────────

type ScopeCtx = Pick<AuthContext, 'companyId' | 'agreements' | 'isSuperAdmin'> & Partial<Pick<AuthContext, 'homeCompanyId'>>;

/**
 * Who sees an incident (doc 05 §6 "Incident / SOS", doc 10 §2): the company of the raiser always (passenger →
 * customer side, driver → operator side), the Super Admin (platform support), and the other party of the trip only
 * through an in-force agreement granting RECEIVE_INCIDENTS (view) or MANAGE_INCIDENTS (view + act). Data scope: an
 * ASSIGNED (branch / site) dispatcher sees every SOS of the company — safety first; an SOS is never hidden by branch.
 */
export type IncidentAccess = 'none' | 'view' | 'manage';

export function incidentAccess(ctx: ScopeCtx, row: Pick<IncidentRef, 'raiserType' | 'providerCompanyId' | 'customerCompanyId'>, now: number = Date.now()): IncidentAccess {
  // The Super Admin on the platform sees and acts on every incident; switched into a company, it acts as that company.
  if (ctx.isSuperAdmin && (!ctx.homeCompanyId || ctx.companyId === ctx.homeCompanyId)) return 'manage';
  if (row.customerCompanyId && row.customerCompanyId === ctx.companyId) return 'manage';
  if (row.providerCompanyId && row.providerCompanyId === ctx.companyId) {
    if (row.raiserType === 'DRIVER' || !row.customerCompanyId) return 'manage';
    if (hasTransportGrant(ctx, row.customerCompanyId, 'MANAGE_INCIDENTS', undefined, now)) return 'manage';
    if (hasTransportGrant(ctx, row.customerCompanyId, 'RECEIVE_INCIDENTS', undefined, now)) return 'view';
  }
  return 'none';
}

/** List where-clause matching incidentAccess != 'none' (the service re-checks each row in code). */
export function incidentListWhere(ctx: ScopeCtx & Pick<AuthContext, 'allCompanies' | 'homeCompanyId'>, now: number = Date.now()): Prisma.TransportIncidentWhereInput {
  // Super Admin on the platform (not switched into a company): every incident (support). Switched: that company's view.
  if (ctx.isSuperAdmin && (ctx.allCompanies || ctx.companyId === ctx.homeCompanyId)) return {};
  const granted = (ctx.agreements ?? [])
    .filter((a) => a.customerCompanyId !== ctx.companyId && a.validFrom <= now && (a.validTo === null || a.validTo > now))
    .filter((a) => a.grants.includes('RECEIVE_INCIDENTS') || a.grants.includes('MANAGE_INCIDENTS'))
    .map((a) => a.customerCompanyId);
  const or: Prisma.TransportIncidentWhereInput[] = [
    { customerCompanyId: ctx.companyId },
    { providerCompanyId: ctx.companyId, raiserType: 'DRIVER' },
    { providerCompanyId: ctx.companyId, customerCompanyId: null },
  ];
  if (granted.length) or.push({ providerCompanyId: ctx.companyId, customerCompanyId: { in: granted } });
  return { OR: or };
}

// ───────────────────────────── Ack / resolve input ─────────────────────────────

export function cleanNote(raw: unknown, max: number): string | null {
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, max) : null;
}

export function isResolution(v: unknown): v is IncidentResolution {
  return typeof v === 'string' && (INCIDENT_RESOLUTIONS as readonly string[]).includes(v);
}

/** Relay back-off for a SAFETY row that could not be delivered at all: 1 s, 2 s, 4 s … capped at 15 s. Never DEAD. */
export function safetyBackoffMs(attempts: number): number {
  return Math.min(15_000, 1_000 * 2 ** Math.max(0, Math.min(attempts - 1, 4)));
}

/** Fix older than SOS_LIMITS.fixStaleAfterMs at receipt time. */
export function fixStale(fixAt: Date | null, receivedAt: Date): boolean {
  return !!fixAt && receivedAt.getTime() - fixAt.getTime() > SOS_LIMITS.fixStaleAfterMs;
}
