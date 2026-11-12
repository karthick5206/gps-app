/**
 * Employee transport (ETMS) contracts, phase E1a: company module, provider ↔ customer service agreements (D1, P1) and
 * the role templates seeded when the `etms` add-on is switched on (P6). Docs: docs/employee-transport/05, 10 §2, 15 §3.
 */
import type { DataScope, PermissionMap } from './permissions';

/**
 * Agreement lifecycle. DRAFT (editable) → PROPOSED (frozen, collecting both approvals) → ACTIVE (both sides approved)
 * ⇄ SUSPENDED → ENDED. ENDED is final. Doc 15 §3.1 lists DRAFT / ACTIVE / SUSPENDED / ENDED; PROPOSED is the E1a
 * addition that freezes the terms both sides approve (P1: both sides approve in-app).
 */
export const TRANSPORT_AGREEMENT_STATUSES = ['DRAFT', 'PROPOSED', 'ACTIVE', 'SUSPENDED', 'ENDED'] as const;
export type TransportAgreementStatus = (typeof TRANSPORT_AGREEMENT_STATUSES)[number];

/** Statuses covered by the "one live agreement per provider + customer pair" unique index. */
export const TRANSPORT_AGREEMENT_LIVE_STATUSES: readonly TransportAgreementStatus[] = ['DRAFT', 'PROPOSED', 'ACTIVE', 'SUSPENDED'];

/** Closed grant list (doc 10 §2.2 item 3). Never free text. */
export const TRANSPORT_GRANTS = [
  'VIEW_BOOKINGS',
  'MANAGE_DISPATCH',
  'VIEW_PASSENGER_MINIMAL',
  'VIEW_PASSENGER_CONTACT',
  'MANAGE_SCHEDULES',
  'RECEIVE_INCIDENTS',
  'MANAGE_INCIDENTS',
  'VIEW_REPORTS',
  'OVERRIDE_SAFETY_WARN',
] as const;
export type TransportGrant = (typeof TRANSPORT_GRANTS)[number];

/** Grants that allow changes (transportWriteScope accepts only these). */
export const TRANSPORT_WRITE_GRANTS: readonly TransportGrant[] = ['MANAGE_DISPATCH', 'MANAGE_SCHEDULES', 'MANAGE_INCIDENTS', 'OVERRIDE_SAFETY_WARN'];

/** How much passenger data the provider sees (doc 10 §2.2). FULL is the customer's own view, never an agreement value. */
export const TRANSPORT_DATA_PROFILES = ['MINIMAL', 'STANDARD'] as const;
export type TransportDataProfile = (typeof TRANSPORT_DATA_PROFILES)[number];

/** Which party of an agreement the caller acts for. */
export type TransportAgreementSide = 'PROVIDER' | 'CUSTOMER';

/** Commands on an agreement; `allowedActions` lists those the caller may run now (computed server-side). */
export type TransportAgreementAction = 'edit' | 'propose' | 'approve' | 'suspend' | 'resume' | 'end';

export interface TransportAgreementDto {
  id: string;
  version: number;
  status: TransportAgreementStatus;
  providerCompanyId: string;
  providerCompanyName: string;
  customerCompanyId: string;
  customerCompanyName: string;
  /** ISO-8601. */
  validFrom: string;
  /** ISO-8601; null = open-ended. */
  validTo: string | null;
  grants: TransportGrant[];
  /** Customer office / site Poi ids the agreement is limited to; empty = all customer sites. */
  siteIds: string[];
  dataProfile: TransportDataProfile;
  approvedByCustomerAt: string | null;
  /** Minimum data (doc 10 §2.3): only for the customer side itself and VeeTrax support; null for the provider. */
  approvedByCustomerUserId: string | null;
  approvedByProviderAt: string | null;
  /** Only for the provider side itself and VeeTrax support; null for the customer. */
  approvedByProviderUserId: string | null;
  suspendedAt: string | null;
  endedAt: string | null;
  statusReason: string | null;
  /** ACTIVE, inside its validity window: grants are in force right now. */
  inForce: boolean;
  /** The caller's side; null for the Super Admin acting on the platform. */
  side: TransportAgreementSide | null;
  allowedActions: TransportAgreementAction[];
  /** Only for VeeTrax support (the creator may belong to either party); null for the parties. */
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/transport/agreements — creates a DRAFT. */
export interface CreateTransportAgreementInput {
  providerCompanyId: string;
  customerCompanyId: string;
  validFrom: string;
  validTo?: string | null;
  grants: TransportGrant[];
  siteIds?: string[];
  dataProfile?: TransportDataProfile;
  /** Required when VeeTrax support (Super Admin) drafts; shown in the history and the customer's audit log. */
  reason?: string;
}

/** PATCH /api/transport/agreements/:id — DRAFT only. */
export interface UpdateTransportAgreementInput {
  validFrom?: string;
  validTo?: string | null;
  grants?: TransportGrant[];
  siteIds?: string[];
  dataProfile?: TransportDataProfile;
  expectedVersion?: number;
  /** Required for VeeTrax support (Super Admin). */
  reason?: string;
}

/** Body of propose / resume. `reason` is required when VeeTrax support proposes. */
export interface TransportAgreementCommandInput {
  expectedVersion?: number;
  reason?: string;
}

/** Body of approve: the version the approver saw is required, so nobody approves terms they never read. */
export interface TransportAgreementApproveInput {
  expectedVersion: number;
}

/** Body of suspend / end: reason required. */
export interface TransportAgreementReasonInput {
  reason: string;
  expectedVersion?: number;
}

/** GET /api/transport/agreements query (ListQuery + filters). `status` ACTIVE / INACTIVE keeps the list convention. */
export interface TransportAgreementListQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: 'createdAt' | 'updatedAt' | 'validFrom' | 'status';
  order?: 'asc' | 'desc';
  status?: 'ACTIVE' | 'INACTIVE';
  agreementStatus?: TransportAgreementStatus;
  side?: TransportAgreementSide;
  format?: 'json' | 'csv';
}

// ───────────────────────────── E1a gaps: directory, sites, history, summary ─────────────────────────────

/** GET /api/transport/companies/lookup?q= — minimum query length (trimmed). */
export const TRANSPORT_COMPANY_LOOKUP_MIN_CHARS = 3;
/** Lookups per user per minute before 429 RATE_LIMITED. */
export const TRANSPORT_COMPANY_LOOKUP_PER_MINUTE = 30;
/** Lookups per company (all its users together) per minute before 429 RATE_LIMITED. */
export const TRANSPORT_COMPANY_LOOKUP_PER_COMPANY_PER_MINUTE = 60;

/**
 * Company-level ETMS settings (menu `etms_settings`), stored in `Company.settings.etms`; GET / PATCH
 * /api/transport/settings. `directoryListed`: the company appears in other companies' partner lookup (opt-in, default
 * off). Unlisted companies can still be reached by pasting their company ID.
 */
export interface TransportSettingsDto {
  directoryListed: boolean;
  /** E5: transport desk phone shown to drivers and passengers ("call the desk"); absent when not set. */
  deskPhone?: string;
  /**
   * Owner decision 1 (2026-11-11): company maximum ride time per passenger, seconds within MAX_RIDE_BOUNDS_S; absent =
   * no limit. Snapshotted into a plan at optimise time unless the plan has an authorised override.
   */
  maxRideS?: number;
}

export interface UpdateTransportSettingsInput {
  directoryListed?: boolean;
  /** E5: null clears it. */
  deskPhone?: string | null;
  /** Seconds within MAX_RIDE_BOUNDS_S; null clears it (no limit). */
  maxRideS?: number | null;
}

/** Accepted range of a maximum ride time (company policy and per-plan override): 15 min – 4 h, whole seconds. */
export const MAX_RIDE_BOUNDS_S = { min: 900, max: 14_400 } as const;

/** A maximum ride time in seconds within MAX_RIDE_BOUNDS_S. */
export function isMaxRideS(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= MAX_RIDE_BOUNDS_S.min && v <= MAX_RIDE_BOUNDS_S.max;
}

/** Reads `Company.settings.etms` (anything missing or malformed = defaults). */
export function transportSettingsOf(settings: unknown): TransportSettingsDto {
  const s = typeof settings === 'object' && settings !== null && !Array.isArray(settings) ? (settings as Record<string, unknown>).etms : undefined;
  const etms = typeof s === 'object' && s !== null && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
  const phone = typeof etms.deskPhone === 'string' && etms.deskPhone.trim() ? etms.deskPhone.trim() : null;
  return { directoryListed: etms.directoryListed === true, ...(phone ? { deskPhone: phone } : {}), ...(isMaxRideS(etms.maxRideS) ? { maxRideS: etms.maxRideS } : {}) };
}

/**
 * One entry of the partner-company directory (privacy-safe): only active business companies with the `etms` add-on
 * switched on that opted in (`TransportSettingsDto.directoryListed`), and only these fields. Never contacts, users, vehicles or settings. `city` comes from the billing
 * profile when it has one (there is no country column; billing is India-only today).
 */
export interface TransportCompanyLookupDto {
  id: string;
  name: string;
  city: string | null;
}

/** A customer site (Poi) named on an agreement: id and name only. */
export interface TransportAgreementSiteDto {
  id: string;
  name: string;
}

/**
 * GET /api/transport/agreements/:id/sites — the customer sites the agreement is limited to. `allSites` = the agreement
 * names no sites (covers every customer site); the list is then empty, also for the customer, so a provider never gets
 * an enumeration of the customer's places. `unavailableCount` = named sites since deactivated or deleted.
 */
export interface TransportAgreementSitesDto {
  agreementId: string;
  allSites: boolean;
  sites: TransportAgreementSiteDto[];
  unavailableCount: number;
}

/** GET /api/transport/agreements/site-options — the customer's own active places for the agreement site picker. */
export interface TransportSiteOptionDto {
  id: string;
  name: string;
  branchName: string | null;
}

/** What happened in one agreement history entry (from the audit log). */
export type TransportAgreementHistoryKind = 'CREATED' | 'EDITED' | 'PROPOSED' | 'APPROVED' | 'SUSPENDED' | 'RESUMED' | 'ENDED';

/** Agreement terms an EDITED entry can list. */
export type TransportAgreementTermField = 'validFrom' | 'validTo' | 'grants' | 'siteIds' | 'dataProfile';
export const TRANSPORT_AGREEMENT_TERM_FIELDS: readonly TransportAgreementTermField[] = ['validFrom', 'validTo', 'grants', 'siteIds', 'dataProfile'];

/**
 * GET /api/transport/agreements/:id/history — one entry, oldest first. Minimum data (doc 10 §2.3): `actorName` is the
 * person only when the actor acted for the viewer's company (or the viewer is the Super Admin on the platform);
 * otherwise null and the screens show the side ("Customer", "Provider", "VeeTrax support"). Never IPs or user ids.
 */
export interface TransportAgreementHistoryEntryDto {
  id: string;
  at: string;
  kind: TransportAgreementHistoryKind;
  actorSide: TransportAgreementSide | 'PLATFORM' | null;
  actorName: string | null;
  fromStatus: TransportAgreementStatus | null;
  toStatus: TransportAgreementStatus | null;
  /** EDITED: the terms that changed. */
  changedFields: TransportAgreementTermField[];
  /** SUSPENDED / ENDED: the reason given; any entry by VeeTrax support: the support reason. */
  reason: string | null;
}

/** A proposed agreement waiting for the caller's side (dashboard list). */
export interface TransportAgreementAwaitingDto {
  id: string;
  counterpartyName: string;
  updatedAt: string;
}

/**
 * GET /api/transport/agreements/summary — counts over the agreements visible to the caller, plus the proposed ones the
 * caller's company still has to approve (0 / empty without `etms_partners:edit`; up to 10 listed, newest first).
 */
export interface TransportAgreementSummaryDto {
  byStatus: Record<TransportAgreementStatus, number>;
  total: number;
  awaitingMyApproval: number;
  awaiting: TransportAgreementAwaitingDto[];
}

/** Error `code` values ETMS sets on HTTP errors (doc 05 §4), E1a subset plus AGREEMENT_DUPLICATE and RATE_LIMITED. */
export type TransportErrorCode =
  | 'VALIDATION_FAILED'
  | 'FORBIDDEN_GRANT'
  | 'SCOPE_REQUIRED'
  | 'NOT_FOUND'
  | 'ETMS_DISABLED'
  | 'VERSION_CONFLICT'
  | 'INVALID_STATE'
  | 'AGREEMENT_INACTIVE'
  | 'AGREEMENT_DUPLICATE'
  | 'RATE_LIMITED'
  | 'REASON_REQUIRED'
  | 'NOT_A_PROVIDER';

// ───────────────────────────── State machine (pure) ─────────────────────────────

export interface AgreementStateView {
  status: TransportAgreementStatus;
  approvedByCustomerAt: unknown;
  approvedByProviderAt: unknown;
}

/** Commands allowed in a status, before looking at who calls. */
const BY_STATUS: Record<TransportAgreementStatus, readonly TransportAgreementAction[]> = {
  DRAFT: ['edit', 'propose', 'end'],
  PROPOSED: ['approve', 'end'],
  ACTIVE: ['suspend', 'end'],
  SUSPENDED: ['resume', 'end'],
  ENDED: [],
};

/**
 * Who may run a command (P1 / doc 05 §6): both parties draft, edit and propose; only the parties approve, each for its
 * own side (the Super Admin may draft but never approves); the customer suspends and resumes unilaterally; either party
 * ends. The Super Admin (PLAT, audited, with a reason) may also suspend and end, but never resume: resuming re-activates
 * the grants, which is the customer's call. The Super Admin always acts as PLATFORM, also after switching into a party
 * company (X-Company-Id).
 */
const BY_ACTOR: Record<TransportAgreementAction, readonly ('PROVIDER' | 'CUSTOMER' | 'PLATFORM')[]> = {
  edit: ['PROVIDER', 'CUSTOMER', 'PLATFORM'],
  propose: ['PROVIDER', 'CUSTOMER', 'PLATFORM'],
  approve: ['PROVIDER', 'CUSTOMER'],
  suspend: ['CUSTOMER', 'PLATFORM'],
  resume: ['CUSTOMER'],
  end: ['PROVIDER', 'CUSTOMER', 'PLATFORM'],
};

/** Commands the actor may run on the agreement now. */
export function agreementActions(a: AgreementStateView, actor: TransportAgreementSide | 'PLATFORM'): TransportAgreementAction[] {
  return BY_STATUS[a.status].filter((cmd) => {
    if (!BY_ACTOR[cmd].includes(actor)) return false;
    if (cmd === 'approve') return actor === 'CUSTOMER' ? !a.approvedByCustomerAt : !a.approvedByProviderAt;
    return true;
  });
}

/** Status after a command (approve → ACTIVE only once both sides approved). Throws on an illegal transition. */
export function nextAgreementStatus(a: AgreementStateView, cmd: TransportAgreementAction, actor: TransportAgreementSide | 'PLATFORM'): TransportAgreementStatus {
  if (!agreementActions(a, actor).includes(cmd)) throw new Error(`INVALID_STATE: ${cmd} not allowed in ${a.status} for ${actor}`);
  switch (cmd) {
    case 'edit':
      return 'DRAFT';
    case 'propose':
      return 'PROPOSED';
    case 'approve': {
      const customer = actor === 'CUSTOMER' || !!a.approvedByCustomerAt;
      const provider = actor === 'PROVIDER' || !!a.approvedByProviderAt;
      return customer && provider ? 'ACTIVE' : 'PROPOSED';
    }
    case 'suspend':
      return 'SUSPENDED';
    case 'resume':
      return 'ACTIVE';
    case 'end':
      return 'ENDED';
  }
}

/** ACTIVE and inside [validFrom, validTo). */
export function agreementInForce(a: { status: TransportAgreementStatus; validFrom: Date | string | number; validTo: Date | string | number | null }, now: Date = new Date()): boolean {
  if (a.status !== 'ACTIVE') return false;
  const t = now.getTime();
  if (new Date(a.validFrom).getTime() > t) return false;
  return a.validTo === null || new Date(a.validTo).getTime() > t;
}

// ───────────────────────────── Role templates (P6) ─────────────────────────────

/**
 * Roles created in a company when the `etms` add-on is switched on (never in the global SYSTEM_ROLES, no backfill of
 * existing roles). Created once, editable afterwards (isSystem = false); an existing role with the same name is kept
 * untouched. Later phases add their menus to these templates for newly enabled companies only.
 */
export const ETMS_ROLE_TEMPLATES: { name: string; description: string; dataScope: DataScope; permissions: PermissionMap }[] = [
  {
    name: 'Transport admin',
    description: 'Employee transport: corporate admin (agreements, settings, trips)',
    dataScope: 'COMPANY',
    permissions: {
      etms_dashboard: ['view', 'export'],
      etms_partners: ['view', 'create', 'edit'],
      etms_settings: ['view', 'edit'],
      live_map: ['view'],
      alerts: ['view', 'edit'],
      objects: ['view'],
      drivers: ['view'],
      routes: ['view', 'create', 'edit', 'delete', 'export'],
      plannedTrips: ['view', 'create', 'edit', 'delete', 'export'],
      reports: ['view', 'export'],
      audit_log: ['view', 'export'],
    },
  },
  {
    name: 'Transport dispatcher',
    description: 'Employee transport: dispatcher for assigned branches / sites',
    dataScope: 'ASSIGNED',
    permissions: {
      etms_dashboard: ['view'],
      etms_partners: ['view'],
      live_map: ['view'],
      alerts: ['view', 'edit'],
      objects: ['view'],
      drivers: ['view'],
      routes: ['view', 'edit'],
      plannedTrips: ['view', 'edit'],
      reports: ['view'],
    },
  },
  {
    name: 'Transport passenger',
    description: 'Employee transport: passenger (own commute only)',
    dataScope: 'ASSIGNED',
    permissions: { etms_self: ['view'] },
  },
  {
    name: 'Transport driver',
    description: 'Employee transport: driver (own assigned trips only)',
    dataScope: 'ASSIGNED',
    permissions: { etms_driver: ['view'] },
  },
];
