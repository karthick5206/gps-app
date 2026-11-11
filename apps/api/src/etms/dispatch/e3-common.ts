import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { type TransportE3ErrorCode } from '@veetracer/shared';
import { createHash } from 'crypto';
import { AuthContext } from '../../access/auth-context';
import { assertTransportAccess, transportNotFound, transportReadScope } from '../../access/transport-scope';

/**
 * ETMS E3 helpers shared by the shifts / schedules / bookings / dispatch / trips services: coded errors (05 §4),
 * idempotency hashing (05 §1), date-only handling and the row scopes. R1 is corporate-managed (D8): every E3 write is
 * on the caller's own company (customer = provider); rows seen through an agreement are read-only (403), other rows 404.
 */

export type Db = Prisma.TransactionClient;

export const e3Error = (status: HttpStatus, code: TransportE3ErrorCode, message: string, extra: Record<string, unknown> = {}) => new HttpException({ message, code, ...extra }, status);
export const invalid = (message: string) => new BadRequestException({ message, code: 'VALIDATION_FAILED' });
export const conflict = (code: TransportE3ErrorCode, message: string, extra: Record<string, unknown> = {}) => new ConflictException({ message, code, ...extra });
export const forbidden = (code: TransportE3ErrorCode, message: string) => new ForbiddenException({ message, code });
export const versionConflict = (currentVersion: number) => conflict('VERSION_CONFLICT', 'Changed by someone else meanwhile; reload and try again', { currentVersion });
export const notFound = transportNotFound;

/** Stable JSON (sorted keys) so the same body always hashes the same (idempotency, 05 §1). */
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')}}`;
}

export const requestHash = (body: unknown): string => createHash('sha256').update(stableJson(body)).digest('hex');

/** Idempotency-Key header: required, 8–100 chars of [A-Za-z0-9-_:.] (UUIDs recommended). */
export function idempotencyKey(raw: string | undefined): string {
  const key = (raw ?? '').trim();
  if (!key) throw new BadRequestException({ message: 'Send an Idempotency-Key header', code: 'IDEMPOTENCY_KEY_REQUIRED' });
  if (!/^[A-Za-z0-9_.:-]{8,100}$/.test(key)) throw invalid('Idempotency-Key must be 8–100 letters, digits or - _ : .');
  return key;
}

export const idempotencyReused = () => e3Error(HttpStatus.UNPROCESSABLE_ENTITY, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');

// ───────────────────────────── Dates ─────────────────────────────

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A valid calendar day 'YYYY-MM-DD'. */
export function isServiceDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function serviceDate(v: unknown, field = 'serviceDate'): string {
  if (!isServiceDate(v)) throw invalid(`${field} must be a date YYYY-MM-DD`);
  return v;
}

/** @db.Date value of a day key. */
export const dateOnly = (day: string): Date => new Date(`${day}T00:00:00.000Z`);
/** Day key of a @db.Date value. */
export const dayKeyOf = (d: Date): string => d.toISOString().slice(0, 10);

export function parseInstant(v: unknown, field: string): number {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms)) throw invalid(`${field} must be a date and time`);
  return ms;
}

/** Point check (finite, in range, not 0,0) — the same rule as passenger home points (doc 02 §7.2). */
export function validPoint(p: { lat?: unknown; lng?: unknown } | null | undefined): p is { lat: number; lng: number } {
  if (!p) return false;
  const { lat, lng } = p;
  return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0);
}

export const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

// ───────────────────────────── Scopes (R1, corporate-managed) ─────────────────────────────

type Ctx = Pick<AuthContext, 'companyId' | 'dataScope' | 'branchIds' | 'agreements'>;

/** Branch filter of an ASSIGNED customer user on rows that belong to a passenger (own branches + company-wide passengers). */
export function profileBranchWhere(ctx: Ctx): Prisma.EmployeeTransportProfileWhereInput | undefined {
  if (ctx.dataScope === 'COMPANY') return undefined;
  return { OR: [{ branchId: null }, { branchId: { in: ctx.branchIds } }] };
}

export function inProfileBranch(ctx: Ctx, branchId: string | null | undefined): boolean {
  return ctx.dataScope === 'COMPANY' || !branchId || ctx.branchIds.includes(branchId);
}

/** Bookings the caller may read: own (branch-scoped for ASSIGNED) + customers whose agreement grants VIEW_BOOKINGS. */
export function bookingReadWhere(ctx: Ctx): Prisma.TransportBookingWhereInput {
  const scope = transportReadScope(ctx, 'VIEW_BOOKINGS');
  const branch = profileBranchWhere(ctx);
  return {
    OR: scope.OR.map((part) => {
      const own = !('providerCompanyId' in part);
      return own && branch ? { customerCompanyId: ctx.companyId, profile: branch } : (part as Prisma.TransportBookingWhereInput);
    }),
  };
}

/**
 * Single booking: read → 404 unless visible; write (R1) → own company + branch, else 403 when the caller sees it through
 * an agreement, 404 otherwise.
 */
export function assertBookingAccess(ctx: Ctx, row: { customerCompanyId: string; providerCompanyId: string | null; profile?: { branchId: string | null } | null } | null, mode: 'read' | 'write'): void {
  if (!row) throw notFound();
  if (row.customerCompanyId === ctx.companyId) {
    if (!inProfileBranch(ctx, row.profile?.branchId)) throw notFound();
    return;
  }
  assertTransportAccess(ctx, row, 'VIEW_BOOKINGS');
  if (mode === 'write') throw forbidden('FORBIDDEN_GRANT', 'Bookings of another company are read-only');
}

/** Trips the caller may read: those it operates or that carry its company's passengers (R1: both = own company). */
export function tripReadWhere(ctx: Ctx, objectIds: string[] | null): Prisma.TransportTripWhereInput {
  const own: Prisma.TransportTripWhereInput = { OR: [{ providerCompanyId: ctx.companyId }, { customerCompanyId: ctx.companyId }] };
  if (objectIds === null) return own;
  return { AND: [own, { OR: [{ plannedTripId: null }, { plannedTrip: { objectId: { in: objectIds.length ? objectIds : ['00000000-0000-0000-0000-000000000000'] } } }] }] };
}

/** Single trip write (R1): operated by and for the caller's own company. */
export function assertTripWrite(ctx: Ctx, row: { providerCompanyId: string; customerCompanyId: string | null }): void {
  if (row.providerCompanyId !== ctx.companyId) throw notFound();
  if (row.customerCompanyId !== null && row.customerCompanyId !== ctx.companyId) throw forbidden('FORBIDDEN_GRANT', 'Trips for another company need an agreement (E1b)');
}

/** Prisma unique violation (P2002), optionally on a given constraint / column. */
export function isUniqueViolation(e: unknown, target?: string): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return false;
  if (!target) return true;
  return JSON.stringify(e.meta ?? {}).includes(target);
}

/** SQLSTATE of a raw database error surfaced by Prisma (CHECK 23514, EXCLUDE 23P01, FK 23503). */
export function sqlState(e: unknown): string | null {
  const msg = e instanceof Error ? e.message : '';
  const meta = (e as { meta?: { code?: string } } | null)?.meta;
  if (meta?.code && /^[0-9A-Z]{5}$/.test(meta.code)) return meta.code;
  if (/23P01|exclusion constraint/i.test(msg)) return '23P01';
  if (/23514|check constraint/i.test(msg)) return '23514';
  return null;
}

/** Constraint name mentioned in a database error, if any. */
export function constraintOf(e: unknown): string | null {
  const msg = `${e instanceof Error ? e.message : ''} ${JSON.stringify((e as { meta?: unknown } | null)?.meta ?? {})}`;
  return /"?([A-Za-z]+_[A-Za-z_]+_(?:check|excl|key))"?/.exec(msg)?.[1] ?? null;
}

/** Company ETMS settings used by E3 (Company.settings.etms). */
export function cutoffMinutes(settings: unknown, fallback: number): number {
  const v = (settings as { etms?: { bookingCutoffMin?: unknown } } | null)?.etms?.bookingCutoffMin;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 24 * 60 ? v : fallback;
}
