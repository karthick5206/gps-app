/**
 * ETMS tenant-isolation matrix (doc 11 §3.1, doc 12 §3 E1a exit criterion). The policy is declared ONCE here, per ETMS
 * route × role × resource ownership, and isolation-matrix.spec.ts generates one test per cell. The spec also discovers
 * every route of every ETMS controller from Nest metadata and fails when a route has no entry here (completeness guard),
 * so a new ETMS route cannot ship without declaring its isolation policy.
 *
 * Expected values: 200 = allowed (any 2xx), 403 = refused with FORBIDDEN_GRANT / SCOPE_REQUIRED (the caller may know the
 * resource exists), 404 = not found (other tenant's id, or the company's `etms` add-on is off: never 403, so it can't
 * tell the route or the row exists).
 */
import type { TransportAgreementStatus } from '@veetracer/shared';
import type { AgreementsController } from '../agreements/agreements.controller';
import type { CompanyDirectoryController } from '../directory/company-directory.controller';
import type { TransportSettingsController } from '../settings/transport-settings.controller';
import type { AuthContext } from '../../access/auth-context';

/** Callers. Customer = custA, provider = prov; the "other" agreement is prov2 ↔ custB. */
export const MATRIX_ROLES = [
  'customerAdmin', // custA, template "Transport admin" (COMPANY)
  'customerDispatcher', // custA, template "Transport dispatcher" (ASSIGNED)
  'providerAdmin', // prov, "Transport admin"
  'providerDispatcher', // prov, "Transport dispatcher"
  'fleetUser', // custA (etms on), built-in Manager role, no ETMS grants
  'etmsOffCompany', // a company with the add-on off, whose role still holds every ETMS grant
  'superAdmin', // platform company (PLAT)
  'superAdminSwitched', // Super Admin with X-Company-Id = custA
] as const;
export type MatrixRole = (typeof MATRIX_ROLES)[number];

/** party = the caller's company is a party (prov ↔ custA); other = an agreement between two other companies; none = no row. */
export type Ownership = 'party' | 'other' | 'none';
export type Expected = 200 | 403 | 404;
export type RoleTable = Record<MatrixRole, Expected>;

export interface Controllers {
  agreements: AgreementsController;
  directory: CompanyDirectoryController;
  settings: TransportSettingsController;
}

export interface Target {
  /** The agreement for this ownership (prepared in `state`); undefined for ownership 'none'. */
  id: string;
  version: number;
  /** For create: the parties to put in the body. */
  providerCompanyId: string;
  customerCompanyId: string;
}

export interface MatrixEntry {
  /** `METHOD path` exactly as discovered from Nest metadata, e.g. `POST transport/agreements/:id/approve`. */
  route: string;
  /** State of the target agreement before the call; 'none' = no agreements exist (create). */
  state: TransportAgreementStatus | 'none';
  invoke(c: Controllers, ctx: AuthContext, t: Target): Promise<unknown>;
  expect: Partial<Record<Ownership, RoleTable>>;
}

const REASON = 'isolation matrix';

// Shorthands for the common shapes (spelled out, so each table reads as policy).
const READ_ALL: RoleTable = { customerAdmin: 200, customerDispatcher: 200, providerAdmin: 200, providerDispatcher: 200, fleetUser: 403, etmsOffCompany: 404, superAdmin: 200, superAdminSwitched: 200 };
const READ_OTHER: RoleTable = { customerAdmin: 404, customerDispatcher: 404, providerAdmin: 404, providerDispatcher: 404, fleetUser: 403, etmsOffCompany: 404, superAdmin: 200, superAdminSwitched: 404 };
const ADMINS_ONLY: RoleTable = { customerAdmin: 200, customerDispatcher: 403, providerAdmin: 200, providerDispatcher: 403, fleetUser: 403, etmsOffCompany: 404, superAdmin: 200, superAdminSwitched: 200 };
const WRITE_OTHER: RoleTable = { customerAdmin: 404, customerDispatcher: 403, providerAdmin: 404, providerDispatcher: 403, fleetUser: 403, etmsOffCompany: 404, superAdmin: 200, superAdminSwitched: 404 };

export const ISOLATION_MATRIX: MatrixEntry[] = [
  // ── Agreements: reads ──
  { route: 'GET transport/agreements', state: 'DRAFT', invoke: (c, ctx) => c.agreements.list(ctx, {}), expect: { none: READ_ALL } },
  { route: 'GET transport/agreements/summary', state: 'DRAFT', invoke: (c, ctx) => c.agreements.summary(ctx), expect: { none: READ_ALL } },
  { route: 'GET transport/agreements/site-options', state: 'DRAFT', invoke: (c, ctx) => c.agreements.siteOptions(ctx, { customerCompanyId: 'custB' }), expect: { none: ADMINS_ONLY } },
  { route: 'GET transport/agreements/:id', state: 'DRAFT', invoke: (c, ctx, t) => c.agreements.get(ctx, t.id), expect: { party: READ_ALL, other: READ_OTHER } },
  { route: 'GET transport/agreements/:id/sites', state: 'ACTIVE', invoke: (c, ctx, t) => c.agreements.sites(ctx, t.id), expect: { party: READ_ALL, other: READ_OTHER } },
  { route: 'GET transport/agreements/:id/history', state: 'ACTIVE', invoke: (c, ctx, t) => c.agreements.history(ctx, t.id), expect: { party: READ_ALL, other: READ_OTHER } },
  // ── Agreements: commands ──
  {
    route: 'POST transport/agreements',
    state: 'none',
    invoke: (c, ctx, t) => c.agreements.create(ctx, { providerCompanyId: t.providerCompanyId, customerCompanyId: t.customerCompanyId, validFrom: '2026-11-01T00:00:00Z', grants: ['VIEW_BOOKINGS'], reason: REASON }),
    expect: {
      party: ADMINS_ONLY,
      // Not a party: 403 FORBIDDEN_GRANT for company users; VeeTrax support may draft for any pair (P1).
      other: { customerAdmin: 403, customerDispatcher: 403, providerAdmin: 403, providerDispatcher: 403, fleetUser: 403, etmsOffCompany: 404, superAdmin: 200, superAdminSwitched: 200 },
    },
  },
  { route: 'PATCH transport/agreements/:id', state: 'DRAFT', invoke: (c, ctx, t) => c.agreements.update(ctx, t.id, { grants: ['VIEW_REPORTS'], expectedVersion: t.version, reason: REASON }), expect: { party: ADMINS_ONLY, other: WRITE_OTHER } },
  { route: 'POST transport/agreements/:id/propose', state: 'DRAFT', invoke: (c, ctx, t) => c.agreements.propose(ctx, t.id, { expectedVersion: t.version, reason: REASON }), expect: { party: ADMINS_ONLY, other: WRITE_OTHER } },
  {
    route: 'POST transport/agreements/:id/approve',
    state: 'PROPOSED',
    invoke: (c, ctx, t) => c.agreements.approve(ctx, t.id, { expectedVersion: t.version }),
    expect: {
      // P1 / F2: each party approves its own side; VeeTrax support never, also after switching into a party.
      party: { customerAdmin: 200, customerDispatcher: 403, providerAdmin: 200, providerDispatcher: 403, fleetUser: 403, etmsOffCompany: 404, superAdmin: 403, superAdminSwitched: 403 },
      other: { ...WRITE_OTHER, superAdmin: 403 },
    },
  },
  {
    route: 'POST transport/agreements/:id/suspend',
    state: 'ACTIVE',
    invoke: (c, ctx, t) => c.agreements.suspend(ctx, t.id, { reason: REASON, expectedVersion: t.version }),
    expect: {
      // Only the customer (or VeeTrax support) suspends.
      party: { customerAdmin: 200, customerDispatcher: 403, providerAdmin: 403, providerDispatcher: 403, fleetUser: 403, etmsOffCompany: 404, superAdmin: 200, superAdminSwitched: 200 },
      other: WRITE_OTHER,
    },
  },
  {
    route: 'POST transport/agreements/:id/resume',
    state: 'SUSPENDED',
    invoke: (c, ctx, t) => c.agreements.resume(ctx, t.id, { expectedVersion: t.version }),
    expect: {
      // Only the customer resumes (re-activating grants is never VeeTrax support's call).
      party: { customerAdmin: 200, customerDispatcher: 403, providerAdmin: 403, providerDispatcher: 403, fleetUser: 403, etmsOffCompany: 404, superAdmin: 403, superAdminSwitched: 403 },
      other: { ...WRITE_OTHER, superAdmin: 403 },
    },
  },
  { route: 'POST transport/agreements/:id/end', state: 'ACTIVE', invoke: (c, ctx, t) => c.agreements.end(ctx, t.id, { reason: REASON, expectedVersion: t.version }), expect: { party: ADMINS_ONLY, other: WRITE_OTHER } },
  // ── Directory ──
  { route: 'GET transport/companies/lookup', state: 'none', invoke: (c, ctx) => c.directory.lookup(ctx, { q: 'Customer' }), expect: { none: ADMINS_ONLY } },
  // ── Company ETMS settings ──
  { route: 'GET transport/settings', state: 'none', invoke: (c, ctx) => c.settings.get(ctx), expect: { none: ADMINS_ONLY } },
  { route: 'PATCH transport/settings', state: 'none', invoke: (c, ctx) => c.settings.update(ctx, { directoryListed: true }), expect: { none: ADMINS_ONLY } },
];
