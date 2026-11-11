import { Prisma } from '@prisma/client';
import {
  ETMS_PASSENGER_ROLE_NAME,
  currentConsents,
  maskEmail,
  maskPhone,
  roundCoord,
  shortName,
  ROUTING_CONSENT_PURPOSE,
  type EmergencyContact,
  type HomeLocationSource,
  type PassengerAccessibility,
  type PassengerDto,
  type PassengerPickupDto,
  type PassengerProjection,
  type PlaceRef,
} from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { actingCustomers } from '../../access/transport-scope';

/**
 * E2 passenger visibility and projections (docs 02 §4.2, 05 §6, 10 §2). Built on access/transport-scope (the single
 * source for agreements): the customer company sees its own passengers (whole-company roles FULL, branch / site
 * scoped roles STANDARD), a provider sees the passengers of customers whose in-force agreement grants
 * VIEW_PASSENGER_MINIMAL (limited to the agreement's sites, MINIMAL projection), everyone else nothing (404).
 */

export type PeopleCtx = Pick<AuthContext, 'companyId' | 'dataScope' | 'branchIds' | 'agreements'>;

/** How a provider may see contacts: not at all, masked (VIEW_PASSENGER_CONTACT), in clear (+ STANDARD data profile). */
export type ContactLevel = 'NONE' | 'MASKED' | 'CLEAR';

export interface PassengerView {
  projection: PassengerProjection;
  /** For MINIMAL only; FULL / STANDARD always see contacts in the detail view. */
  contact: ContactLevel;
  /** Provider access under an agreement (audited under the customer company). */
  agreementId: string | null;
}

export interface ProviderPassengerAccess {
  customerCompanyId: string;
  agreementId: string;
  /** Office site ids the agreement is limited to; [] = every site. */
  siteIds: string[];
  contact: ContactLevel;
}

/** Customers whose passengers the caller (as a provider) may see: agreements in force granting VIEW_PASSENGER_MINIMAL. */
export function providerPassengerAccess(ctx: PeopleCtx, now: number = Date.now()): ProviderPassengerAccess[] {
  return actingCustomers(ctx, 'VIEW_PASSENGER_MINIMAL', now)
    .filter((c) => c.mode === 'AGREEMENT' && c.agreementId)
    .map((c) => ({
      customerCompanyId: c.customerCompanyId,
      agreementId: c.agreementId as string,
      siteIds: c.siteIds ?? [],
      contact: c.grants.includes('VIEW_PASSENGER_CONTACT') ? (c.dataProfile === 'STANDARD' ? 'CLEAR' : 'MASKED') : 'NONE',
    }));
}

/** The caller's own company's passengers it may read and change (ASSIGNED: own branches + company-wide passengers). */
export function ownPassengerWhere(ctx: PeopleCtx): Prisma.EmployeeTransportProfileWhereInput {
  if (ctx.dataScope === 'COMPANY') return { companyId: ctx.companyId };
  return { companyId: ctx.companyId, OR: [{ branchId: null }, { branchId: { in: ctx.branchIds } }] };
}

/** Every passenger the caller may read: own company (scoped) plus active passengers of customers granting access. */
export function passengerReadWhere(ctx: PeopleCtx, now: number = Date.now()): Prisma.EmployeeTransportProfileWhereInput {
  const or: Prisma.EmployeeTransportProfileWhereInput[] = [ownPassengerWhere(ctx)];
  for (const p of providerPassengerAccess(ctx, now)) {
    or.push({ companyId: p.customerCompanyId, isActive: true, ...(p.siteIds.length ? { officePoiId: { in: p.siteIds } } : {}) });
  }
  return { OR: or };
}

/** Projection of one row for the caller, or null when the caller may not see it (→ 404). */
export function passengerView(ctx: PeopleCtx, row: { companyId: string; branchId: string | null; officePoiId: string | null; isActive: boolean }, now: number = Date.now()): PassengerView | null {
  if (row.companyId === ctx.companyId) {
    if (ctx.dataScope === 'COMPANY') return { projection: 'FULL', contact: 'CLEAR', agreementId: null };
    if (row.branchId === null || ctx.branchIds.includes(row.branchId)) return { projection: 'STANDARD', contact: 'CLEAR', agreementId: null };
    return null;
  }
  if (!row.isActive) return null;
  const p = providerPassengerAccess(ctx, now).find((a) => a.customerCompanyId === row.companyId);
  if (!p) return null;
  if (p.siteIds.length && (!row.officePoiId || !p.siteIds.includes(row.officePoiId))) return null;
  return { projection: 'MINIMAL', contact: p.contact, agreementId: p.agreementId };
}

/** True when the caller can change the row (own company, inside its branch scope). Providers never write passengers. */
export function canWritePassenger(ctx: PeopleCtx, row: { companyId: string; branchId: string | null }): boolean {
  if (row.companyId !== ctx.companyId) return false;
  return ctx.dataScope === 'COMPANY' || row.branchId === null || ctx.branchIds.includes(row.branchId);
}

// ───────────────────────────── Mapping ─────────────────────────────

export const PASSENGER_INCLUDE = {
  branch: { select: { name: true } },
  officePoi: { select: { id: true, name: true, lat: true, lng: true } },
  defaultStop: { select: { id: true, name: true, lat: true, lng: true } },
  user: { select: { id: true, isActive: true, email: true, mobile: true, lastLoginAt: true, roles: { select: { role: { select: { name: true } } } } } },
} satisfies Prisma.EmployeeTransportProfileInclude;

export type PassengerRow = Prisma.EmployeeTransportProfileGetPayload<{ include: typeof PASSENGER_INCLUDE }>;

export interface ConsentRowLike {
  purpose: string;
  granted: boolean;
  noticeVersion: string;
  channel: string;
  occurredAt: Date;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const place = (p: { id: string; name: string; lat: number; lng: number } | null): PlaceRef | null => (p ? { id: p.id, name: p.name, lat: p.lat, lng: p.lng } : null);

export function accessibilityOf(json: Prisma.JsonValue): PassengerAccessibility {
  const a = (json && typeof json === 'object' && !Array.isArray(json) ? json : {}) as Record<string, unknown>;
  const out: PassengerAccessibility = {};
  if (typeof a.wheelchair === 'boolean') out.wheelchair = a.wheelchair;
  if (typeof a.notes === 'string' && a.notes.trim()) out.notes = a.notes;
  return out;
}

export function emergencyContactsOf(json: Prisma.JsonValue): EmergencyContact[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((c) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return [];
    const r = c as Record<string, unknown>;
    if (typeof r.name !== 'string' || typeof r.phone !== 'string') return [];
    return [{ name: r.name, phone: r.phone, ...(typeof r.relation === 'string' ? { relation: r.relation } : {}) }];
  });
}

/**
 * Routing pickup (doc 02 §7.3): only with an active TRANSPORT_PROFILE consent; the default stop wins over the home
 * point; home points rounded to 4 decimals unless FULL; never the address.
 */
export function pickupOf(row: Pick<PassengerRow, 'homeLat' | 'homeLng' | 'defaultStop'>, consentActive: boolean, projection: PassengerProjection): PassengerPickupDto | null {
  if (!consentActive) return null;
  if (row.defaultStop) return { kind: 'STOP', lat: row.defaultStop.lat, lng: row.defaultStop.lng, label: row.defaultStop.name, poiId: row.defaultStop.id };
  if (row.homeLat === null || row.homeLng === null) return null;
  const d = projection === 'FULL' ? 6 : 4;
  return { kind: 'HOME', lat: roundCoord(row.homeLat, d), lng: roundCoord(row.homeLng, d), label: null, poiId: null };
}

/**
 * The DTO for a projection. `detail` = single-passenger read (contacts in clear for FULL / STANDARD, emergency contacts
 * for FULL); list rows always mask contacts. `consents` = the passenger's consent rows (latest per purpose suffices).
 */
export function toPassengerDto(row: PassengerRow, view: PassengerView, consents: ConsentRowLike[], detail: boolean): PassengerDto {
  const p = view.projection;
  const states = currentConsents(consents);
  const routingConsent = states.find((c) => c.purpose === ROUTING_CONSENT_PURPOSE)?.active ?? false;
  const accessibility = accessibilityOf(row.accessibility);
  const hasHome = row.homeLat !== null && row.homeLng !== null;
  const minimal = p === 'MINIMAL';

  let mobile: string | null;
  let email: string | null;
  if (minimal) {
    const clear = view.contact === 'CLEAR' && detail;
    mobile = view.contact === 'NONE' ? null : clear ? row.mobile : maskPhone(row.mobile);
    email = view.contact === 'NONE' ? null : clear ? row.email : maskEmail(row.email);
  } else {
    mobile = detail ? row.mobile : maskPhone(row.mobile);
    email = detail ? row.email : maskEmail(row.email);
  }

  const roles = row.user?.roles.map((r) => r.role.name) ?? [];
  return {
    id: row.id,
    projection: p,
    customerCompanyId: row.companyId,
    employeeCode: row.employeeCode,
    displayName: minimal ? shortName(row.displayName) : row.displayName,
    isActive: row.isActive,
    branchId: minimal ? null : row.branchId,
    branchName: minimal ? null : (row.branch?.name ?? null),
    office: place(row.officePoi),
    // The default stop is near the passenger's home: providers see it only with an active routing consent.
    defaultStop: minimal && !routingConsent ? null : place(row.defaultStop),
    mobile,
    email,
    home: minimal
      ? null
      : {
          address: p === 'FULL' && detail ? row.homeAddress : null,
          lat: hasHome ? roundCoord(row.homeLat as number, p === 'FULL' ? 6 : 4) : null,
          lng: hasHome ? roundCoord(row.homeLng as number, p === 'FULL' ? 6 : 4) : null,
          source: (row.homeGeocodeSource as HomeLocationSource | null) ?? null,
          confidence: row.homeGeocodeConfidence,
        },
    hasHomeLocation: hasHome,
    needsLocation: row.isActive && !hasHome && !row.defaultStopPoiId,
    pickup: pickupOf(row, routingConsent, p),
    routingConsent,
    accessibilityNeeds: !!accessibility.wheelchair || !!accessibility.notes,
    accessibility: minimal ? null : accessibility,
    emergencyContacts: p === 'FULL' && detail ? emergencyContactsOf(row.emergencyContacts) : null,
    appAccess:
      minimal || !row.user
        ? null
        : {
            userId: row.user.id,
            active: row.user.isActive && roles.includes(ETMS_PASSENGER_ROLE_NAME),
            email: row.user.email,
            mobile: row.user.mobile,
            lastLoginAt: iso(row.user.lastLoginAt),
            otherRoles: roles.some((n) => n !== ETMS_PASSENGER_ROLE_NAME),
          },
    consents: minimal ? null : states,
    createdAt: minimal ? null : iso(row.createdAt),
    updatedAt: minimal ? null : iso(row.updatedAt),
  };
}
