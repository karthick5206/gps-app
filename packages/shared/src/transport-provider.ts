import type { ListQuery } from './api';
import type { TransportDataProfile, TransportGrant } from './transport';

/**
 * ETMS E1b: provider side (docs/employee-transport/12 §6, 07 §2.5, 10 §2.2 items 5 / 8, 15 §10). A provider is a
 * BUSINESS company with the add-ons `etms` + `etmsProvider`; it acts for customer companies only under an in-force
 * TransportServiceAgreement, and ctx.companyId never changes.
 */

/**
 * Customer context (07 §2.5): the web sends the selected customer company in this header on every /transport/* call
 * (the page keeps it in `?customer=<id>`). The API validates it against the caller's acting customers (own company or
 * an in-force agreement) and then narrows the request to that customer; an unknown / ended / foreign id is a 404.
 */
export const TRANSPORT_CUSTOMER_HEADER = 'X-Transport-Customer';
/** URL query key the web keeps the selected customer in. */
export const TRANSPORT_CUSTOMER_QUERY = 'customer';

/**
 * Super Admin reason (10 §2.2 item 8): VeeTrax support must send a reason in this header to read a customer's
 * passenger personal data; the read is written to the customer's sensitive-access log (AuditAction ACCESS).
 * Missing / too short → 400 REASON_REQUIRED. Other callers may send it (it is logged) but need not.
 */
export const ACCESS_REASON_HEADER = 'X-Access-Reason';
export const ACCESS_REASON_MIN = 5;
export const ACCESS_REASON_MAX = 300;

/** One customer the caller may act for (GET /api/transport/context). */
export interface TransportCustomerOptionDto {
  customerCompanyId: string;
  name: string;
  /** SELF = the caller's own company (corporate-managed); AGREEMENT = a customer under an in-force agreement. */
  mode: 'SELF' | 'AGREEMENT';
  agreementId: string | null;
  grants: TransportGrant[];
  /** true = every customer site; else `siteCount` sites. */
  allSites: boolean;
  siteCount: number;
  /** FULL for the own company; else the agreement's passenger projection. */
  dataProfile: TransportDataProfile | 'FULL';
  /** ISO-8601; null = open-ended (own company, or an agreement without end). */
  validTo: string | null;
}

/** GET /api/transport/context: what the customer picker offers. */
export interface TransportCustomerContextDto {
  companyId: string;
  /** The acting company has the `etmsProvider` add-on. */
  isProvider: boolean;
  /** Show the picker: a provider with at least one in-force agreement (hidden for corporate-managed accounts). */
  showPicker: boolean;
  /** The customer the request was narrowed to (header), or null = all customers. */
  selected: string | null;
  /** Own company first, then customers by name. */
  customers: TransportCustomerOptionDto[];
}

/** A provider vehicle and / or driver set aside for one customer under an agreement. */
export interface TransportFleetAllocationDto {
  id: string;
  agreementId: string;
  providerCompanyId: string;
  customerCompanyId: string | null;
  vehicle: { id: string; name: string; plateNumber: string | null } | null;
  driver: { id: string; name: string } | null;
  /** ISO-8601. */
  validFrom: string;
  /** ISO-8601; null = open-ended. */
  validTo: string | null;
  /** In force right now (validity, and the agreement is ACTIVE and in force). */
  active: boolean;
  note: string | null;
  createdAt: string;
  /** The caller may end it (provider admin, open allocation). */
  canEnd: boolean;
}

/** POST /api/transport/agreements/:id/fleet (provider admins only). */
export interface CreateTransportFleetAllocationInput {
  objectId?: string | null;
  driverId?: string | null;
  /** ISO-8601; default now. */
  validFrom?: string;
  validTo?: string | null;
  note?: string | null;
}

/** Who read the data: the company's own users, a provider under an agreement, or VeeTrax support. */
export type TransportAccessActorKind = 'OWN' | 'PROVIDER' | 'SUPPORT';
export const TRANSPORT_ACCESS_ACTOR_FILTERS = ['external', 'all'] as const;
export type TransportAccessActorFilter = (typeof TRANSPORT_ACCESS_ACTOR_FILTERS)[number];

/** GET /api/transport/access-log: the customer's sensitive-access log (10 §2.2 item 8, §2.3 last row). */
export interface TransportAccessLogEntryDto {
  id: string;
  /** ISO-8601. */
  at: string;
  actorKind: TransportAccessActorKind;
  actorName: string | null;
  /** The provider company for PROVIDER; null otherwise. */
  actorCompanyName: string | null;
  /** detail | list | csv-export | consent-history | history … */
  what: string;
  entity: string;
  entityId: string | null;
  /** The passenger's name (the customer's own data), when the entry is about one passenger. */
  subjectName: string | null;
  /** Rows a list read returned. */
  rows: number | null;
  reason: string | null;
  agreementId: string | null;
  /** The home location was part of the read. */
  homeLocation: boolean;
}

export interface TransportAccessLogQuery extends ListQuery {
  /** external (default) = providers and VeeTrax support only; all = also the company's own users. */
  actor?: TransportAccessActorFilter;
  /** YYYY-MM-DD (inclusive, UTC). */
  from?: string;
  to?: string;
}
