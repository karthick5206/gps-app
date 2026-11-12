import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TRANSPORT_GRANTS, TRANSPORT_WRITE_GRANTS, type TransportDataProfile, type TransportGrant } from '@veetracer/shared';
import { AuthContext, TransportAgreementScope } from './auth-context';

/**
 * ETMS tenancy helpers (D1, docs/employee-transport/02 §4.2, 10 §2.2). The ONLY place that decides for which customer
 * companies the caller may act and with which grants, and that builds the where-clauses of dual-keyed ETMS rows
 * (customerCompanyId + providerCompanyId [+ siteId]). Provider users never switch company: ctx.companyId stays theirs
 * and the agreements loaded into ctx.agreements (AuthContextService) widen only ETMS reads / writes, never the existing
 * GPS scopes (objectScopeWhere & co. ignore them).
 */

export type TransportCtx = Pick<AuthContext, 'companyId' | 'agreements' | 'transportCustomerId'>;

/**
 * A company id no row ever has. Every OR list these helpers build gets `{ …CompanyId: NO_COMPANY }` when it would
 * otherwise be empty: Prisma treats a top-level `OR: []` as "match nothing" but an `OR: []` nested inside `AND` as "match
 * everything" (verified on Prisma 6.19), and the services nest these scopes in AND. Before E1b the lists always held the
 * own-company clause; the customer context (narrowed to another company, without the grant) can leave them empty.
 */
export const NO_COMPANY = '00000000-0000-0000-0000-000000000000';

/**
 * E1b customer context: false when the request is narrowed (X-Transport-Customer) to ANOTHER customer company, so the
 * caller's own-company rows are left out. Unset or the own company = own rows included.
 */
export function includesOwnCompany(ctx: Pick<AuthContext, 'companyId' | 'transportCustomerId'>): boolean {
  return !ctx.transportCustomerId || ctx.transportCustomerId === ctx.companyId;
}

/** One customer company the caller may act for. */
export interface ActingCustomer {
  customerCompanyId: string;
  /** SELF = corporate-managed (own company, every grant); AGREEMENT = provider acting under an agreement. */
  mode: 'SELF' | 'AGREEMENT';
  agreementId: string | null;
  grants: TransportGrant[];
  /** null = every site (own company); else the agreement's site ids ([] in an agreement also means every site). */
  siteIds: string[] | null;
  /** FULL = the customer's own view; otherwise the agreement's data profile. */
  dataProfile: TransportDataProfile | 'FULL';
}

/** Agreement still valid at `now` (ctx.agreements is filtered at load time; long-lived contexts re-check here). */
export function agreementScopeInForce(a: TransportAgreementScope, now: number = Date.now()): boolean {
  return a.validFrom <= now && (a.validTo === null || a.validTo > now);
}

function liveAgreements(ctx: TransportCtx, now: number): TransportAgreementScope[] {
  return (ctx.agreements ?? []).filter((a) => a.customerCompanyId !== ctx.companyId && agreementScopeInForce(a, now));
}

/** Customer companies the caller may act for (own company first), optionally only those granting `grant`. */
export function actingCustomers(ctx: TransportCtx, grant?: TransportGrant, now: number = Date.now()): ActingCustomer[] {
  const self: ActingCustomer = {
    customerCompanyId: ctx.companyId,
    mode: 'SELF',
    agreementId: null,
    grants: [...TRANSPORT_GRANTS],
    siteIds: null,
    dataProfile: 'FULL',
  };
  const viaAgreements = liveAgreements(ctx, now)
    .filter((a) => !grant || a.grants.includes(grant))
    .map<ActingCustomer>((a) => ({
      customerCompanyId: a.customerCompanyId,
      mode: 'AGREEMENT',
      agreementId: a.id,
      grants: [...a.grants],
      siteIds: [...a.siteIds],
      dataProfile: a.dataProfile,
    }));
  return includesOwnCompany(ctx) ? [self, ...viaAgreements] : viaAgreements;
}

/** Grants the caller holds for a customer company: all for its own company, the agreement's for a customer, else none. */
export function customerGrants(ctx: TransportCtx, customerCompanyId: string, now: number = Date.now()): TransportGrant[] {
  return actingCustomers(ctx, undefined, now).find((c) => c.customerCompanyId === customerCompanyId)?.grants ?? [];
}

/** Whether the caller may use `grant` for a customer (and site, when the row has one). */
export function hasTransportGrant(ctx: TransportCtx, customerCompanyId: string, grant: TransportGrant, siteId?: string | null, now: number = Date.now()): boolean {
  const c = actingCustomers(ctx, grant, now).find((x) => x.customerCompanyId === customerCompanyId);
  if (!c) return false;
  return siteAllowed(c.siteIds, siteId);
}

/** Passenger data projection for a customer: FULL own company, the agreement's profile, or null (no access). */
export function transportDataProfile(ctx: TransportCtx, customerCompanyId: string, now: number = Date.now()): TransportDataProfile | 'FULL' | null {
  return actingCustomers(ctx, undefined, now).find((c) => c.customerCompanyId === customerCompanyId)?.dataProfile ?? null;
}

function siteAllowed(siteIds: string[] | null, siteId: string | null | undefined): boolean {
  if (siteIds === null || siteIds.length === 0) return true;
  return !!siteId && siteIds.includes(siteId);
}

/** Where-clause shape of a dual-keyed ETMS row (TransportBooking, TransportTrip, … from E2 / E3). */
export interface DualKeyedWhere {
  OR: ({ customerCompanyId: string } | { providerCompanyId: string; customerCompanyId: string; siteId?: { in: string[] } })[];
}

function scopeWhere(ctx: TransportCtx, grant: TransportGrant, siteColumn: boolean, now: number): DualKeyedWhere {
  const or: DualKeyedWhere['OR'] = includesOwnCompany(ctx) ? [{ customerCompanyId: ctx.companyId }] : [];
  for (const a of liveAgreements(ctx, now)) {
    if (!a.grants.includes(grant)) continue;
    or.push({
      providerCompanyId: ctx.companyId,
      customerCompanyId: a.customerCompanyId,
      ...(siteColumn && a.siteIds.length ? { siteId: { in: [...a.siteIds] } } : {}),
    });
  }
  if (!or.length) or.push({ customerCompanyId: NO_COMPANY });
  return { OR: or };
}

/**
 * Rows the caller may read with `grant`: its own customer rows, plus rows it operates for customers whose in-force
 * agreement grants `grant` (limited to the agreement's sites when the table has a `siteId` column).
 * Branch / site scoping of ASSIGNED customer users is added per table by the E2 / E3 services.
 */
export function transportReadScope(ctx: TransportCtx, grant: TransportGrant, opts: { siteColumn?: boolean; now?: number } = {}): DualKeyedWhere {
  return scopeWhere(ctx, grant, opts.siteColumn ?? false, opts.now ?? Date.now());
}

/** Like transportReadScope, but only for write grants (MANAGE_*, OVERRIDE_SAFETY_WARN). */
export function transportWriteScope(ctx: TransportCtx, grant: TransportGrant, opts: { siteColumn?: boolean; now?: number } = {}): DualKeyedWhere {
  if (!TRANSPORT_WRITE_GRANTS.includes(grant)) throw new Error(`${grant} is not a write grant`);
  return scopeWhere(ctx, grant, opts.siteColumn ?? false, opts.now ?? Date.now());
}

/** A dual-keyed row as the helpers see it. */
export interface TransportRowRef {
  customerCompanyId: string | null;
  providerCompanyId: string | null;
  siteId?: string | null;
}

/**
 * Single-row check: 404 NOT_FOUND when the row is not visible to the caller at all (no enumeration of other tenants'
 * ids), 403 FORBIDDEN_GRANT when it is visible but the agreement lacks `grant`.
 */
export function assertTransportAccess(ctx: TransportCtx, row: TransportRowRef | null | undefined, grant: TransportGrant, now: number = Date.now()): void {
  if (!row) throw transportNotFound();
  if (row.customerCompanyId === ctx.companyId) {
    if (!includesOwnCompany(ctx)) throw transportNotFound();
    return;
  }
  if (row.providerCompanyId !== ctx.companyId || !row.customerCompanyId) throw transportNotFound();
  const agreement = liveAgreements(ctx, now).find((a) => a.customerCompanyId === row.customerCompanyId);
  if (!agreement || !siteAllowed(agreement.siteIds, row.siteId)) throw transportNotFound();
  if (!agreement.grants.includes(grant)) throw new ForbiddenException({ message: 'Your agreement with this customer does not allow this', code: 'FORBIDDEN_GRANT' });
}

/** The parts of an agreement row the site scope looks at. */
export interface AgreementSiteRef {
  providerCompanyId: string;
  customerCompanyId: string;
  siteIds: readonly string[];
}

/**
 * Customer sites whose names the caller may see for one agreement (doc 10 §2.2 item 4, minimum data): the parties
 * (and the Super Admin on the platform, PLAT) see exactly the sites the agreement names, never other customer places;
 * an agreement without sites means "all sites" and yields no list (`siteIds: []`, `allSites: true`), so a provider never
 * gets an enumeration of the customer's places. null = not a party → the caller answers 404.
 * Unlike actingCustomers this does not require the agreement to be in force: a provider reviews the sites of a
 * DRAFT / PROPOSED agreement before approving it.
 */
export function agreementSiteScope(
  ctx: Pick<AuthContext, 'companyId' | 'homeCompanyId' | 'isSuperAdmin'>,
  a: AgreementSiteRef,
): { customerCompanyId: string; siteIds: string[]; allSites: boolean } | null {
  const party = a.customerCompanyId === ctx.companyId || a.providerCompanyId === ctx.companyId;
  const platform = ctx.isSuperAdmin && ctx.companyId === ctx.homeCompanyId;
  if (!party && !platform) return null;
  const siteIds = [...new Set(a.siteIds)];
  return { customerCompanyId: a.customerCompanyId, siteIds, allSites: siteIds.length === 0 };
}

export function transportNotFound(message = 'Not found'): NotFoundException {
  return new NotFoundException({ message, code: 'NOT_FOUND' });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * E1b customer context (doc 07 §2.5): narrow the caller to one customer company it may act for, from the
 * X-Transport-Customer header. Own company → no agreements (own rows only); a customer with an in-force agreement → only
 * that agreement (own-company rows are hidden by includesOwnCompany). Anything else (unknown, ended, suspended, another
 * provider's customer, not a UUID) is a 404 NOT_FOUND, never 403, so the header cannot probe other tenants. Without a
 * header the context is returned unchanged ("All customers"). Pure: returns the fields to merge into the context.
 */
export function customerContextOf(
  ctx: Pick<AuthContext, 'companyId' | 'agreements' | 'agreementsAll' | 'transportCustomerId'>,
  raw: string | string[] | undefined,
  now: number = Date.now(),
): Pick<AuthContext, 'agreements' | 'agreementsAll' | 'transportCustomerId'> | null {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!value) return null;
  if (!UUID_RE.test(value)) throw transportNotFound('Customer not found');
  const all = ctx.agreementsAll ?? ctx.agreements ?? [];
  if (value === ctx.companyId) return { transportCustomerId: value, agreements: [], agreementsAll: all };
  const agreement = all.find((a) => a.customerCompanyId === value && a.customerCompanyId !== ctx.companyId && agreementScopeInForce(a, now));
  if (!agreement) throw transportNotFound('Customer not found');
  return { transportCustomerId: value, agreements: [agreement], agreementsAll: all };
}
