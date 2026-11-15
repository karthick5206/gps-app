import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  isYmd,
  parseMajorToMinor,
  type PriceLine,
  type PriceLineDto,
  type PriceResult,
  type PriceResultDto,
  type PricingErrorCode,
  type PricingPage,
  type TaxLine,
  type TaxLineDto,
} from '@veetracer/shared';
import type { AuthContext } from '../access/auth-context';
import { hasPermission } from '../access/access-rules';

/**
 * Doc 19 shared helpers of the /api/pricing services: coded errors (§4), wire conversion of bigint money (integer
 * strings), date-only handling, DB trigger / constraint error mapping and the data scope (§9.3 "Branch scope").
 */

export type Db = Prisma.TransactionClient;

export const pricingError = (status: HttpStatus, code: PricingErrorCode, message: string, extra: Record<string, unknown> = {}) => new HttpException({ message, code, ...extra }, status);
export const invalid = (message: string) => new BadRequestException({ message, code: 'VALIDATION_FAILED' satisfies PricingErrorCode });
export const conflict = (code: PricingErrorCode, message: string, extra: Record<string, unknown> = {}) => new ConflictException({ message, code, ...extra });
export const forbidden = (code: PricingErrorCode, message: string) => new ForbiddenException({ message, code });
/** Other tenant's id, a row outside the caller's branches, or no row: always the same 404. */
export const notFound = () => new NotFoundException({ message: 'Not found', code: 'NOT_FOUND' satisfies PricingErrorCode });
export const versionConflict = (currentVersion: number) => conflict('VERSION_CONFLICT', 'Changed by someone else meanwhile; reload and try again', { currentVersion });

// ───────────── Dates ─────────────

export function ymdOf(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}
export const ymd = (d: Date): string => d.toISOString().slice(0, 10);
export const isoOf = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** 'YYYY-MM-DD' → a UTC midnight Date for @db.Date columns (400 when not a real calendar day). */
export function dateOnly(v: unknown, field: string): Date {
  if (!isYmd(v)) throw invalid(`${field} must be a date YYYY-MM-DD`);
  return new Date(`${v}T00:00:00.000Z`);
}
export function optionalDate(v: unknown, field: string): Date | null {
  return v === undefined || v === null || v === '' ? null : dateOnly(v, field);
}

/** Local calendar day of an instant in an IANA time zone. */
export function localYmd(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
/** Local minute of day (0–1439) of an instant. */
export function localMinuteOfDay(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return (h % 24) * 60 + m;
}

// ───────────── Money on the wire ─────────────

export const str = (v: bigint | number | null | undefined): string => (v === null || v === undefined ? '0' : v.toString());

export function lineDto(l: PriceLine): PriceLineDto {
  return { ...l, amountMinor: l.amountMinor.toString(), discountMinor: l.discountMinor.toString(), taxMinor: l.taxMinor.toString() };
}
export function taxLineDto(t: TaxLine): TaxLineDto {
  const out: TaxLineDto = { taxCode: t.taxCode, label: t.label, ratePpm: t.ratePpm, taxableMinor: t.taxableMinor.toString(), taxMinor: t.taxMinor.toString() };
  for (const k of ['cgstMinor', 'sgstMinor', 'utgstMinor', 'igstMinor'] as const) if (t[k] !== undefined) out[k] = t[k]!.toString();
  return out;
}
export function resultDto(r: PriceResult): PriceResultDto {
  return {
    status: r.status,
    currency: r.currency,
    lines: r.lines.map(lineDto),
    subtotalMinor: r.subtotalMinor.toString(),
    discountMinor: r.discountMinor.toString(),
    taxLines: r.taxLines.map(taxLineDto),
    taxMinor: r.taxMinor.toString(),
    totalMinor: r.totalMinor.toString(),
    issues: r.issues,
    engineVersion: r.engineVersion,
  };
}

/** Stored JSON lines / tax lines are already wire-shaped (strings); typed reads for DTOs. */
export const jsonLines = (v: Prisma.JsonValue): PriceLineDto[] => (Array.isArray(v) ? (v as unknown as PriceLineDto[]) : []);
export const jsonTaxLines = (v: Prisma.JsonValue): TaxLineDto[] => (Array.isArray(v) ? (v as unknown as TaxLineDto[]) : []);
export const asJson = (v: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))) as Prisma.InputJsonValue;

/** Decimal MAJOR amount typed by a person → minor units (exact; 400 on junk / too many decimals). */
export function majorToMinor(v: unknown, currency: string, field: string, opts: { positive?: boolean; allowZero?: boolean } = {}): bigint {
  if (typeof v !== 'string' || !v.trim()) throw invalid(`${field} must be a decimal string`);
  let out: bigint;
  try {
    out = parseMajorToMinor(v.trim(), currency);
  } catch (e) {
    throw invalid(`${field}: ${(e as Error).message}`);
  }
  if (opts.positive && (out < 0n || (out === 0n && !opts.allowZero))) throw invalid(`${field} must be greater than zero`);
  return out;
}

// ───────────── DB errors (triggers, constraints) ─────────────

const TRIGGER_CODES: PricingErrorCode[] = ['INVOICE_ISSUED_IMMUTABLE', 'CONTRACT_VERSION_IMMUTABLE'];

/** Map trigger / constraint violations to coded 409s; rethrow anything else. */
export function mapDbError(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  for (const code of TRIGGER_CODES) if (msg.includes(`${code}:`)) throw conflict(code, msg.slice(msg.indexOf(`${code}:`) + code.length + 1).split('\n')[0].trim());
  if (/TRIP_PRICE_IMMUTABLE|PERIOD_CLOSED_IMMUTABLE|CREDIT_NOTE_IMMUTABLE|PAYMENT_LEDGER_IMMUTABLE/.test(msg)) throw conflict('INVOICE_ISSUED_IMMUTABLE', 'This financial record is immutable');
  if (/no_overlap_excl|exclusion constraint|23P01/.test(msg)) throw conflict('CONTRACT_OVERLAP', 'The validity overlaps another approved version / rate of the same contract');
  if (/CustomerInvoiceLine_source_key/.test(msg)) throw conflict('ALREADY_INVOICED', 'Already on another invoice');
  if (/TripPriceSnapshot_current_key/.test(msg)) throw conflict('VERSION_CONFLICT', 'The trip was priced concurrently; reload');
  if (/PricingContract_one_default_key/.test(msg)) throw conflict('VALIDATION_FAILED', 'The company already has a default contract');
  throw e;
}

export async function guardDb<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    mapDbError(e);
  }
}

// ───────────── Scope ─────────────

export const isCompanyScope = (ctx: AuthContext) => ctx.dataScope === 'COMPANY';

/** Rows carrying a branchId (snapshots, periods, invoices, costs): ASSIGNED callers see their branches only. */
export function branchWhere(ctx: AuthContext): { branchId?: { in: string[] } } {
  return isCompanyScope(ctx) ? {} : { branchId: { in: ctx.branchIds } };
}
export function branchVisible(ctx: AuthContext, branchId: string | null): boolean {
  return isCompanyScope(ctx) || (!!branchId && ctx.branchIds.includes(branchId));
}
/** A contract is visible to an ASSIGNED caller when it covers every branch or one of theirs. */
export function contractVisible(ctx: AuthContext, c: { branchIds: string[] }): boolean {
  return isCompanyScope(ctx) || c.branchIds.length === 0 || c.branchIds.some((b) => ctx.branchIds.includes(b));
}
/** ASSIGNED callers may change only contracts limited to their own branches (all-branch contracts need COMPANY scope). */
export function assertContractWritable(ctx: AuthContext, c: { branchIds: string[] }): void {
  if (isCompanyScope(ctx)) return;
  if (!c.branchIds.length || c.branchIds.some((b) => !ctx.branchIds.includes(b))) throw forbidden('BRANCH_SCOPE', 'This contract covers branches outside yours; a company-wide user must change it');
}
export const canSeeCosts = (ctx: AuthContext) => hasPermission(ctx, 'pricing_costs', 'view');

// ───────────── Paging ─────────────

export function paging(q: { page?: number | string; pageSize?: number | string }, max = 200): { page: number; pageSize: number; skip: number } {
  const page = Math.max(1, Math.floor(Number(q.page ?? 1)) || 1);
  const pageSize = Math.min(max, Math.max(1, Math.floor(Number(q.pageSize ?? 50)) || 50));
  return { page, pageSize, skip: (page - 1) * pageSize };
}
export const pageOf = <T>(items: T[], total: number, p: { page: number; pageSize: number }): PricingPage<T> => ({ items, total, page: p.page, pageSize: p.pageSize });

export const reasonOf = (v: unknown, field = 'reason'): string => {
  const r = typeof v === 'string' ? v.trim() : '';
  if (r.length < 3) throw invalid(`${field} is required (at least 3 characters)`);
  if (r.length > 500) throw invalid(`${field} is too long (500 characters max)`);
  return r;
};

/** Internal (job) caller: audited as SYSTEM (userId null) in the company. */
export function systemCtx(companyId: string): AuthContext {
  return { userId: null as unknown as string, homeCompanyId: companyId, companyId, isSuperAdmin: false, permissions: {}, dataScope: 'COMPANY', branchIds: [], objectIds: [], ip: null, features: ['pricing'] };
}
