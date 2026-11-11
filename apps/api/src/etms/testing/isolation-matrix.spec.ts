import { randomUUID } from 'crypto';
import { HttpException, RequestMethod, type ExecutionContext } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ETMS_ROLE_TEMPLATES, SYSTEM_ROLES, withoutUnavailableMenus, type CompanyFeature, type PermissionMap } from '@veetracer/shared';
import { resolvePermissions } from '../../access/access-rules';
import type { AuthContext } from '../../access/auth-context';
import { REQUIRED_PERMISSIONS } from '../../access/decorators';
import { PermissionGuard } from '../../access/permission.guard';
import { AuditService } from '../../audit/audit.service';
import { companyFeatures } from '../../common/company-features';
import { AgreementViewsService } from '../agreements/agreement-views.service';
import { AgreementsController } from '../agreements/agreements.controller';
import { AgreementsService } from '../agreements/agreements.service';
import { CompanyDirectoryController } from '../directory/company-directory.controller';
import { CompanyDirectoryService } from '../directory/company-directory.service';
import { EtmsModule } from '../etms.module';
import { TransportSettingsController } from '../settings/transport-settings.controller';
import { TransportSettingsService } from '../settings/transport-settings.service';
import { TransportFeatureGuard } from '../transport-feature.guard';
import { ISOLATION_MATRIX, MATRIX_ROLES, type Controllers, type MatrixEntry, type MatrixRole, type Ownership, type Target } from './isolation-matrix';

// ───────────────────────────── Route discovery (generic completeness guard) ─────────────────────────────

type Ctor = new (...args: never[]) => object;
interface DiscoveredRoute {
  key: string;
  controller: Ctor;
  handler: string;
}

const joinPath = (...parts: (string | undefined)[]) => parts.flatMap((p) => (p ?? '').split('/')).filter(Boolean).join('/');

/** Every route of every controller registered in EtmsModule, read from Nest metadata (no hand-written list). */
function discoverEtmsRoutes(): DiscoveredRoute[] {
  const controllers = (Reflect.getMetadata('controllers', EtmsModule) ?? []) as Ctor[];
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
  const audit = new AuditService(prisma as never);
  const redis = { invalidateCache: async () => undefined };
  const controllers: Controllers = {
    agreements: new AgreementsController(new AgreementsService(prisma as never, audit, redis as never), new AgreementViewsService(prisma as never)),
    directory: new CompanyDirectoryController(new CompanyDirectoryService(prisma as never, null as never, audit)),
    settings: new TransportSettingsController(new TransportSettingsService(prisma as never, audit)),
  };
  return { rows, controllers };
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

const tpl = (name: string) => ETMS_ROLE_TEMPLATES.find((r) => r.name === name)!;
const grants = (p: PermissionMap) => Object.entries(p).map(([menu, actions]) => ({ menu, actions: [...(actions ?? [])] }));

function caller(role: MatrixRole): AuthContext {
  const def = {
    customerAdmin: { companyId: 'custA', role: tpl('Transport admin') },
    customerDispatcher: { companyId: 'custA', role: tpl('Transport dispatcher') },
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
    branchIds: [],
    objectIds: [],
    features,
    agreements: [],
    ip: null,
  };
}

// ───────────────────────────── Request pipeline (global PermissionGuard, then the controller's guards, then the handler) ─────────────────────────────

const permissionGuard = new PermissionGuard(new Reflector());
const featureGuard = new TransportFeatureGuard();

async function run(route: DiscoveredRoute, entry: MatrixEntry, ctx: AuthContext, target: Target, controllers: Controllers): Promise<number> {
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
    await entry.invoke(controllers, ctx, target);
    return 200;
  } catch (e) {
    if (e instanceof HttpException) return e.getStatus();
    throw e;
  }
}

// ───────────────────────────── Generated tests ─────────────────────────────

const ROUTES = discoverEtmsRoutes();
const byRoute = new Map(ISOLATION_MATRIX.map((e) => [e.route, e]));

describe('ETMS isolation matrix: completeness guard (doc 11 §3.1)', () => {
  it('discovers the ETMS routes from Nest metadata', () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(16);
    expect(new Set(ROUTES.map((r) => r.key)).size).toBe(ROUTES.length);
  });

  it('every ETMS route has a matrix entry, and every entry a route (a new route must declare its policy)', () => {
    expect(ROUTES.map((r) => r.key).filter((k) => !byRoute.has(k))).toEqual([]);
    expect(ISOLATION_MATRIX.map((e) => e.route).filter((k) => !ROUTES.some((r) => r.key === k))).toEqual([]);
  });

  it('every entry covers every role, and :id routes cover both party and other-company ownership', () => {
    for (const e of ISOLATION_MATRIX) {
      const owners = Object.keys(e.expect) as Ownership[];
      expect([e.route, owners.length > 0]).toEqual([e.route, true]);
      if (e.route.includes(':id')) expect([e.route, owners.sort()]).toEqual([e.route, ['other', 'party']]);
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
    expect(await run(route, entry, caller(role), target, controllers)).toBe(expected);
  });
});
