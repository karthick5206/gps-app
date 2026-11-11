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
import type { PassengerDto, TransportAgreementStatus } from '@veetracer/shared';
import type { AgreementsController } from '../agreements/agreements.controller';
import type { CompanyDirectoryController } from '../directory/company-directory.controller';
import type { ConsentNoticesController, DriverLoginController, MyTransportConsentController, PassengersController, TransportVehiclesController } from '../people/people.controller';
import type { TransportSettingsController } from '../settings/transport-settings.controller';
import type { AuthContext } from '../../access/auth-context';

/**
 * Callers. Customer = custA, provider = prov; the "other" agreement is prov2 ↔ custB. Templates carry the E2 additions
 * (templatePermissions). Branch-scoped callers hold branch brA1, where the party passenger / vehicle / driver live.
 */
export const MATRIX_ROLES = [
  'customerAdmin', // custA, template "Transport admin" (COMPANY)
  'customerDispatcher', // custA, template "Transport dispatcher" (ASSIGNED, branch brA1)
  'customerPassenger', // custA, template "Transport passenger": the login of the party passenger (E2)
  'providerAdmin', // prov, "Transport admin"
  'providerDispatcher', // prov, "Transport dispatcher"
  'fleetUser', // custA (etms on), built-in Manager role (branch brA1), no ETMS grants (but objects / drivers edit)
  'etmsOffCompany', // a company with the add-on off, whose role still holds every ETMS grant
  'superAdmin', // platform company (PLAT)
  'superAdminSwitched', // Super Admin with X-Company-Id = custA
] as const;
export type MatrixRole = (typeof MATRIX_ROLES)[number];

/**
 * Agreements: party = the caller's company is a party (prov ↔ custA); other = an agreement between two other companies;
 * none = no row. E2 resources: party = the custA row (passenger / vehicle / driver in branch brA1, passenger office
 * siteA1, which the prov ↔ custA agreement covers); other = the same kind of row of custB (no agreement with anyone).
 */
export type Ownership = 'party' | 'other' | 'none';
export type Expected = 200 | 403 | 404;
export type RoleTable = Record<MatrixRole, Expected>;

/** What `Target.id` points at: an agreement (E1a) or an E2 row. */
export type Resource = 'agreement' | 'passenger' | 'vehicle' | 'driver';

export interface Controllers {
  agreements: AgreementsController;
  directory: CompanyDirectoryController;
  settings: TransportSettingsController;
  passengers: PassengersController;
  myConsent: MyTransportConsentController;
  notices: ConsentNoticesController;
  vehicles: TransportVehiclesController;
  driverLogin: DriverLoginController;
}

export interface Target {
  /** The agreement (or E2 row, see Resource) for this ownership; a random id for ownership 'none'. */
  id: string;
  version: number;
  /** For create: the parties to put in the body. */
  providerCompanyId: string;
  customerCompanyId: string;
  /** E2 world: ids of the rows the result checks look for. */
  ids?: { partyPassenger: string; otherPassenger: string; outsideSitePassenger: string };
}

export interface MatrixEntry {
  /** `METHOD path` exactly as discovered from Nest metadata, e.g. `POST transport/agreements/:id/approve`. */
  route: string;
  /** Default 'agreement'. E2 entries run in the E2 world (passengers, vehicles, drivers, logins, an ACTIVE prov ↔ custA agreement). */
  resource?: Resource;
  /** State of the target agreement before the call; 'none' = no agreements exist (create). E2 entries: 'ACTIVE'. */
  state: TransportAgreementStatus | 'none';
  invoke(c: Controllers, ctx: AuthContext, t: Target): Promise<unknown>;
  expect: Partial<Record<Ownership, RoleTable>>;
  /** Extra check of a 2xx result (projection, rows visible), beyond the status code. */
  verify?(result: unknown, role: MatrixRole, own: Ownership, t: Target): void;
}

const REASON = 'isolation matrix';

// Shorthands for the common shapes (spelled out, so each table reads as policy).
const READ_ALL: RoleTable = { customerAdmin: 200, customerDispatcher: 200, customerPassenger: 403, providerAdmin: 200, providerDispatcher: 200, fleetUser: 403, etmsOffCompany: 404, superAdmin: 200, superAdminSwitched: 200 };
const READ_OTHER: RoleTable = { customerAdmin: 404, customerDispatcher: 404, customerPassenger: 403, providerAdmin: 404, providerDispatcher: 404, fleetUser: 403, etmsOffCompany: 404, superAdmin: 200, superAdminSwitched: 404 };
const ADMINS_ONLY: RoleTable = { customerAdmin: 200, customerDispatcher: 403, customerPassenger: 403, providerAdmin: 200, providerDispatcher: 403, fleetUser: 403, etmsOffCompany: 404, superAdmin: 200, superAdminSwitched: 200 };
const WRITE_OTHER: RoleTable = { customerAdmin: 404, customerDispatcher: 403, customerPassenger: 403, providerAdmin: 404, providerDispatcher: 403, fleetUser: 403, etmsOffCompany: 404, superAdmin: 200, superAdminSwitched: 404 };

const E1A_MATRIX: MatrixEntry[] = [
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
      other: { customerAdmin: 403, customerDispatcher: 403, customerPassenger: 403, providerAdmin: 403, providerDispatcher: 403, fleetUser: 403, etmsOffCompany: 404, superAdmin: 200, superAdminSwitched: 200 },
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
      party: { customerAdmin: 200, customerDispatcher: 403, customerPassenger: 403, providerAdmin: 200, providerDispatcher: 403, fleetUser: 403, etmsOffCompany: 404, superAdmin: 403, superAdminSwitched: 403 },
      other: { ...WRITE_OTHER, superAdmin: 403 },
    },
  },
  {
    route: 'POST transport/agreements/:id/suspend',
    state: 'ACTIVE',
    invoke: (c, ctx, t) => c.agreements.suspend(ctx, t.id, { reason: REASON, expectedVersion: t.version }),
    expect: {
      // Only the customer (or VeeTrax support) suspends.
      party: { customerAdmin: 200, customerDispatcher: 403, customerPassenger: 403, providerAdmin: 403, providerDispatcher: 403, fleetUser: 403, etmsOffCompany: 404, superAdmin: 200, superAdminSwitched: 200 },
      other: WRITE_OTHER,
    },
  },
  {
    route: 'POST transport/agreements/:id/resume',
    state: 'SUSPENDED',
    invoke: (c, ctx, t) => c.agreements.resume(ctx, t.id, { expectedVersion: t.version }),
    expect: {
      // Only the customer resumes (re-activating grants is never VeeTrax support's call).
      party: { customerAdmin: 200, customerDispatcher: 403, customerPassenger: 403, providerAdmin: 403, providerDispatcher: 403, fleetUser: 403, etmsOffCompany: 404, superAdmin: 403, superAdminSwitched: 403 },
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

// ───────────────────────────── E2: people (doc 05 §2.2–2.3 / §6, doc 10 §2) ─────────────────────────────

/**
 * Passengers. Customer admin: everything, FULL projection. Dispatcher: own branch, STANDARD (home address hidden), no
 * create / delete / import, no consent records. Provider: read-only MINIMAL, only under an in-force agreement granting
 * VIEW_PASSENGER_MINIMAL and only at the agreement's sites; writes 403. Fleet user (no etms_passengers) and the
 * passenger itself 403; etms-off company 404. Super Admin must switch into the company (platform context: 404).
 */
const P_LIST: RoleTable = { customerAdmin: 200, customerDispatcher: 200, customerPassenger: 403, providerAdmin: 200, providerDispatcher: 200, fleetUser: 403, etmsOffCompany: 404, superAdmin: 200, superAdminSwitched: 200 };
const P_READ: RoleTable = { customerAdmin: 200, customerDispatcher: 200, customerPassenger: 403, providerAdmin: 200, providerDispatcher: 200, fleetUser: 403, etmsOffCompany: 404, superAdmin: 404, superAdminSwitched: 200 };
const P_OTHER: RoleTable = { customerAdmin: 404, customerDispatcher: 404, customerPassenger: 403, providerAdmin: 404, providerDispatcher: 404, fleetUser: 403, etmsOffCompany: 404, superAdmin: 404, superAdminSwitched: 404 };
const P_EDIT: RoleTable = { ...P_READ, providerAdmin: 403, providerDispatcher: 403 };
const P_FULL_ONLY: RoleTable = { ...P_EDIT, customerDispatcher: 403 };
/** Delete: the dispatcher template has no etms_passengers:delete (guard 403 before any lookup). */
const P_DELETE: RoleTable = P_FULL_ONLY;
const P_DELETE_OTHER: RoleTable = { ...P_OTHER, customerDispatcher: 403, providerDispatcher: 403 };
/** Create / import into the caller's OWN company (whole-company roles with etms_passengers:create). */
const P_CREATE: RoleTable = { customerAdmin: 200, customerDispatcher: 403, customerPassenger: 403, providerAdmin: 200, providerDispatcher: 403, fleetUser: 403, etmsOffCompany: 404, superAdmin: 200, superAdminSwitched: 200 };
const P_GEOCODE: RoleTable = { ...P_LIST };
/** /me/transport/consent: only the passenger itself (etms_self + own active profile; others 403 NOT_A_PASSENGER). */
const SELF: RoleTable = { customerAdmin: 403, customerDispatcher: 403, customerPassenger: 200, providerAdmin: 403, providerDispatcher: 403, fleetUser: 403, etmsOffCompany: 404, superAdmin: 403, superAdminSwitched: 403 };
/** Consent notices: always the caller's own company; read with settings or passengers view, publish = whole-company settings edit. */
const N_READ: RoleTable = { ...P_LIST };
const N_PUBLISH: RoleTable = { ...P_CREATE };
/**
 * Vehicle seats and driver logins use the fleet grants (objects / drivers): own company only, branch-scoped for
 * ASSIGNED roles, never a provider. Edits need objects:edit / drivers:edit, which only the fleet Manager holds here.
 */
const F_LIST: RoleTable = { customerAdmin: 200, customerDispatcher: 200, customerPassenger: 403, providerAdmin: 200, providerDispatcher: 200, fleetUser: 200, etmsOffCompany: 404, superAdmin: 200, superAdminSwitched: 200 };
const F_READ: RoleTable = { customerAdmin: 200, customerDispatcher: 200, customerPassenger: 403, providerAdmin: 404, providerDispatcher: 404, fleetUser: 200, etmsOffCompany: 404, superAdmin: 404, superAdminSwitched: 200 };
const F_READ_OTHER: RoleTable = { customerAdmin: 404, customerDispatcher: 404, customerPassenger: 403, providerAdmin: 404, providerDispatcher: 404, fleetUser: 404, etmsOffCompany: 404, superAdmin: 404, superAdminSwitched: 404 };
const F_WRITE: RoleTable = { customerAdmin: 403, customerDispatcher: 403, customerPassenger: 403, providerAdmin: 403, providerDispatcher: 403, fleetUser: 200, etmsOffCompany: 404, superAdmin: 404, superAdminSwitched: 200 };
const F_WRITE_OTHER: RoleTable = { ...F_WRITE, fleetUser: 404, superAdminSwitched: 404 };

const PROJECTION: Partial<Record<MatrixRole, PassengerDto['projection']>> = {
  customerAdmin: 'FULL',
  superAdminSwitched: 'FULL',
  customerDispatcher: 'STANDARD',
  providerAdmin: 'MINIMAL',
  providerDispatcher: 'MINIMAL',
};

function fail(message: string): never {
  throw new Error(`isolation matrix: ${message}`);
}

/**
 * Detail of the party passenger: the projection of the role; the home address and point only for FULL (M3: a dispatcher
 * gets no home coordinates at all); consent records only for FULL (L4); login identifiers in clear only for FULL (L5).
 * The party passenger has no routing consent in the matrix world, so nobody gets a pickup point.
 */
function verifyDetail(result: unknown, role: MatrixRole, own: Ownership): void {
  if (own !== 'party') return;
  const p = result as PassengerDto;
  if (p.projection !== PROJECTION[role]) fail(`${role} got projection ${p.projection}`);
  const full = p.projection === 'FULL';
  const address = p.home?.address ?? null;
  if (full !== (address !== null)) fail(`${role} (${p.projection}) home address ${address === null ? 'missing' : 'leaked'}`);
  if (full !== (p.home?.lat != null && p.home?.lng != null)) fail(`${role} (${p.projection}) home coordinates ${full ? 'missing' : 'leaked'}`);
  if (p.pickup !== null) fail(`${role} got a pickup point without routing consent`);
  if (full !== (p.consents !== null)) fail(`${role} (${p.projection}) consent records ${full ? 'missing' : 'leaked'}`);
  if (p.appAccess && !full && (!p.appAccess.email?.includes('•') && p.appAccess.email !== null)) fail(`${role} sees the login email in clear`);
  if (p.projection === 'MINIMAL' && (p.home !== null || p.branchId !== null || p.appAccess !== null)) fail(`${role} MINIMAL leaks home / branch / login`);
}

/** List: the party passenger in the role's projection; never custB's; the one outside the agreement sites never for providers. */
function verifyList(result: unknown, role: MatrixRole, _own: Ownership, t: Target): void {
  const items = (result as { items: PassengerDto[] }).items;
  const ids = t.ids!;
  const party = items.find((i) => i.id === ids.partyPassenger);
  const want = PROJECTION[role];
  if ((party?.projection ?? undefined) !== want) fail(`${role} list: party passenger ${party ? party.projection : 'absent'}, expected ${want ?? 'absent'}`);
  if (items.some((i) => i.id === ids.otherPassenger)) fail(`${role} list shows another company's passenger`);
  const outside = items.some((i) => i.id === ids.outsideSitePassenger);
  if (outside !== (want === 'FULL' || want === 'STANDARD')) fail(`${role} list: passenger outside the agreement sites ${outside ? 'shown' : 'hidden'}`);
  if (items.some((i) => i.home?.address)) fail(`${role} list shows a home address`);
  // M3: list rows never carry coordinates of a home (or of a pickup), for any role; consent records only for FULL (L4);
  // login identifiers always masked (L5).
  if (items.some((i) => i.home?.lat != null || i.home?.lng != null || i.pickup !== null)) fail(`${role} list carries coordinates`);
  if (items.some((i) => i.projection !== 'FULL' && i.consents !== null)) fail(`${role} list carries consent records`);
  if (items.some((i) => i.appAccess?.email && !i.appAccess.email.includes('•'))) fail(`${role} list shows a login email in clear`);
}

/**
 * History (L12): MINIMAL never shows an actor, IP, home or contact field without the grant; STANDARD only profile
 * entries (no consent / login / notice entries, L4), no home fields, no IP; ACCESS rows only for FULL.
 */
const HOME_FIELD_KEYS = ['homeAddress', 'homeLat', 'homeLng', 'homeGeocodeSource', 'homeGeocodeConfidence', 'emergencyContacts'];
function verifyHistory(result: unknown, role: MatrixRole, own: Ownership): void {
  if (own !== 'party') return;
  const p = PROJECTION[role];
  for (const e of result as { entity: string; action: string; userId: string | null; userName: string | null; ip: string | null; changes: unknown }[]) {
    const keys = JSON.stringify(e.changes ?? {});
    if (p !== 'FULL' && e.action === 'ACCESS') fail(`${role} history shows read events`);
    if (p !== 'FULL' && e.entity !== 'EmployeeTransportProfile') fail(`${role} history shows ${e.entity} entries`);
    if (p !== 'FULL' && e.ip) fail(`${role} history shows an IP`);
    if (p !== 'FULL' && HOME_FIELD_KEYS.some((k) => keys.includes(`"${k}"`))) fail(`${role} history shows home fields`);
    if (p === 'MINIMAL' && (e.userId || e.userName)) fail(`${role} history shows the actor`);
    if (keys.includes('Secret Lane')) fail(`${role} history shows a home address`);
  }
}

/** Consent records (FULL only): rows of the party passenger only. */
function verifyConsents(result: unknown, role: MatrixRole, own: Ownership): void {
  if (own !== 'party') return;
  const r = result as { current: unknown[]; history: { id: string }[] };
  if (!Array.isArray(r.current) || !Array.isArray(r.history)) fail(`${role} consents: unexpected shape`);
}

/** Geocode (Photon, self-hosted only): candidates, never anything of a passenger. */
function verifyGeocode(result: unknown, role: MatrixRole): void {
  if (!Array.isArray(result)) fail(`${role} geocode: not a candidate list`);
}

/** Import report (L12): only the file's own values and the caller's company; never another tenant's data. */
function verifyImport(result: unknown, role: MatrixRole): void {
  const text = JSON.stringify(result);
  for (const leak of ['custB', 'b1.login@corp.test', 'Passenger B1', 'another company']) if (text.includes(leak)) fail(`${role} import report leaks "${leak}"`);
}

const CSV = 'employee_code,name,mobile\nM1,Matrix Import,9876500101\n';
const upload = () => ({ buffer: Buffer.from(CSV, 'utf8'), originalname: 'passengers.csv' });

function E2_MATRIX(): MatrixEntry[] {
  const P = 'passenger' as const;
  return [
    // ── Passengers: reads ──
    { route: 'GET transport/passengers', resource: P, state: 'ACTIVE', invoke: (c, ctx) => c.passengers.list(ctx, {}), expect: { none: P_LIST }, verify: verifyList },
    { route: 'GET transport/passengers/geocode', resource: P, state: 'ACTIVE', invoke: (c) => c.passengers.geocode({ q: '5 Main Road' }), expect: { none: P_GEOCODE }, verify: verifyGeocode },
    { route: 'GET transport/passengers/:id', resource: P, state: 'ACTIVE', invoke: (c, ctx, t) => c.passengers.get(ctx, t.id), expect: { party: P_READ, other: P_OTHER }, verify: verifyDetail },
    { route: 'GET transport/passengers/:id/history', resource: P, state: 'ACTIVE', invoke: (c, ctx, t) => c.passengers.history(ctx, t.id), expect: { party: P_READ, other: P_OTHER }, verify: verifyHistory },
    { route: 'GET transport/passengers/:id/consents', resource: P, state: 'ACTIVE', invoke: (c, ctx, t) => c.passengers.consents(ctx, t.id), expect: { party: P_FULL_ONLY, other: P_OTHER }, verify: verifyConsents },
    // ── Passengers: writes ──
    {
      route: 'POST transport/passengers',
      resource: P,
      state: 'ACTIVE',
      invoke: (c, ctx) => c.passengers.create(ctx, { employeeCode: 'NEW1', displayName: 'New Passenger', mobile: '9876500111' }),
      expect: { none: P_CREATE },
    },
    { route: 'PATCH transport/passengers/:id', resource: P, state: 'ACTIVE', invoke: (c, ctx, t) => c.passengers.update(ctx, t.id, { displayName: 'Renamed Passenger' }), expect: { party: P_EDIT, other: P_OTHER } },
    { route: 'DELETE transport/passengers/:id', resource: P, state: 'ACTIVE', invoke: (c, ctx, t) => c.passengers.archive(ctx, t.id), expect: { party: P_DELETE, other: P_DELETE_OTHER } },
    { route: 'POST transport/passengers/import/preview', resource: P, state: 'ACTIVE', invoke: (c, ctx) => c.passengers.preview(ctx, upload(), { geocode: 'false' }), expect: { none: P_CREATE }, verify: verifyImport },
    { route: 'POST transport/passengers/import/commit', resource: P, state: 'ACTIVE', invoke: (c, ctx) => c.passengers.commit(ctx, upload(), { geocode: 'false' }), expect: { none: P_CREATE }, verify: verifyImport },
    { route: 'POST transport/passengers/:id/app-access', resource: P, state: 'ACTIVE', invoke: (c, ctx, t) => c.passengers.grantAppAccess(ctx, t.id, {}), expect: { party: P_EDIT, other: P_OTHER } },
    { route: 'DELETE transport/passengers/:id/app-access', resource: P, state: 'ACTIVE', invoke: (c, ctx, t) => c.passengers.revokeAppAccess(ctx, t.id, {}), expect: { party: P_EDIT, other: P_OTHER } },
    // M1: the reset token is the only way to change the password of a used login; same scope as app access.
    { route: 'POST transport/passengers/:id/app-access/reset', resource: P, state: 'ACTIVE', invoke: (c, ctx, t) => c.passengers.resetAppAccess(ctx, t.id), expect: { party: P_EDIT, other: P_OTHER } },
    {
      // M2: a grant on the passenger's behalf is only a recorded offline consent (evidence + note); corporate admin only.
      route: 'POST transport/passengers/:id/consents',
      resource: P,
      state: 'ACTIVE',
      invoke: (c, ctx, t) => c.passengers.recordConsent(ctx, t.id, { purpose: 'TRANSPORT_PROFILE', granted: true, evidenceRef: 'FORM-7', note: 'Signed paper form' }),
      expect: { party: P_FULL_ONLY, other: P_OTHER },
    },
    {
      // M5: erase an archived passenger (archived first here); corporate admin only, like DELETE.
      route: 'POST transport/passengers/:id/erase',
      resource: P,
      state: 'ACTIVE',
      invoke: async (c, ctx, t) => {
        await c.passengers.archive(ctx, t.id).catch(() => undefined);
        return c.passengers.erase(ctx, t.id, { confirm: 'A1' });
      },
      expect: { party: P_DELETE, other: P_DELETE_OTHER },
    },
    // ── The passenger's own consent ──
    { route: 'GET me/transport/consent', resource: P, state: 'ACTIVE', invoke: (c, ctx) => c.myConsent.current(ctx), expect: { none: SELF } },
    { route: 'GET me/transport/consent/notices', resource: P, state: 'ACTIVE', invoke: (c, ctx) => c.myConsent.notices(ctx), expect: { none: SELF } },
    { route: 'GET me/transport/consent/history', resource: P, state: 'ACTIVE', invoke: (c, ctx) => c.myConsent.history(ctx), expect: { none: SELF } },
    { route: 'POST me/transport/consent', resource: P, state: 'ACTIVE', invoke: (c, ctx) => c.myConsent.record(ctx, { purpose: 'TRANSPORT_PROFILE', granted: true }), expect: { none: SELF } },
    { route: 'GET me/transport/notices', resource: P, state: 'ACTIVE', invoke: (c, ctx) => c.myConsent.inbox(ctx), expect: { none: SELF } },
    // ── Consent notices ──
    { route: 'GET transport/consent-notices', resource: P, state: 'ACTIVE', invoke: (c, ctx) => c.notices.list(ctx), expect: { none: N_READ } },
    {
      route: 'POST transport/consent-notices',
      resource: P,
      state: 'ACTIVE',
      invoke: (c, ctx) => c.notices.publish(ctx, { purpose: 'TRANSPORT_PROFILE', title: 'Transport data', body: 'We use your pickup point to plan trips.' }),
      expect: { none: N_PUBLISH },
    },
    // ── Vehicle seats ──
    { route: 'GET transport/vehicles', resource: 'vehicle', state: 'ACTIVE', invoke: (c, ctx) => c.vehicles.list(ctx, {}), expect: { none: F_LIST } },
    { route: 'GET transport/vehicles/:objectId/profile', resource: 'vehicle', state: 'ACTIVE', invoke: (c, ctx, t) => c.vehicles.get(ctx, t.id), expect: { party: F_READ, other: F_READ_OTHER } },
    { route: 'PUT transport/vehicles/:objectId/profile', resource: 'vehicle', state: 'ACTIVE', invoke: (c, ctx, t) => c.vehicles.put(ctx, t.id, { seats: 12, wheelchairSpaces: 1 }), expect: { party: F_WRITE, other: F_WRITE_OTHER } },
    // ── Driver logins ──
    { route: 'GET drivers/:id/login', resource: 'driver', state: 'ACTIVE', invoke: (c, ctx, t) => c.driverLogin.get(ctx, t.id), expect: { party: F_READ, other: F_READ_OTHER } },
    { route: 'POST drivers/:id/login', resource: 'driver', state: 'ACTIVE', invoke: (c, ctx, t) => c.driverLogin.grant(ctx, t.id, {}), expect: { party: F_WRITE, other: F_WRITE_OTHER } },
    { route: 'DELETE drivers/:id/login', resource: 'driver', state: 'ACTIVE', invoke: (c, ctx, t) => c.driverLogin.revoke(ctx, t.id, {}), expect: { party: F_WRITE, other: F_WRITE_OTHER } },
    { route: 'POST drivers/:id/login/reset', resource: 'driver', state: 'ACTIVE', invoke: (c, ctx, t) => c.driverLogin.reset(ctx, t.id), expect: { party: F_WRITE, other: F_WRITE_OTHER } },
  ];
}

/** Every ETMS route: E1a (agreements, directory, settings) and E2 (people). */
export const ISOLATION_MATRIX: MatrixEntry[] = [...E1A_MATRIX, ...E2_MATRIX()];
