import { randomUUID } from 'crypto';
import { REQUIRED_PERMISSIONS } from '../../access/decorators';
import type { AuthContext } from '../../access/auth-context';
import { agreementSiteScope } from '../../access/transport-scope';
import { AuditService } from '../../audit/audit.service';
import { CompanyDirectoryController } from '../directory/company-directory.controller';
import { TransportSettingsController } from '../settings/transport-settings.controller';
import { TransportFeatureGuard } from '../transport-feature.guard';
import { AgreementViewsService, classifyAgreementAudit } from './agreement-views.service';
import { AgreementsController } from './agreements.controller';
import { AgreementsService } from './agreements.service';

/**
 * E1a gap endpoints (sites, site picker, history, summary) against an in-memory store that evaluates the services'
 * Prisma where-clauses, with the real AgreementsService writing real AuditService rows, so history is built from the
 * same audit rows production writes.
 */
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
      return true;
    }
    return (v ?? null) === cond;
  });
}

const ON = { status: 'ACTIVE', settings: { features: ['etms', 'etmsProvider'] } };
const COMPANIES: Obj[] = [
  { id: 'platform', name: 'VeeTrax', isPlatform: true, accountType: 'BUSINESS', ...ON },
  { id: 'prov', name: 'Provider Co', isPlatform: false, accountType: 'BUSINESS', ...ON },
  { id: 'prov2', name: 'Other Provider', isPlatform: false, accountType: 'BUSINESS', ...ON },
  { id: 'custA', name: 'Customer A', isPlatform: false, accountType: 'BUSINESS', ...ON },
  { id: 'custB', name: 'Customer B', isPlatform: false, accountType: 'BUSINESS', ...ON },
];
const POIS: Obj[] = [
  { id: 'a-hq', companyId: 'custA', name: 'A Head office', isActive: true, branchId: null },
  { id: 'a-plant', companyId: 'custA', name: 'A Plant', isActive: true, branchId: 'br-north' },
  { id: 'a-secret', companyId: 'custA', name: 'A Secret lab', isActive: true, branchId: 'br-south' },
  { id: 'a-old', companyId: 'custA', name: 'A Old depot', isActive: false, branchId: null },
  { id: 'b-hq', companyId: 'custB', name: 'B Head office', isActive: true, branchId: null },
];
const BRANCHES: Record<string, string> = { 'br-north': 'North', 'br-south': 'South' };
const USERS: Obj[] = [
  { id: 'user-prov', name: 'Priya Provider', isSuperAdmin: false },
  { id: 'user-custA', name: 'Chandra Customer', isSuperAdmin: false },
  { id: 'user-platform', name: 'Sam Superadmin', isSuperAdmin: true },
];

function store() {
  const rows: Obj[] = [];
  const logs: Obj[] = [];
  const withNames = (r: Obj) => ({ ...r, provider: { name: COMPANIES.find((c) => c.id === r.providerCompanyId)?.name }, customer: { name: COMPANIES.find((c) => c.id === r.customerCompanyId)?.name } });
  const tsa = {
    findFirst: async ({ where }: { where: Obj }) => {
      const r = rows.find((x) => matches(x, where));
      return r ? withNames(r) : null;
    },
    findMany: async ({ where }: { where: Obj }) => rows.filter((x) => matches(x, where)).map(withNames),
    count: async ({ where }: { where: Obj }) => rows.filter((x) => matches(x, where)).length,
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => withNames(rows.find((x) => x.id === where.id)!),
    create: async ({ data }: { data: Obj }) => {
      const now = new Date();
      const r: Obj = { id: randomUUID(), status: 'DRAFT', version: 1, approvedByCustomerAt: null, approvedByCustomerUserId: null, approvedByProviderAt: null, approvedByProviderUserId: null, suspendedAt: null, endedAt: null, statusReason: null, createdAt: now, updatedAt: now, ...data };
      rows.push(r);
      return withNames(r);
    },
    updateMany: async ({ where, data }: { where: Obj; data: Obj }) => {
      const hit = rows.filter((x) => matches(x, where));
      for (const r of hit) {
        const { version, ...rest } = data;
        Object.assign(r, rest, { version: (r.version as number) + ((version as { increment: number }).increment ?? 0), updatedAt: new Date() });
      }
      return { count: hit.length };
    },
  };
  const prisma = {
    transportServiceAgreement: tsa,
    transportFleetAllocation: { deleteMany: async () => ({ count: 0 }), updateMany: async () => ({ count: 0 }) },
    company: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => COMPANIES.filter((c) => where.id.in.includes(c.id as string)) },
    poi: {
      count: async ({ where }: { where: Obj }) => POIS.filter((p) => matches(p, where)).length,
      findMany: async ({ where }: { where: Obj }) => POIS.filter((p) => matches(p, where)).map((p) => ({ ...p, branch: p.branchId ? { name: BRANCHES[p.branchId as string] } : null })),
    },
    user: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => USERS.filter((u) => where.id.in.includes(u.id as string)) },
    auditLog: {
      create: async ({ data }: { data: Obj }) => logs.push({ id: randomUUID(), createdAt: new Date(Date.now() + logs.length), ...data }),
      findMany: async ({ where }: { where: Obj }) => logs.filter((l) => matches(l, where)),
    },
    $transaction: async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as Promise<unknown>[])),
  };
  const svc = new AgreementsService(prisma as never, new AuditService(prisma as never), { invalidateCache: async () => undefined } as never);
  const views = new AgreementViewsService(prisma as never);
  return { svc, views, rows, logs, prisma };
}

const ALL = { etms_partners: ['view', 'create', 'edit'] };
const ctx = (companyId: string, opts: { superAdmin?: boolean; permissions?: Obj; dataScope?: string; branchIds?: string[] } = {}): AuthContext =>
  ({
    userId: opts.superAdmin ? 'user-platform' : `user-${companyId}`,
    homeCompanyId: opts.superAdmin ? 'platform' : companyId,
    companyId,
    isSuperAdmin: !!opts.superAdmin,
    permissions: opts.permissions ?? ALL,
    dataScope: opts.dataScope ?? 'COMPANY',
    branchIds: opts.branchIds ?? [],
    objectIds: [],
    ip: '10.0.0.1',
  }) as AuthContext;
const SA = ctx('platform', { superAdmin: true });
const draft = { providerCompanyId: 'prov', customerCompanyId: 'custA', validFrom: '2026-11-01T00:00:00Z', grants: ['VIEW_BOOKINGS' as const] };
const saDraft = { ...draft, reason: 'drafted for the customer (ticket 42)' };
const ver = (rows: Obj[], id: string) => rows.find((r) => r.id === id)!.version as number;
const status = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { getStatus(): number; getResponse(): { code?: string } }) => `${e.getStatus()} ${e.getResponse().code ?? ''}`.trim());

describe('GET /transport/agreements/:id/sites', () => {
  it('a provider sees only the names of the sites the agreement scopes, never other customer places', async () => {
    const { svc, views } = store();
    const a = await svc.create(ctx('custA'), { ...draft, siteIds: ['a-hq', 'a-plant'] });
    const res = await views.sites(ctx('prov'), a.id);
    expect(res).toEqual({ agreementId: a.id, allSites: false, sites: [{ id: 'a-hq', name: 'A Head office' }, { id: 'a-plant', name: 'A Plant' }], unavailableCount: 0 });
    expect(JSON.stringify(res)).not.toContain('Secret');
    expect(Object.keys(res.sites[0]).sort()).toEqual(['id', 'name']);
  });

  it('"all sites" (no site ids) lists nothing, so the provider never gets an enumeration of customer places', async () => {
    const { svc, views } = store();
    const a = await svc.create(ctx('custA'), draft);
    expect(await views.sites(ctx('prov'), a.id)).toEqual({ agreementId: a.id, allSites: true, sites: [], unavailableCount: 0 });
  });

  it('deactivated sites are counted, not named', async () => {
    const { svc, views, rows } = store();
    const a = await svc.create(ctx('custA'), { ...draft, siteIds: ['a-hq'] });
    rows[0].siteIds = ['a-hq', 'a-old'];
    expect(await views.sites(ctx('prov'), a.id)).toMatchObject({ sites: [{ id: 'a-hq', name: 'A Head office' }], unavailableCount: 1 });
  });

  it('cross-company: a non-party provider or customer gets 404; Super Admin on the platform sees them (PLAT)', async () => {
    const { svc, views } = store();
    const a = await svc.create(ctx('custA'), { ...draft, siteIds: ['a-hq'] });
    expect(await status(views.sites(ctx('prov2'), a.id))).toBe('404 NOT_FOUND');
    expect(await status(views.sites(ctx('custB'), a.id))).toBe('404 NOT_FOUND');
    expect(await status(views.sites(ctx('prov'), randomUUID()))).toBe('404 NOT_FOUND');
    expect((await views.sites(SA, a.id)).sites).toHaveLength(1);
    expect(await status(views.sites({ ...SA, companyId: 'custB' } as AuthContext, a.id))).toBe('404 NOT_FOUND');
  });

  it('agreementSiteScope: parties and platform only, de-duplicated, empty = all sites', () => {
    const a = { providerCompanyId: 'prov', customerCompanyId: 'custA', siteIds: ['x', 'x', 'y'] };
    expect(agreementSiteScope(ctx('prov'), a)).toEqual({ customerCompanyId: 'custA', siteIds: ['x', 'y'], allSites: false });
    expect(agreementSiteScope(ctx('prov2'), a)).toBeNull();
    expect(agreementSiteScope({ ...SA, companyId: 'custB' } as AuthContext, a)).toBeNull();
    expect(agreementSiteScope(SA, { ...a, siteIds: [] })).toMatchObject({ allSites: true, siteIds: [] });
  });
});

describe('GET /transport/agreements/site-options', () => {
  it('lists the caller’s own active places with branch names (no pois permission needed), never another company’s', async () => {
    const { views } = store();
    const opts = await views.siteOptions(ctx('custA', { permissions: { etms_partners: ['view', 'edit'] } }), undefined, 'custB');
    expect(opts.map((o) => o.id).sort()).toEqual(['a-hq', 'a-plant', 'a-secret']);
    expect(opts.find((o) => o.id === 'a-plant')).toEqual({ id: 'a-plant', name: 'A Plant', branchName: 'North' });
    expect((await views.siteOptions(ctx('prov'), undefined, 'custA')).length).toBe(0);
  });

  it('search by name; ASSIGNED users see their branches’ places plus company-wide ones', async () => {
    const { views } = store();
    expect((await views.siteOptions(ctx('custA'), 'plant', undefined)).map((o) => o.id)).toEqual(['a-plant']);
    const assigned = ctx('custA', { dataScope: 'ASSIGNED', branchIds: ['br-north'] });
    expect((await views.siteOptions(assigned, undefined, undefined)).map((o) => o.id).sort()).toEqual(['a-hq', 'a-plant']);
  });

  it('Super Admin on the platform names the customer company; without one it gets nothing', async () => {
    const { views } = store();
    expect(await views.siteOptions(SA, undefined, undefined)).toEqual([]);
    expect((await views.siteOptions(SA, undefined, 'custB')).map((o) => o.id)).toEqual(['b-hq']);
    const switched = { ...SA, companyId: 'custA' } as AuthContext;
    expect((await views.siteOptions(switched, undefined, 'custB')).map((o) => o.id)).toEqual(['b-hq']);
    expect((await views.siteOptions(switched, undefined, undefined)).map((o) => o.id).sort()).toEqual(['a-hq', 'a-plant', 'a-secret']);
  });
});

describe('GET /transport/agreements/:id/history', () => {
  async function flow() {
    const s = store();
    const a = await s.svc.create(ctx('prov'), draft);
    await s.svc.update(ctx('custA'), a.id, { grants: ['VIEW_BOOKINGS', 'VIEW_REPORTS'], siteIds: ['a-hq'] });
    await s.svc.propose(ctx('custA'), a.id);
    await s.svc.approve(ctx('custA'), a.id, ver(s.rows, a.id));
    await s.svc.approve(ctx('prov'), a.id, ver(s.rows, a.id));
    await s.svc.suspend(SA, a.id, 'platform hold');
    await s.svc.resume(ctx('custA'), a.id);
    await s.svc.end(ctx('prov'), a.id, 'contract over');
    return { ...s, a };
  }

  it('builds the full timeline from the audit log, oldest first', async () => {
    const { views, a } = await flow();
    const h = await views.history(SA, a.id);
    expect(h.map((e) => e.kind)).toEqual(['CREATED', 'EDITED', 'PROPOSED', 'APPROVED', 'APPROVED', 'SUSPENDED', 'RESUMED', 'ENDED']);
    expect(h[1].changedFields).toEqual(['grants', 'siteIds']);
    expect(h[4]).toMatchObject({ fromStatus: 'PROPOSED', toStatus: 'ACTIVE' });
    expect(h[5]).toMatchObject({ actorSide: 'PLATFORM', reason: 'platform hold' });
    expect(h[7]).toMatchObject({ actorSide: 'PROVIDER', reason: 'contract over' });
  });

  it('Super Admin on the platform sees every actor name', async () => {
    const { views, a } = await flow();
    const names = (await views.history(SA, a.id)).map((e) => e.actorName);
    expect(names).toEqual(['Priya Provider', 'Chandra Customer', 'Chandra Customer', 'Chandra Customer', 'Priya Provider', 'Sam Superadmin', 'Chandra Customer', 'Priya Provider']);
  });

  it('provider viewer: names of its own people only; the customer and the platform appear by side', async () => {
    const { views, a } = await flow();
    const h = await views.history(ctx('prov'), a.id);
    for (const e of h) {
      if (e.actorSide === 'PROVIDER') expect(e.actorName).toBe('Priya Provider');
      else expect(e.actorName).toBeNull();
    }
    expect(h.filter((e) => e.actorSide === 'CUSTOMER')).toHaveLength(4);
    expect(JSON.stringify(h)).not.toMatch(/Chandra|Sam Superadmin|10\.0\.0\.1|user-/);
  });

  it('customer viewer: same rule the other way round', async () => {
    const { views, a } = await flow();
    const h = await views.history(ctx('custA'), a.id);
    expect(h.filter((e) => e.actorName).every((e) => e.actorSide === 'CUSTOMER' && e.actorName === 'Chandra Customer')).toBe(true);
    expect(JSON.stringify(h)).not.toMatch(/Priya|Sam Superadmin/);
  });

  it('F2/F7: VeeTrax support switched into the customer company shows as "VeeTrax support" with its reason, never as a colleague', async () => {
    const s = store();
    const switched = { ...SA, companyId: 'custA' } as AuthContext;
    const a = await s.svc.create(switched, saDraft);
    await s.svc.update(switched, a.id, { grants: ['VIEW_REPORTS'], reason: 'customer asked by phone' });
    await s.svc.propose(switched, a.id, undefined, 'customer asked by phone');
    for (const viewer of [ctx('custA'), ctx('prov')]) {
      const h = await s.views.history(viewer, a.id);
      expect(h.map((e) => [e.kind, e.actorSide, e.actorName])).toEqual([
        ['CREATED', 'PLATFORM', null],
        ['EDITED', 'PLATFORM', null],
        ['PROPOSED', 'PLATFORM', null],
      ]);
      expect(h.map((e) => e.reason)).toEqual(['drafted for the customer (ticket 42)', 'customer asked by phone', 'customer asked by phone']);
      expect(JSON.stringify(h)).not.toContain('Sam Superadmin');
    }
    expect((await s.views.history(SA, a.id))[0].actorName).toBe('Sam Superadmin');
    // F7: the rows are in the customer's own audit log (companyId = customer), whichever company the Super Admin acted in.
    expect(s.logs.map((l) => l.companyId)).toEqual(['custA', 'custA', 'custA']);
    const fromPlatform = await s.svc.create(SA, { ...saDraft, providerCompanyId: 'prov2' });
    expect(s.logs.filter((l) => l.entityId === fromPlatform.id).map((l) => l.companyId)).toEqual(['custA']);
  });

  it('F2: old audit rows of a switched Super Admin (written as the customer, no reason) still show as VeeTrax support', async () => {
    const s = store();
    const a = await s.svc.create(ctx('custA'), draft);
    s.logs.push({ id: randomUUID(), createdAt: new Date(Date.now() + 1000), companyId: 'custA', userId: 'user-platform', action: 'UPDATE', entity: 'TransportServiceAgreement', entityId: a.id, changes: { status: { from: 'DRAFT', to: 'PROPOSED' } } });
    const h = await s.views.history(ctx('custA'), a.id);
    expect(h[1]).toMatchObject({ kind: 'PROPOSED', actorSide: 'PLATFORM', actorName: null });
  });

  it('cross-company: non-parties get 404', async () => {
    const { views, a } = await flow();
    expect(await status(views.history(ctx('prov2'), a.id))).toBe('404 NOT_FOUND');
    expect(await status(views.history(ctx('custB'), a.id))).toBe('404 NOT_FOUND');
  });

  it('classifyAgreementAudit handles odd rows', () => {
    expect(classifyAgreementAudit('ACCESS', {})).toBeNull();
    expect(classifyAgreementAudit('UPDATE', null)).toMatchObject({ kind: 'EDITED', changedFields: [] });
    expect(classifyAgreementAudit('UPDATE', { approvedByProviderAt: { from: null, to: 'x' } })).toMatchObject({ kind: 'APPROVED', toStatus: null });
    expect(classifyAgreementAudit('CREATE', { status: { from: null, to: 'DRAFT' } })).toMatchObject({ kind: 'CREATED', toStatus: 'DRAFT' });
  });
});

describe('GET /transport/agreements/summary', () => {
  it('counts per status over the caller’s agreements and the proposals awaiting its side', async () => {
    const { svc, views, rows } = store();
    const a = await svc.create(SA, saDraft);
    await svc.propose(SA, a.id, undefined, 'r');
    await svc.create(SA, { ...saDraft, providerCompanyId: 'prov2' });
    const c = await svc.create(SA, { ...saDraft, customerCompanyId: 'custB' });
    await svc.propose(SA, c.id, undefined, 'r');
    await svc.approve(ctx('custB'), c.id, ver(rows, c.id));

    const prov = await views.summary(ctx('prov'));
    expect(prov.byStatus).toEqual({ DRAFT: 0, PROPOSED: 2, ACTIVE: 0, SUSPENDED: 0, ENDED: 0 });
    expect(prov.total).toBe(2);
    expect(prov.awaitingMyApproval).toBe(2);
    expect(prov.awaiting.map((x) => x.counterpartyName).sort()).toEqual(['Customer A', 'Customer B']);

    const custA = await views.summary(ctx('custA'));
    expect(custA).toMatchObject({ total: 2, byStatus: { DRAFT: 1, PROPOSED: 1 }, awaitingMyApproval: 1, awaiting: [{ id: a.id, counterpartyName: 'Provider Co' }] });

    const custB = await views.summary(ctx('custB'));
    expect(custB).toMatchObject({ total: 1, awaitingMyApproval: 0, awaiting: [] }); // already approved its side
  });

  it('no edit permission or branch scope → nothing awaiting; Super Admin (also switched into a party) approves none', async () => {
    const { svc, views } = store();
    const a = await svc.create(SA, saDraft);
    await svc.propose(SA, a.id, undefined, 'r');
    expect(await views.summary(ctx('custA', { permissions: { etms_partners: ['view'] } }))).toMatchObject({ total: 1, awaitingMyApproval: 0, awaiting: [] });
    expect(await views.summary(ctx('custA', { dataScope: 'ASSIGNED' }))).toMatchObject({ total: 1, awaitingMyApproval: 0, awaiting: [] });
    expect(await views.summary({ ...SA, companyId: 'custA' } as AuthContext)).toMatchObject({ total: 1, awaitingMyApproval: 0 });
    await svc.create(SA, { ...saDraft, customerCompanyId: 'custB' });
    expect(await views.summary(SA)).toMatchObject({ total: 2, awaitingMyApproval: 0 });
    expect((await views.summary(ctx('prov2'))).total).toBe(0);
  });
});

describe('ETMS route completeness (doc 05 §1: every route has a permission and the feature gate)', () => {
  const controllers = [AgreementsController, CompanyDirectoryController, TransportSettingsController];
  it.each(controllers.map((c) => [c.name, c] as const))('%s', (_name, controller) => {
    const guards = Reflect.getMetadata('__guards__', controller) as unknown[];
    expect(guards).toContain(TransportFeatureGuard);
    const proto = controller.prototype as unknown as Record<string, unknown>;
    const handlers = Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor' && typeof proto[k] === 'function');
    expect(handlers.length).toBeGreaterThan(0);
    for (const h of handlers) expect([h, Reflect.getMetadata(REQUIRED_PERMISSIONS, proto[h] as object)]).toEqual([h, expect.any(Array)]);
  });

  it('new routes carry the agreed permissions', () => {
    const perm = (c: { prototype: object }, h: string) => Reflect.getMetadata(REQUIRED_PERMISSIONS, (c.prototype as Record<string, object>)[h]);
    expect(perm(CompanyDirectoryController, 'lookup')).toEqual([['etms_partners', 'create']]);
    expect(perm(AgreementsController, 'sites')).toEqual([['etms_partners', 'view']]);
    expect(perm(AgreementsController, 'history')).toEqual([['etms_partners', 'view']]);
    expect(perm(AgreementsController, 'summary')).toEqual([['etms_partners', 'view']]);
    expect(perm(AgreementsController, 'siteOptions')).toEqual([['etms_partners', 'edit'], ['etms_partners', 'create']]);
    expect(perm(TransportSettingsController, 'get')).toEqual([['etms_settings', 'view']]);
    expect(perm(TransportSettingsController, 'update')).toEqual([['etms_settings', 'edit']]);
  });
});
