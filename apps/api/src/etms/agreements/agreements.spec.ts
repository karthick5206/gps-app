import { randomUUID } from 'crypto';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthContext } from '../../access/auth-context';
import { AgreementsService } from './agreements.service';

/**
 * Agreement API rules against an in-memory store that evaluates the service's Prisma where-clauses
 * (AND / OR / equality / in / not), so cross-company visibility is tested on the real queries.
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
      return true;
    }
    return v === cond;
  });
}

const COMPANIES: Obj[] = [
  { id: 'platform', name: 'VeeTrax', isPlatform: true, accountType: 'BUSINESS' },
  { id: 'prov', name: 'Provider Co', isPlatform: false, accountType: 'BUSINESS' },
  { id: 'prov2', name: 'Other Provider', isPlatform: false, accountType: 'BUSINESS' },
  { id: 'custA', name: 'Customer A', isPlatform: false, accountType: 'BUSINESS' },
  { id: 'custB', name: 'Customer B', isPlatform: false, accountType: 'BUSINESS' },
  { id: 'family', name: 'A family', isPlatform: false, accountType: 'FAMILY' },
];
const POIS: Obj[] = [{ id: 'site-a', companyId: 'custA', isActive: true }, { id: 'site-b', companyId: 'custB', isActive: true }];

function store() {
  const rows: Obj[] = [];
  const withNames = (r: Obj) => ({ ...r, provider: { name: COMPANIES.find((c) => c.id === r.providerCompanyId)?.name }, customer: { name: COMPANIES.find((c) => c.id === r.customerCompanyId)?.name } });
  const liveKey = (r: Obj) => ['DRAFT', 'PROPOSED', 'ACTIVE', 'SUSPENDED'].includes(r.status as string);
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
        if (rows.filter((x) => liveKey(x) && x.providerCompanyId === r.providerCompanyId && x.customerCompanyId === r.customerCompanyId).length > 1) throw new Error('unique');
      }
      return { count: hit.length };
    },
  };
  const prisma = {
    transportServiceAgreement: tsa,
    company: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => COMPANIES.filter((c) => where.id.in.includes(c.id as string)) },
    poi: { count: async ({ where }: { where: Obj }) => POIS.filter((p) => matches(p, where)).length },
    $transaction: async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as Promise<unknown>[])),
  };
  const audits: Obj[] = [];
  const invalidations: string[] = [];
  const svc = new AgreementsService(prisma as never, { record: async (_c: unknown, e: Obj) => audits.push(e) } as never, { invalidateCache: async (r: string) => invalidations.push(r) } as never);
  return { svc, rows, audits, invalidations };
}

const ctx = (companyId: string, isSuperAdmin = false): AuthContext =>
  ({ userId: `user-${companyId}`, homeCompanyId: isSuperAdmin ? 'platform' : companyId, companyId, isSuperAdmin, permissions: {}, dataScope: 'COMPANY', branchIds: [], objectIds: [], ip: null }) as AuthContext;
const SA = ctx('platform', true);
const draft = { providerCompanyId: 'prov', customerCompanyId: 'custA', validFrom: '2026-11-01T00:00:00Z', grants: ['VIEW_BOOKINGS' as const, 'MANAGE_DISPATCH' as const] };
const status = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { getStatus(): number; getResponse(): { code?: string } }) => `${e.getStatus()} ${e.getResponse().code ?? ''}`.trim());
const items = (r: unknown) => (r as { items: { id: string; customerCompanyId: string; side: string | null }[] }).items;

describe('AgreementsService', () => {
  it('full P1 flow: provider drafts, proposes; both approve → ACTIVE; customer suspends and resumes; provider ends', async () => {
    const { svc, audits, invalidations } = store();
    const a = await svc.create(ctx('prov'), { ...draft, siteIds: ['site-a'] });
    expect(a).toMatchObject({ status: 'DRAFT', version: 1, side: 'PROVIDER', allowedActions: ['edit', 'propose', 'end'], siteIds: ['site-a'], dataProfile: 'MINIMAL' });
    expect((await svc.propose(ctx('prov'), a.id, 1)).status).toBe('PROPOSED');
    const half = await svc.approve(ctx('custA'), a.id);
    expect(half).toMatchObject({ status: 'PROPOSED', side: 'CUSTOMER', approvedByCustomerUserId: 'user-custA', allowedActions: ['end'] });
    const active = await svc.approve(ctx('prov'), a.id);
    expect(active).toMatchObject({ status: 'ACTIVE', inForce: true, version: 4 });
    expect((await svc.suspend(ctx('custA'), a.id, 'audit pending')).status).toBe('SUSPENDED');
    expect((await svc.resume(ctx('custA'), a.id)).status).toBe('ACTIVE');
    const ended = await svc.end(ctx('prov'), a.id, 'contract over');
    expect(ended).toMatchObject({ status: 'ENDED', statusReason: 'contract over', allowedActions: [] });
    expect(audits.map((x) => x.action)).toEqual(['CREATE', 'UPDATE', 'UPDATE', 'UPDATE', 'UPDATE', 'UPDATE', 'UPDATE']);
    expect(invalidations).toHaveLength(5); // propose, activation, suspend, resume, end (not the first half-approval)
  });

  it('a customer never sees another customer’s agreements (list and by id → 404)', async () => {
    const { svc } = store();
    const forA = await svc.create(SA, draft);
    const forB = await svc.create(SA, { ...draft, customerCompanyId: 'custB' });
    expect(items(await svc.list(ctx('custA'), {})).map((x) => x.id)).toEqual([forA.id]);
    expect(await status(svc.get(ctx('custA'), forB.id))).toBe('404 NOT_FOUND');
    expect(await status(svc.propose(ctx('custA'), forB.id))).toBe('404 NOT_FOUND');
    expect(await status(svc.end(ctx('custB'), forA.id, 'x'))).toBe('404 NOT_FOUND');
  });

  it('a provider sees only agreements it is party to; the side filter splits provider / customer views', async () => {
    const { svc } = store();
    const mine = await svc.create(SA, draft);
    const other = await svc.create(SA, { ...draft, providerCompanyId: 'prov2' });
    expect(items(await svc.list(ctx('prov'), {})).map((x) => x.id)).toEqual([mine.id]);
    expect(await status(svc.get(ctx('prov'), other.id))).toBe('404 NOT_FOUND');
    expect(items(await svc.list(ctx('custA'), { side: 'CUSTOMER' }))).toHaveLength(2);
    expect(items(await svc.list(ctx('custA'), { side: 'PROVIDER' }))).toHaveLength(0);
  });

  it('Super Admin: PLAT list of all agreements, side null; switched into a company it sees only that company’s', async () => {
    const { svc } = store();
    await svc.create(SA, draft);
    await svc.create(SA, { ...draft, customerCompanyId: 'custB' });
    const all = items(await svc.list(SA, {}));
    expect(all).toHaveLength(2);
    expect(all.every((x) => x.side === null)).toBe(true);
    const switched = { ...SA, companyId: 'custB' } as AuthContext;
    expect(items(await svc.list(switched, {})).map((x) => x.customerCompanyId)).toEqual(['custB']);
  });

  it('only parties approve; only the customer (or Super Admin) suspends; illegal transitions are 409 INVALID_STATE', async () => {
    const { svc } = store();
    const a = await svc.create(SA, draft);
    expect(await status(svc.approve(ctx('custA'), a.id))).toBe('409 INVALID_STATE');
    await svc.propose(SA, a.id);
    expect(await status(svc.approve(SA, a.id))).toBe('403 FORBIDDEN_GRANT');
    await svc.approve(ctx('custA'), a.id);
    expect(await status(svc.approve(ctx('custA'), a.id))).toBe('409 INVALID_STATE');
    expect(await status(svc.update(ctx('prov'), a.id, { grants: ['VIEW_REPORTS'] }))).toBe('409 INVALID_STATE');
    await svc.approve(ctx('prov'), a.id);
    expect(await status(svc.suspend(ctx('prov'), a.id, 'no'))).toBe('403 FORBIDDEN_GRANT');
    expect(await status(svc.suspend(SA, a.id, 'platform hold'))).toBe('ok');
  });

  it('creation rules: party only, different business companies, customer sites, one live agreement per pair', async () => {
    const { svc } = store();
    expect(await status(svc.create(ctx('custB'), draft))).toBe('403 FORBIDDEN_GRANT');
    expect(await status(svc.create(SA, { ...draft, customerCompanyId: 'prov' }))).toBe('400 VALIDATION_FAILED');
    expect(await status(svc.create(SA, { ...draft, customerCompanyId: 'family' }))).toBe('400 VALIDATION_FAILED');
    expect(await status(svc.create(SA, { ...draft, customerCompanyId: 'platform' }))).toBe('400 VALIDATION_FAILED');
    expect(await status(svc.create(SA, { ...draft, customerCompanyId: '00000000-0000-4000-8000-000000000000' }))).toBe('404 NOT_FOUND');
    expect(await status(svc.create(SA, { ...draft, siteIds: ['site-b'] }))).toBe('400 VALIDATION_FAILED');
    expect(await status(svc.create(SA, { ...draft, validTo: '2026-10-01T00:00:00Z' }))).toBe('400 VALIDATION_FAILED');
    const first = await svc.create(SA, draft);
    expect(await status(svc.create(ctx('custA'), draft))).toBe('409 AGREEMENT_DUPLICATE');
    await svc.end(ctx('custA'), first.id, 'redo');
    expect(await status(svc.create(ctx('custA'), draft))).toBe('ok');
  });

  it('DRAFT edits are compare-and-set on version; a stale expectedVersion is 409 VERSION_CONFLICT', async () => {
    const { svc } = store();
    const a = await svc.create(ctx('custA'), draft);
    const edited = await svc.update(ctx('custA'), a.id, { grants: ['VIEW_REPORTS'], dataProfile: 'STANDARD', expectedVersion: 1 });
    expect(edited).toMatchObject({ version: 2, grants: ['VIEW_REPORTS'], dataProfile: 'STANDARD' });
    expect(await status(svc.update(ctx('prov'), a.id, { grants: ['VIEW_BOOKINGS'], expectedVersion: 1 }))).toBe('409 VERSION_CONFLICT');
  });

  it('propose needs at least one grant', async () => {
    const { svc } = store();
    const a = await svc.create(SA, { ...draft, grants: [] });
    await expect(svc.propose(SA, a.id)).rejects.toThrow(/at least one grant/);
  });

  it('error classes match doc 05 §4', async () => {
    const { svc } = store();
    await expect(svc.get(ctx('custA'), randomUUID())).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.create(ctx('custB'), draft)).rejects.toBeInstanceOf(ForbiddenException);
    await svc.create(SA, draft);
    await expect(svc.create(SA, draft)).rejects.toBeInstanceOf(ConflictException);
  });
});
