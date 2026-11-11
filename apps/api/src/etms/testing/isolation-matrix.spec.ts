// E3 pulls PlannedTripsModule (routes.dto → @nestjs/mapped-types, an ESM-only package jest cannot load). The DTO
// classes are never validated here, so a minimal stand-in is enough.
jest.mock('@nestjs/mapped-types', () => ({ PartialType: (c: new () => object) => class extends c {} }));

import { randomUUID } from 'crypto';
import { HttpException, RequestMethod, StreamableFile, type ExecutionContext } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ETMS_DRIVER_ROLE_NAME, ETMS_PASSENGER_ROLE_NAME, ETMS_ROLE_TEMPLATES, SYSTEM_ROLES, withoutUnavailableMenus, type CompanyFeature, type PassengerDto, type PermissionMap } from '@veetracer/shared';
import { resolvePermissions } from '../../access/access-rules';
import type { AuthContext, TransportAgreementScope } from '../../access/auth-context';
import { REQUIRED_PERMISSIONS } from '../../access/decorators';
import { PermissionGuard } from '../../access/permission.guard';
import { AuditService } from '../../audit/audit.service';
import { companyFeatures } from '../../common/company-features';
import { AgreementViewsService } from '../agreements/agreement-views.service';
import { AgreementsController } from '../agreements/agreements.controller';
import { AgreementsService } from '../agreements/agreements.service';
import { CompanyDirectoryController } from '../directory/company-directory.controller';
import { CompanyDirectoryService } from '../directory/company-directory.service';
import { ensureEtmsRoleTemplates, templatePermissions } from '../etms-role-templates';
import { EtmsModule } from '../etms.module';
import { ConsentNoticeService } from '../people/consent-notice.service';
import { FleetLinksService } from '../people/fleet-links.service';
import { PassengerImportService } from '../people/passenger-import.service';
import { ConsentNoticesController, DriverLoginController, MyTransportConsentController, PassengersController, TransportVehiclesController } from '../people/people.controller';
import { PeopleService } from '../people/people.service';
import { TransportSettingsController } from '../settings/transport-settings.controller';
import { TransportSettingsService } from '../settings/transport-settings.service';
import { TransportFeatureGuard } from '../transport-feature.guard';
import { PlannedTripsService } from '../../planned-trips/planned-trips.service';
import { BookingGeneratorService } from '../dispatch/booking-generator.service';
import { BookingsService } from '../dispatch/bookings.service';
import { DispatchService } from '../dispatch/dispatch.service';
import { BookingsController, DispatchController, MyTransportTripsController, SchedulesController, ShiftsController, TransportTripsController } from '../dispatch/e3.controllers';
import { MeTransportService } from '../dispatch/me-transport.service';
import { SchedulesService } from '../dispatch/schedules.service';
import { TripLiveService } from '../dispatch/trip-live';
import { TripsService } from '../dispatch/trips.service';
import { E3_RESOURCES, e3Ids, seedE3, type E3Resource } from './isolation-matrix-e3';
import { ISOLATION_MATRIX, MATRIX_ROLES, type Controllers, type MatrixEntry, type MatrixRole, type Ownership, type Target } from './isolation-matrix';
import { MemoryStore } from './memory-store';

// ───────────────────────────── Route discovery (generic completeness guard) ─────────────────────────────

type Ctor = new (...args: never[]) => object;
interface DiscoveredRoute {
  key: string;
  controller: Ctor;
  handler: string;
}

const joinPath = (...parts: (string | undefined)[]) => parts.flatMap((p) => (p ?? '').split('/')).filter(Boolean).join('/');

/**
 * Every controller of EtmsModule AND of every module it imports, recursively (E2's EtmsPeopleModule, later phases'
 * modules): a sub-module must not be a way around the completeness guard. Dynamic modules ({ module }) and forwardRef
 * imports are followed too.
 */
export function etmsControllers(root: Ctor = EtmsModule): Ctor[] {
  const seen = new Set<unknown>();
  const out: Ctor[] = [];
  const visit = (m: unknown) => {
    if (m && typeof m === 'object' && 'forwardRef' in m) m = (m as { forwardRef: () => unknown }).forwardRef();
    if (m && typeof m === 'object' && 'module' in m) {
      const dyn = m as { module: Ctor; controllers?: Ctor[]; imports?: unknown[] };
      out.push(...(dyn.controllers ?? []));
      (dyn.imports ?? []).forEach(visit);
      m = dyn.module;
    }
    if (typeof m !== 'function' || seen.has(m)) return;
    seen.add(m);
    out.push(...((Reflect.getMetadata('controllers', m) ?? []) as Ctor[]));
    ((Reflect.getMetadata('imports', m) ?? []) as unknown[]).forEach(visit);
  };
  visit(root);
  return [...new Set(out)];
}

/** Every route of every ETMS controller (etmsControllers), read from Nest metadata (no hand-written list). */
function discoverEtmsRoutes(): DiscoveredRoute[] {
  const controllers = etmsControllers();
  const out: DiscoveredRoute[] = [];
  for (const controller of controllers) {
    const base = Reflect.getMetadata(PATH_METADATA, controller) as string | undefined;
    const proto = controller.prototype as Record<string, unknown>;
    for (const handler of Object.getOwnPropertyNames(proto)) {
      const fn = proto[handler];
      if (handler === 'constructor' || typeof fn !== 'function') continue;
      const path = Reflect.getMetadata(PATH_METADATA, fn) as string | undefined;
      const method = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
      if (path === undefined || method === undefined) continue;
      out.push({ key: `${RequestMethod[method]} ${joinPath(base, path)}`, controller, handler });
    }
  }
  return out;
}

// ───────────────────────────── In-memory store (evaluates the services' Prisma where-clauses) ─────────────────────────────

type Obj = Record<string, unknown>;
function matches(row: Obj, where: Obj | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'AND') return (cond as Obj[]).every((w) => matches(row, w));
    if (k === 'OR') return (cond as Obj[]).some((w) => matches(row, w));
    const v = row[k];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Obj;
      if ('in' in c) return (c.in as unknown[]).includes(v);
      if ('not' in c) return v !== c.not;
      if ('contains' in c) return String(v).toLowerCase().includes(String(c.contains).toLowerCase());
      return true; // JSON paths etc.: the services re-check those in code
    }
    return (v ?? null) === cond;
  });
}

const ETMS_ON = { features: ['etms'], etms: { directoryListed: true } };
const COMPANIES: Obj[] = [
  { id: 'platform', name: 'VeeTrax', isPlatform: true, accountType: 'BUSINESS', status: 'ACTIVE', settings: {} },
  { id: 'prov', name: 'Provider Co', isPlatform: false, accountType: 'BUSINESS', status: 'ACTIVE', settings: ETMS_ON },
  { id: 'prov2', name: 'Provider Two', isPlatform: false, accountType: 'BUSINESS', status: 'ACTIVE', settings: ETMS_ON },
  { id: 'custA', name: 'Customer A', isPlatform: false, accountType: 'BUSINESS', status: 'ACTIVE', settings: ETMS_ON },
  { id: 'custB', name: 'Customer B', isPlatform: false, accountType: 'BUSINESS', status: 'ACTIVE', settings: ETMS_ON },
  { id: 'off', name: 'GPS Only', isPlatform: false, accountType: 'BUSINESS', status: 'ACTIVE', settings: { features: [] } },
];

function buildApp() {
  const rows: Obj[] = [];
  const logs: Obj[] = [];
  const companies = COMPANIES.map((c) => structuredClone(c));
  const withNames = (r: Obj) => ({ ...r, provider: { name: companies.find((c) => c.id === r.providerCompanyId)?.name }, customer: { name: companies.find((c) => c.id === r.customerCompanyId)?.name } });
  const prisma: Obj = {
    transportServiceAgreement: {
      findFirst: async ({ where }: { where: Obj }) => {
        const r = rows.find((x) => matches(x, where));
        return r ? withNames(r) : null;
      },
      findMany: async ({ where }: { where: Obj }) => rows.filter((x) => matches(x, where)).map(withNames),
      count: async ({ where }: { where: Obj }) => rows.filter((x) => matches(x, where)).length,
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((x) => x.id === where.id) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => withNames(rows.find((x) => x.id === where.id)!),
      create: async ({ data }: { data: Obj }) => {
        const r: Obj = { id: randomUUID(), status: 'DRAFT', version: 1, approvedByCustomerAt: null, approvedByCustomerUserId: null, approvedByProviderAt: null, approvedByProviderUserId: null, suspendedAt: null, endedAt: null, statusReason: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        rows.push(r);
        return withNames(r);
      },
      updateMany: async ({ where, data }: { where: Obj; data: Obj }) => {
        const hit = rows.filter((x) => matches(x, where));
        for (const r of hit) {
          const { version, ...rest } = data;
          Object.assign(r, rest, { version: (r.version as number) + (version as { increment: number }).increment });
        }
        return { count: hit.length };
      },
    },
    company: {
      findMany: async ({ where }: { where: Obj }) => companies.filter((c) => matches(c, where)).map((c) => ({ ...c, billingProfile: null })),
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => companies.find((c) => c.id === where.id)!,
    },
    poi: { count: async () => 0, findMany: async () => [] },
    user: { findMany: async () => [] },
    auditLog: {
      create: async ({ data }: { data: Obj }) => logs.push({ id: randomUUID(), createdAt: new Date(), ...data }),
      findMany: async ({ where }: { where: Obj }) => logs.filter((l) => matches(l, where)),
    },
    $executeRaw: async () => 1,
  };
  prisma.$transaction = async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as Promise<unknown>[]));
  return { rows, controllers: controllersFor(prisma) };
}

/** The ETMS controllers wired to real services on `prisma` (geocoder off, Redis a no-op). */
function controllersFor(prisma: Obj): Controllers {
  const audit = new AuditService(prisma as never);
  const redis = {
    invalidateCache: async () => undefined,
    // E3: generator lock, rate limiter, live cache reads and the plannedTrip.update push (nothing is cached here).
    client: { get: async () => null, mget: async (...keys: string[]) => keys.map(() => null), set: async () => 'OK', eval: async () => 1, publish: async () => 1 },
  };
  const geocoding = { enabled: false, search: async () => [] };
  const notices = new ConsentNoticeService(prisma as never, audit);
  const people = new PeopleService(prisma as never, audit, redis as never, geocoding as never, notices);
  const fleet = new FleetLinksService(prisma as never, audit, redis as never);
  return {
    agreements: new AgreementsController(new AgreementsService(prisma as never, audit, redis as never), new AgreementViewsService(prisma as never)),
    directory: new CompanyDirectoryController(new CompanyDirectoryService(prisma as never, null as never, audit)),
    settings: new TransportSettingsController(new TransportSettingsService(prisma as never, audit)),
    passengers: new PassengersController(people, new PassengerImportService(prisma as never, audit, geocoding as never)),
    myConsent: new MyTransportConsentController(people),
    notices: new ConsentNoticesController(notices),
    vehicles: new TransportVehiclesController(fleet),
    driverLogin: new DriverLoginController(fleet),
    e3: e3Controllers(prisma, audit, redis, people),
  };
}

/** E3 controllers on the same store: routing off (no GraphHopper), processor cache invalidation a no-op. */
function e3Controllers(prisma: Obj, audit: AuditService, redis: object, people: PeopleService) {
  const plannedTrips = new PlannedTripsService(prisma as never, audit, { invalidate: async () => undefined } as never);
  const routing = { enabled: false, route: async () => null, routeVia: async () => null };
  const live = new TripLiveService(prisma as never, redis as never, plannedTrips);
  const generator = new BookingGeneratorService(prisma as never, redis as never);
  const schedules = new SchedulesService(prisma as never, audit, generator);
  const dispatch = new DispatchService(prisma as never, audit, routing as never, live, redis as never);
  return {
    shifts: new ShiftsController(schedules),
    schedules: new SchedulesController(schedules),
    bookings: new BookingsController(new BookingsService(prisma as never, audit, redis as never)),
    dispatch: new DispatchController(dispatch),
    trips: new TransportTripsController(new TripsService(prisma as never, audit, plannedTrips, dispatch, live), dispatch),
    meTrips: new MyTransportTripsController(new MeTransportService(prisma as never, people, redis as never)),
  };
}

// ───────────────────────────── E2 world (passengers, vehicles, drivers, logins) ─────────────────────────────

const DAY = 86_400_000;

/**
 * custA (customer) and custB (no agreement with anyone), each with a branch, office sites, a passenger, a vehicle and a
 * driver with a login; custA's passenger has the login of `customerPassenger` and a current consent notice. The
 * prov ↔ custA agreement is ACTIVE, grants VIEW_PASSENGER_MINIMAL and covers siteA1 only (a second custA passenger
 * at siteA2 is outside it). Rows go through the same Prisma calls the services make (MemoryStore).
 */
async function buildE2App() {
  const store = new MemoryStore();
  for (const c of COMPANIES) store.insert('company', { ...structuredClone(c), timezone: 'Asia/Kolkata' });
  const prisma = store.client();
  for (const companyId of ['custA', 'custB', 'prov']) await ensureEtmsRoleTemplates(prisma as never, companyId);
  const roleId = (companyId: string, name: string) => store.table('role').find((r) => r.companyId === companyId && r.name === name)!.id as string;
  for (const [id, companyId] of [['brA1', 'custA'], ['brB1', 'custB']]) store.insert('branch', { id, companyId, name: id, isActive: true });
  for (const [id, companyId] of [['siteA1', 'custA'], ['siteA2', 'custA'], ['siteB1', 'custB']]) store.insert('poi', { id, companyId, name: id, category: 'OFFICE', lat: 13.05, lng: 80.25, isActive: true });

  const login = (id: string, companyId: string, role: string, email: string) => {
    store.insert('user', { id, companyId, name: id, email });
    store.table('userRole').push({ userId: id, roleId: roleId(companyId, role) });
    return id;
  };
  const passenger = (companyId: string, code: string, branchId: string, officePoiId: string, userId: string | null) =>
    store.insert('employeeTransportProfile', {
      companyId,
      employeeCode: code,
      displayName: `Passenger ${code}`,
      branchId,
      officePoiId,
      userId,
      email: `${code.toLowerCase()}@corp.test`,
      mobile: `+9198765${code.replace(/\D/g, '').padStart(5, '0')}`,
      homeAddress: `${code} Secret Lane`,
      homeLat: 13.061234,
      homeLng: 80.241234,
      homeGeocodeSource: 'PIN',
    }).id as string;
  const partyPassenger = passenger('custA', 'A1', 'brA1', 'siteA1', login('user-customerPassenger', 'custA', ETMS_PASSENGER_ROLE_NAME, 'a1.login@corp.test'));
  const outsideSitePassenger = passenger('custA', 'A2', 'brA1', 'siteA2', null);
  const otherPassenger = passenger('custB', 'B1', 'brB1', 'siteB1', login('user-passengerB', 'custB', ETMS_PASSENGER_ROLE_NAME, 'b1.login@corp.test'));
  for (const companyId of ['custA', 'custB']) {
    store.insert('transportConsentNotice', { companyId, purpose: 'TRANSPORT_PROFILE', seq: 1, version: 'v1', title: 'Transport data', body: 'Pickup point for routing.', locale: 'en', effectiveFrom: new Date(Date.now() - DAY), createdById: null });
  }
  const vehicle = (companyId: string, branchId: string) => store.insert('trackedObject', { companyId, branchId, type: 'VEHICLE', name: `Van ${companyId}`, plateNumber: null, isActive: true }).id as string;
  const driver = (companyId: string, branchId: string, userId: string) => store.insert('driver', { companyId, branchId, name: `Driver ${companyId}`, mobile: null, isActive: true, userId }).id as string;
  const party: Record<'passenger' | 'vehicle' | 'driver', string> = {
    passenger: partyPassenger,
    vehicle: vehicle('custA', 'brA1'),
    driver: driver('custA', 'brA1', login('user-driverA', 'custA', ETMS_DRIVER_ROLE_NAME, 'driver.a@corp.test')),
  };
  const other: typeof party = {
    passenger: otherPassenger,
    vehicle: vehicle('custB', 'brB1'),
    driver: driver('custB', 'brB1', login('user-driverB', 'custB', ETMS_DRIVER_ROLE_NAME, 'driver.b@corp.test')),
  };
  const agreement = seed(store.table('transportServiceAgreement'), 'prov', 'custA', 'ACTIVE');
  Object.assign(agreement, { grants: ['VIEW_BOOKINGS', 'VIEW_PASSENGER_MINIMAL'], siteIds: ['siteA1'] });
  const scope: TransportAgreementScope = { id: agreement.id as string, customerCompanyId: 'custA', grants: ['VIEW_BOOKINGS', 'VIEW_PASSENGER_MINIMAL'], siteIds: ['siteA1'], dataProfile: 'MINIMAL', validFrom: Date.now() - DAY, validTo: null };
  return { store, controllers: controllersFor(prisma), party, other, scope, ids: { partyPassenger, otherPassenger, outsideSitePassenger } };
}

/** One agreement in `status` with consistent approvals (the DB CHECKs: ACTIVE / SUSPENDED only with both). */
function seed(rows: Obj[], providerCompanyId: string, customerCompanyId: string, status: string): Obj {
  const approved = ['ACTIVE', 'SUSPENDED'].includes(status);
  const r: Obj = {
    id: randomUUID(),
    providerCompanyId,
    customerCompanyId,
    status,
    version: 3,
    validFrom: new Date('2026-01-01T00:00:00Z'),
    validTo: null,
    grants: ['VIEW_BOOKINGS'],
    siteIds: [],
    dataProfile: 'MINIMAL',
    approvedByCustomerAt: approved ? new Date() : null,
    approvedByCustomerUserId: approved ? 'x' : null,
    approvedByProviderAt: approved ? new Date() : null,
    approvedByProviderUserId: approved ? 'y' : null,
    suspendedAt: status === 'SUSPENDED' ? new Date() : null,
    endedAt: null,
    statusReason: null,
    createdById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  rows.push(r);
  return r;
}

// ───────────────────────────── Callers ─────────────────────────────

/** A template as seeded now: the E1a permissions plus the menus later phases add (templatePermissions). */
const tpl = (name: string) => {
  const def = ETMS_ROLE_TEMPLATES.find((r) => r.name === name)!;
  return { ...def, permissions: templatePermissions(def.name, def.permissions) };
};
const grants = (p: PermissionMap) => Object.entries(p).map(([menu, actions]) => ({ menu, actions: [...(actions ?? [])] }));

/** E2 world: branch-scoped callers hold brA1; providers carry the prov ↔ custA agreement (as AuthContextService loads it). */
function caller(role: MatrixRole, e2?: { scope: TransportAgreementScope }): AuthContext {
  const def = {
    customerAdmin: { companyId: 'custA', role: tpl('Transport admin') },
    customerDispatcher: { companyId: 'custA', role: tpl('Transport dispatcher') },
    customerPassenger: { companyId: 'custA', role: tpl('Transport passenger') },
    providerAdmin: { companyId: 'prov', role: tpl('Transport admin') },
    providerDispatcher: { companyId: 'prov', role: tpl('Transport dispatcher') },
    fleetUser: { companyId: 'custA', role: SYSTEM_ROLES.find((r) => r.name === 'Manager')! },
    etmsOffCompany: { companyId: 'off', role: tpl('Transport admin') },
    superAdmin: { companyId: 'platform', role: null },
    superAdminSwitched: { companyId: 'custA', role: null },
  }[role];
  const isSuperAdmin = def.role === null;
  const resolved = resolvePermissions(def.role ? [{ dataScope: def.role.dataScope, permissions: grants(def.role.permissions) }] : [], isSuperAdmin);
  const features = companyFeatures(COMPANIES.find((c) => c.id === def.companyId) as { settings: unknown; isPlatform?: boolean }) as CompanyFeature[];
  return {
    userId: `user-${role}`,
    homeCompanyId: isSuperAdmin ? 'platform' : def.companyId,
    companyId: def.companyId,
    isSuperAdmin,
    isCompanyAdmin: isSuperAdmin,
    permissions: withoutUnavailableMenus(resolved.permissions, features),
    dataScope: resolved.dataScope,
    branchIds: e2 && resolved.dataScope === 'ASSIGNED' && def.companyId === 'custA' ? ['brA1'] : [],
    objectIds: [],
    features,
    agreements: e2 && def.companyId === 'prov' ? [e2.scope] : [],
    ip: null,
  };
}

// ───────────────────────────── Request pipeline (global PermissionGuard, then the controller's guards, then the handler) ─────────────────────────────

const permissionGuard = new PermissionGuard(new Reflector());
const featureGuard = new TransportFeatureGuard();

async function run(route: DiscoveredRoute, entry: MatrixEntry, ctx: AuthContext, target: Target, controllers: Controllers): Promise<{ status: number; result?: unknown }> {
  const handler = (route.controller.prototype as Record<string, object>)[route.handler];
  const exec = {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => route.controller,
    switchToHttp: () => ({ getRequest: () => ({ auth: ctx, method: route.key.split(' ')[0], query: {}, url: `/api/${route.key.split(' ')[1]}` }) }),
  } as unknown as ExecutionContext;
  try {
    permissionGuard.canActivate(exec);
    featureGuard.canActivate(exec);
    return { status: 200, result: await entry.invoke(controllers, ctx, target) };
  } catch (e) {
    if (e instanceof HttpException) return { status: e.getStatus() };
    throw e;
  }
}

/** The E3 id a resource's `Target.id` shows (informational; E3 entries read their ids from `Target.e3`). */
function resourceKey(r: E3Resource): 'shift' | 'schedule' | 'booking' | 'trip' | 'changeSet' {
  return r === 'myTrip' ? 'trip' : r === 'myBooking' ? 'booking' : r;
}

// ───────────────────────────── Generated tests ─────────────────────────────

const ROUTES = discoverEtmsRoutes();
const byRoute = new Map(ISOLATION_MATRIX.map((e) => [e.route, e]));

describe('ETMS isolation matrix: completeness guard (doc 11 §3.1)', () => {
  it('discovers the ETMS routes from Nest metadata', () => {
    // E1a: 16 routes; E2 (EtmsPeopleModule, imported): 29 (25 + security review: app-access reset, erase, notices, driver login reset); E3 (EtmsDispatchModule, imported): 41.
    expect(ROUTES.length).toBeGreaterThanOrEqual(86);
    for (const c of [ShiftsController, SchedulesController, BookingsController, DispatchController, TransportTripsController, MyTransportTripsController]) expect([c.name, ROUTES.some((r) => r.controller === c)]).toEqual([c.name, true]);
    for (const c of [PassengersController, MyTransportConsentController, ConsentNoticesController, TransportVehiclesController, DriverLoginController]) expect([c.name, ROUTES.some((r) => r.controller === c)]).toEqual([c.name, true]);
    expect(new Set(ROUTES.map((r) => r.key)).size).toBe(ROUTES.length);
  });

  it('every ETMS route has a matrix entry, and every entry a route (a new route must declare its policy)', () => {
    expect(ROUTES.map((r) => r.key).filter((k) => !byRoute.has(k))).toEqual([]);
    expect(ISOLATION_MATRIX.map((e) => e.route).filter((k) => !ROUTES.some((r) => r.key === k))).toEqual([]);
  });

  it('every entry covers every role, and routes with a path parameter cover both party and other-company ownership', () => {
    for (const e of ISOLATION_MATRIX) {
      const owners = Object.keys(e.expect) as Ownership[];
      expect([e.route, owners.length > 0]).toEqual([e.route, true]);
      if (/:\w+/.test(e.route)) expect([e.route, owners.sort()]).toEqual([e.route, ['other', 'party']]);
      for (const o of owners) expect([e.route, o, Object.keys(e.expect[o]!).sort()]).toEqual([e.route, o, [...MATRIX_ROLES].sort()]);
    }
  });

  it('every ETMS controller carries the feature gate and every handler a permission', () => {
    for (const r of ROUTES) {
      expect([r.key, (Reflect.getMetadata('__guards__', r.controller) as unknown[] | undefined)?.includes(TransportFeatureGuard)]).toEqual([r.key, true]);
      const handler = (r.controller.prototype as Record<string, object>)[r.handler];
      expect([r.key, Array.isArray(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler))]).toEqual([r.key, true]);
    }
  });
});

const CASES: [string, MatrixRole, Ownership, Expected][] = [];
type Expected = 200 | 403 | 404;
for (const e of ISOLATION_MATRIX) {
  for (const [own, table] of Object.entries(e.expect) as [Ownership, Record<MatrixRole, Expected>][]) {
    for (const role of MATRIX_ROLES) CASES.push([e.route, role, own, table[role]]);
  }
}

describe('ETMS isolation matrix: route × role × ownership', () => {
  it.each(CASES)('%s as %s on %s resource → %s', async (routeKey, role, own, expected) => {
    const entry = byRoute.get(routeKey)!;
    const route = ROUTES.find((r) => r.key === routeKey)!;
    if (entry.resource && (E3_RESOURCES as readonly string[]).includes(entry.resource)) {
      const w = await buildE2App();
      const world = seedE3(w.store, { party: { passenger: w.party.passenger, vehicle: w.party.vehicle, driver: w.party.driver }, other: { passenger: w.other.passenger, vehicle: w.other.vehicle, driver: w.other.driver } });
      const ids = e3Ids(world, own);
      const target: Target = { id: ids[resourceKey(entry.resource as E3Resource)], version: 1, providerCompanyId: 'prov', customerCompanyId: 'custA', ids: w.ids, e3: { ids, world } };
      entry.prepare?.(w.store, target);
      const res = await run(route, entry, caller(role, w), target, w.controllers);
      expect(res.status).toBe(expected);
      if (res.status === 200) entry.verify?.(res.result, role, own, target);
      return;
    }
    if (entry.resource && entry.resource !== 'agreement') {
      const w = await buildE2App();
      const resource = entry.resource;
      const id = own === 'party' ? w.party[resource as 'passenger'] : own === 'other' ? w.other[resource as 'passenger'] : randomUUID();
      const target: Target = { id, version: 1, providerCompanyId: 'prov', customerCompanyId: 'custA', ids: w.ids };
      const res = await run(route, entry, caller(role, w), target, w.controllers);
      expect(res.status).toBe(expected);
      if (res.status === 200) entry.verify?.(res.result, role, own, target);
      return;
    }
    const { rows, controllers } = buildApp();
    let target: Target = { id: randomUUID(), version: 1, providerCompanyId: 'prov', customerCompanyId: 'custA' };
    if (entry.state !== 'none') {
      const party = seed(rows, 'prov', 'custA', entry.state);
      const other = seed(rows, 'prov2', 'custB', entry.state);
      const t = own === 'other' ? other : party;
      target = { id: t.id as string, version: t.version as number, providerCompanyId: 'prov', customerCompanyId: 'custA' };
    } else if (own === 'other') {
      target = { ...target, providerCompanyId: 'prov2', customerCompanyId: 'custB' };
    }
    const res = await run(route, entry, caller(role), target, controllers);
    expect(res.status).toBe(expected);
    if (res.status === 200) entry.verify?.(res.result, role, own, target);
  });
});

// ───────────────────────────── Leak checks beyond list and detail (security review L12, M2, M3, M4) ─────────────────────────────

const csvText = async (f: unknown): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const c of (f as StreamableFile).getStream()) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
};
type Dto = PassengerDto;
const auditsOf = (w: Awaited<ReturnType<typeof buildE2App>>, companyId: string) => w.store.table('auditLog').filter((a) => a.companyId === companyId);

describe('ETMS isolation matrix: export, history, consents, pickup, import report, geocode', () => {
  it('CSV export (M4): a provider exports none of the customer’s passengers; a dispatcher’s export has no home address or point', async () => {
    const w = await buildE2App();
    const provider = await csvText(await w.controllers.passengers.list(caller('providerAdmin', w), { format: 'csv' } as never));
    expect(provider).not.toContain('A1');
    expect(provider.trim().split('\n')).toHaveLength(1); // header only
    const dispatcher = await csvText(await w.controllers.passengers.list(caller('customerDispatcher', w), { format: 'csv' } as never));
    expect(dispatcher).toContain('A1');
    expect(dispatcher).not.toContain('Secret Lane');
    expect(dispatcher).not.toContain('13.06');
    expect(dispatcher).not.toContain('B1');
    const admin = await csvText(await w.controllers.passengers.list(caller('customerAdmin', w), { format: 'csv' } as never));
    expect(admin).toContain('A1 Secret Lane');
  });

  it('provider reads (M4): a JSON list page with the customer’s passengers is ACCESS-audited in the customer’s log', async () => {
    const w = await buildE2App();
    await w.controllers.passengers.list(caller('providerAdmin', w), {} as never);
    const entry = auditsOf(w, 'custA').find((a) => a.action === 'ACCESS' && (a.changes as { what?: string }).what === 'list');
    expect(entry).toMatchObject({ userId: 'user-providerAdmin', changes: expect.objectContaining({ projection: 'MINIMAL', rows: 1, actingCompanyId: 'prov' }) });
    expect(auditsOf(w, 'prov').some((a) => a.action === 'ACCESS')).toBe(false);
  });

  it('pickup (M3): only with the passenger’s own routing consent, on the detail view; dispatchers never get the home point', async () => {
    const w = await buildE2App();
    const id = w.ids.partyPassenger;
    for (const role of ['customerDispatcher', 'providerAdmin'] as const) expect((await w.controllers.passengers.get(caller(role, w), id)).pickup).toBeNull();
    await w.controllers.myConsent.record(caller('customerPassenger', w), { purpose: 'TRANSPORT_PROFILE', granted: true });
    const disp = await w.controllers.passengers.get(caller('customerDispatcher', w), id);
    expect(disp.pickup).toEqual({ kind: 'HOME', lat: 13.0612, lng: 80.2412, label: null, poiId: null });
    expect(disp.home).toMatchObject({ address: null, lat: null, lng: null });
    expect((await w.controllers.passengers.get(caller('providerAdmin', w), id)).pickup).toMatchObject({ lat: 13.0612 });
    for (const role of ['customerAdmin', 'customerDispatcher', 'providerAdmin'] as const) {
      const rows = ((await w.controllers.passengers.list(caller(role, w), {} as never)) as { items: Dto[] }).items;
      expect(rows.every((r) => r.pickup === null && r.home?.lat == null)).toBe(true);
    }
    // The admin's detail read of the home point is ACCESS-audited and says so.
    await w.controllers.passengers.get(caller('customerAdmin', w), id);
    expect(auditsOf(w, 'custA').some((a) => a.action === 'ACCESS' && (a.changes as { homeLocation?: boolean }).homeLocation === true)).toBe(true);
  });

  it('consent on behalf (M2): the admin may withdraw or record an offline consent with evidence; history and notices show it', async () => {
    const w = await buildE2App();
    const id = w.ids.partyPassenger;
    const admin = caller('customerAdmin', w);
    await expect(w.controllers.passengers.recordConsent(admin, id, { purpose: 'TRANSPORT_PROFILE', granted: true })).rejects.toMatchObject({ status: 403, response: { code: 'CONSENT_SELF_ONLY' } });
    const granted = await w.controllers.passengers.recordConsent(admin, id, { purpose: 'TRANSPORT_PROFILE', granted: true, evidenceRef: 'FORM-12', note: 'Signed at onboarding' });
    expect(granted.history.find((h) => h.granted)).toMatchObject({ channel: 'ADMIN_RECORDED_OFFLINE', evidenceRef: 'FORM-12', note: 'Signed at onboarding' });
    const withdrawn = await w.controllers.passengers.recordConsent(admin, id, { purpose: 'TRANSPORT_PROFILE', granted: false });
    expect(withdrawn.history.find((h) => !h.granted)).toMatchObject({ channel: 'ADMIN_ON_BEHALF', evidenceRef: null, note: null });
    expect(withdrawn.current.find((c) => c.purpose === 'TRANSPORT_PROFILE')?.active).toBe(false);
    const inbox = await w.controllers.myConsent.inbox(caller('customerPassenger', w));
    expect(inbox.map((n) => n.kind).sort()).toEqual(['CONSENT_RECORDED_OFFLINE', 'CONSENT_WITHDRAWN_BY_ADMIN']);
    expect(inbox.every((n) => n.channel === 'IN_APP')).toBe(true);
    // History: the admin sees consent and notice entries; the dispatcher and the provider see none of them (L4).
    const adminHistory = await w.controllers.passengers.history(admin, id);
    expect(adminHistory.some((e) => e.entity === 'EmployeeTransportConsent')).toBe(true);
    expect(adminHistory.some((e) => e.entity === 'TransportPassengerNotice')).toBe(true);
    for (const role of ['customerDispatcher', 'providerAdmin'] as const) {
      const h = await w.controllers.passengers.history(caller(role, w), id);
      expect(h.every((e) => e.entity === 'EmployeeTransportProfile')).toBe(true);
      verifyNoConsentDetail(await w.controllers.passengers.get(caller(role, w), id));
    }
  });

  it('import report (L12): never names another tenant, even when a contact belongs to another company’s login', async () => {
    const w = await buildE2App();
    const file = { buffer: Buffer.from('employee_code,name,email\nM9,Probe Person,b1.login@corp.test\n', 'utf8'), originalname: 'p.csv' };
    const report = await w.controllers.passengers.preview(caller('customerAdmin', w), file, { geocode: 'false' });
    const text = JSON.stringify(report);
    for (const leak of ['custB', 'Passenger B1', 'another company']) expect(text).not.toContain(leak);
  });

  it('geocode (L11): refused with GEOCODER_NOT_PRIVATE when GEOCODER_URL is a public host; nothing is sent', async () => {
    const w = await buildE2App();
    const saved = { g: process.env.GEOCODER, u: process.env.GEOCODER_URL };
    try {
      process.env.GEOCODER = 'photon';
      process.env.GEOCODER_URL = 'https://photon.komoot.io';
      await expect(w.controllers.passengers.geocode({ q: '5 Main Road' })).rejects.toMatchObject({ status: 503, response: { code: 'GEOCODER_NOT_PRIVATE' } });
      process.env.GEOCODER_URL = 'http://127.0.0.1:2322';
      await expect(w.controllers.passengers.geocode({ q: '5 Main Road' })).resolves.toEqual([]);
    } finally {
      if (saved.g === undefined) delete process.env.GEOCODER;
      else process.env.GEOCODER = saved.g;
      if (saved.u === undefined) delete process.env.GEOCODER_URL;
      else process.env.GEOCODER_URL = saved.u;
    }
  });
});

function verifyNoConsentDetail(p: PassengerDto): void {
  expect(p.consents).toBeNull();
}

// ───────────────────────────── E3 leak checks (E2 security-fix precedence: M2, M3, M4, M5; self view, vehicle window) ─────────────────────────────

async function e3World() {
  const w = await buildE2App();
  const world = seedE3(w.store, { party: { passenger: w.party.passenger, vehicle: w.party.vehicle, driver: w.party.driver }, other: { passenger: w.other.passenger, vehicle: w.other.vehicle, driver: w.other.driver } });
  /** Append a consent row for custA's passenger (newest wins). */
  const consent = (granted: boolean, channel: string, extra: Obj = {}) =>
    w.store.insert('employeeTransportConsent', { companyId: 'custA', profileId: w.party.passenger, purpose: 'TRANSPORT_PROFILE', noticeVersion: 'v1', granted, channel, occurredAt: new Date(Date.now() + w.store.table('employeeTransportConsent').length), ...extra });
  return { ...w, world, consent };
}
const passengerB = (): AuthContext => ({ ...caller('customerPassenger'), userId: 'user-passengerB', homeCompanyId: 'custB', companyId: 'custB' });
const codeOf = async (p: Promise<unknown>) => p.then(() => 'OK', (e: HttpException) => (e.getResponse() as { code?: string }).code ?? String(e.getStatus()));

describe('ETMS isolation matrix (E3): bookings export, consent gating, self view, vehicle window, erasure', () => {
  it('bookings CSV (M3 / M4): labels only, no coordinates; only the caller’s own company’s rows (a provider exports none)', async () => {
    const w = await e3World();
    const own = await csvText(await w.controllers.e3.bookings.list(caller('customerAdmin', w), { format: 'csv' } as never));
    expect(own.trim().split('\n')).toHaveLength(3); // header + custA's two bookings
    expect(own).toContain('A1');
    for (const leak of ['13.06', '80.24', 'B1']) expect(own).not.toContain(leak);
    const provider = await csvText(await w.controllers.e3.bookings.list(caller('providerAdmin', w), { format: 'csv' } as never));
    expect(provider.trim().split('\n')).toHaveLength(1);
  });

  it('consent (M2 final model): withdrawn, or an on-behalf "grant", hides the pickup and blocks assignment; a recorded offline consent counts', async () => {
    const w = await e3World();
    const disp = caller('customerDispatcher', w);
    const add = () =>
      w.controllers.e3.dispatch.submit(disp, { serviceDate: w.world.tomorrow, direction: 'IN', expectedVersions: { [w.world.party.trip]: 1 }, changes: [{ op: 'ADD_PASSENGER', tripId: w.world.party.trip, bookingId: w.world.party.booking, pickupSeq: 0, dropSeq: 1 }] }, `k-${randomUUID()}`);
    const queueEntry = async () => (await w.controllers.e3.dispatch.board(disp, { serviceDate: w.world.tomorrow })).queue.find((b) => b.id === w.world.party.booking)!;
    // Make the open booking an IN booking on the trip's direction (seeded as OUT) so ADD_PASSENGER only trips on consent.
    Object.assign(w.store.table('transportBooking').find((b) => b.id === w.world.party.booking)!, { direction: 'IN' });
    w.store.table('transportBooking').find((b) => b.id === w.world.party.seatedBooking)!.status = 'CANCELLED';
    Object.assign(w.store.table('transportTripPassenger').find((p) => p.id === w.world.party.passengerTrip)!, { status: 'CANCELLED' });
    Object.assign(w.store.table('transportTrip').find((t) => t.id === w.world.party.trip)!, { occupiedSeats: 0 });

    w.consent(false, 'ADMIN_ON_BEHALF');
    expect(await queueEntry()).toMatchObject({ pickup: null, pointsHidden: 'CONSENT_REQUIRED', needsLocation: false });
    expect((await w.controllers.e3.dispatch.candidates(disp, { bookingIds: [w.world.party.booking] })).candidates.every((c) => c.reasons.includes('CONSENT_REQUIRED'))).toBe(true);
    expect(await codeOf(add())).toBe('CONSENT_REQUIRED');
    // A legacy / forged on-behalf grant (the DB CHECK refuses it; the service must not trust it either).
    w.consent(true, 'ADMIN_ON_BEHALF');
    expect(await codeOf(add())).toBe('CONSENT_REQUIRED');
    // An offline consent recorded with evidence is a valid grant (E2 M2).
    w.consent(true, 'ADMIN_RECORDED_OFFLINE', { evidenceRef: 'FORM-7', note: 'Signed form' });
    expect((await queueEntry()).pickup).toMatchObject({ lat: 13.06, lng: 80.24 });
    expect(await codeOf(add())).toBe('OK');
  });

  it('self view: another company’s passenger gets 404 for A’s trip, booking and vehicle; lists show only their own rows', async () => {
    const w = await e3World();
    const b = passengerB();
    for (const call of [() => w.controllers.e3.meTrips.trip(b, w.world.party.trip), () => w.controllers.e3.meTrips.vehicle(b, w.world.party.trip), () => w.controllers.e3.meTrips.booking(b, w.world.party.seatedBooking)]) expect(await codeOf(call())).toBe('NOT_FOUND');
    const trips = await w.controllers.e3.meTrips.trips(b, {});
    expect(trips.map((t) => t.id)).toEqual([w.world.other.trip]);
    expect(JSON.stringify(trips)).not.toContain(w.world.party.passenger);
    const mine = await w.controllers.e3.meTrips.bookings(b, {});
    expect(mine.every((x) => x.id === w.world.other.booking || x.id === w.world.other.seatedBooking)).toBe(true);
  });

  it('vehicle (10 §4.3): visible only inside the trip window, from the live cache; never outside it', async () => {
    const w = await e3World();
    const prisma = w.store.client();
    const audit = new AuditService(prisma as never);
    const live = JSON.stringify({ lat: 13.07, lng: 80.26, course: 90, speedKph: 30, fixTime: new Date().toISOString(), licenceLocked: false });
    const redis = { invalidateCache: async () => undefined, client: { get: async () => live } };
    const people = new PeopleService(prisma as never, audit, redis as never, { enabled: false, search: async () => [] } as never, new ConsentNoticeService(prisma as never, audit));
    const me = new MyTransportTripsController(new MeTransportService(prisma as never, people, redis as never));
    const pass = caller('customerPassenger', w);
    expect(await me.vehicle(pass, w.world.party.trip)).toEqual({ visible: false, reason: 'OUTSIDE_WINDOW' }); // tomorrow
    const pt = w.store.table('plannedTrip').find((p) => p.id === w.world.party.plannedTrip)!;
    Object.assign(pt, { plannedStart: new Date(Date.now() + 20 * 60_000), plannedEnd: new Date(Date.now() + 80 * 60_000) });
    expect(await me.vehicle(pass, w.world.party.trip)).toMatchObject({ visible: true, lat: 13.07, lng: 80.26 });
    Object.assign(pt, { status: 'COMPLETED', actualEnd: new Date(Date.now() - 11 * 60_000), plannedStart: new Date(Date.now() - 2 * 3_600_000), plannedEnd: new Date(Date.now() - 3_600_000) });
    expect(await me.vehicle(pass, w.world.party.trip)).toEqual({ visible: false, reason: 'OUTSIDE_WINDOW' });
  });

  it('erasure (M5) reaches E3: refused while a booking is open; afterwards the booking’s personal point is coarsened and its label removed', async () => {
    const w = await e3World();
    const admin = caller('customerAdmin', w);
    const id = w.party.passenger;
    Object.assign(w.store.table('employeeTransportProfile').find((p) => p.id === id)!, { isActive: false });
    expect(await codeOf(w.controllers.passengers.erase(admin, id, { confirm: 'A1' }))).toBe('INVALID_STATE');
    for (const b of w.store.table('transportBooking').filter((x) => x.profileId === id)) Object.assign(b, { status: 'CANCELLED', pickupLat: 13.061234, pickupLng: 80.241234, pickupLabel: '5 Secret Lane' });
    Object.assign(w.store.table('plannedTripStop').find((s) => s.tripId === w.world.party.plannedTrip && s.seq === 0)!, { lat: 13.061234, lng: 80.241234 });
    await w.controllers.passengers.erase(admin, id, { confirm: 'A1' });
    const rows = w.store.table('transportBooking').filter((x) => x.profileId === id);
    expect(rows.map((r) => [r.pickupLat, r.pickupLng, r.pickupLabel])).toEqual(rows.map(() => [13.06, 80.24, null]));
    expect(w.store.table('plannedTripStop').find((s) => s.seq === 0 && s.tripId === w.world.party.plannedTrip)).toMatchObject({ name: '[erased]', lat: 13.06 });
  });
});
