import { randomUUID } from 'crypto';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { AuthContext } from '../../access/auth-context';
import { AgreementApproveDto } from './agreements.dto';
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

const ON = { status: 'ACTIVE', settings: { features: ['etms'] } };
function companies(): Obj[] {
  return [
    { id: 'platform', name: 'VeeTrax', isPlatform: true, accountType: 'BUSINESS', ...ON },
    { id: 'prov', name: 'Provider Co', isPlatform: false, accountType: 'BUSINESS', ...ON },
    { id: 'prov2', name: 'Other Provider', isPlatform: false, accountType: 'BUSINESS', ...ON },
    { id: 'custA', name: 'Customer A', isPlatform: false, accountType: 'BUSINESS', ...ON },
    { id: 'custB', name: 'Customer B', isPlatform: false, accountType: 'BUSINESS', ...ON },
    { id: 'family', name: 'A family', isPlatform: false, accountType: 'FAMILY', ...ON },
    { id: 'noEtms', name: 'GPS only', isPlatform: false, accountType: 'BUSINESS', status: 'ACTIVE', settings: { features: ['attendance'] } },
    { id: 'suspended', name: 'Suspended Co', isPlatform: false, accountType: 'BUSINESS', status: 'SUSPENDED', settings: { features: ['etms'] } },
  ];
}
const POIS: Obj[] = [{ id: 'site-a', companyId: 'custA', isActive: true }, { id: 'site-b', companyId: 'custB', isActive: true }];

function store() {
  const rows: Obj[] = [];
  const COMPANIES = companies();
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
  const audit = {
    record: async (c: AuthContext, e: Obj) => audits.push({ ...e, companyId: c.companyId }),
    recordFor: async (_c: AuthContext, companyId: string, e: Obj) => audits.push({ ...e, companyId }),
  };
  const svc = new AgreementsService(prisma as never, audit as never, { invalidateCache: async (r: string) => invalidations.push(r) } as never);
  const v = (id: string) => rows.find((r) => r.id === id)!.version as number;
  return { svc, rows, audits, invalidations, v, companies: COMPANIES };
}

const ctx = (companyId: string, isSuperAdmin = false, dataScope: 'COMPANY' | 'ASSIGNED' = 'COMPANY'): AuthContext =>
  ({ userId: isSuperAdmin ? 'user-sa' : `user-${companyId}`, homeCompanyId: isSuperAdmin ? 'platform' : companyId, companyId, isSuperAdmin, permissions: { etms_partners: ['view', 'create', 'edit'] }, dataScope, branchIds: [], objectIds: [], ip: null }) as AuthContext;
const SA = ctx('platform', true);
const asSA = (companyId: string) => ({ ...SA, companyId }) as AuthContext;
const draft = { providerCompanyId: 'prov', customerCompanyId: 'custA', validFrom: '2026-11-01T00:00:00Z', grants: ['VIEW_BOOKINGS' as const, 'MANAGE_DISPATCH' as const] };
const saDraft = { ...draft, reason: 'set up for the customer' };
const status = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { getStatus(): number; getResponse(): { code?: string } }) => `${e.getStatus()} ${e.getResponse().code ?? ''}`.trim());
const items = (r: unknown) => (r as { items: { id: string; customerCompanyId: string; side: string | null; allowedActions: string[] }[] }).items;

describe('AgreementsService', () => {
  it('full P1 flow: provider drafts, proposes; both approve → ACTIVE; customer suspends and resumes; provider ends', async () => {
    const { svc, audits, invalidations, v } = store();
    const a = await svc.create(ctx('prov'), { ...draft, siteIds: ['site-a'] });
    expect(a).toMatchObject({ status: 'DRAFT', version: 1, side: 'PROVIDER', allowedActions: ['edit', 'propose', 'end'], siteIds: ['site-a'], dataProfile: 'MINIMAL' });
    expect((await svc.propose(ctx('prov'), a.id, 1)).status).toBe('PROPOSED');
    const half = await svc.approve(ctx('custA'), a.id, v(a.id));
    expect(half).toMatchObject({ status: 'PROPOSED', side: 'CUSTOMER', approvedByCustomerUserId: 'user-custA', allowedActions: ['end'] });
    const active = await svc.approve(ctx('prov'), a.id, v(a.id));
    expect(active).toMatchObject({ status: 'ACTIVE', inForce: true, version: 4 });
    expect((await svc.suspend(ctx('custA'), a.id, 'audit pending')).status).toBe('SUSPENDED');
    expect((await svc.resume(ctx('custA'), a.id)).status).toBe('ACTIVE');
    const ended = await svc.end(ctx('prov'), a.id, 'contract over');
    expect(ended).toMatchObject({ status: 'ENDED', statusReason: 'contract over', allowedActions: [] });
    expect(audits.map((x) => x.action)).toEqual(['CREATE', 'UPDATE', 'UPDATE', 'UPDATE', 'UPDATE', 'UPDATE', 'UPDATE']);
    expect(audits.every((x) => x.companyId === 'prov' || x.companyId === 'custA')).toBe(true);
    expect(invalidations).toHaveLength(5); // propose, activation, suspend, resume, end (not the first half-approval)
  });

  it('a customer never sees another customer’s agreements (list and by id → 404)', async () => {
    const { svc } = store();
    const forA = await svc.create(SA, saDraft);
    const forB = await svc.create(SA, { ...saDraft, customerCompanyId: 'custB' });
    expect(items(await svc.list(ctx('custA'), {})).map((x) => x.id)).toEqual([forA.id]);
    expect(await status(svc.get(ctx('custA'), forB.id))).toBe('404 NOT_FOUND');
    expect(await status(svc.propose(ctx('custA'), forB.id))).toBe('404 NOT_FOUND');
    expect(await status(svc.end(ctx('custB'), forA.id, 'x'))).toBe('404 NOT_FOUND');
  });

  it('a provider sees only agreements it is party to; the side filter splits provider / customer views', async () => {
    const { svc } = store();
    const mine = await svc.create(SA, saDraft);
    const other = await svc.create(SA, { ...saDraft, providerCompanyId: 'prov2' });
    expect(items(await svc.list(ctx('prov'), {})).map((x) => x.id)).toEqual([mine.id]);
    expect(await status(svc.get(ctx('prov'), other.id))).toBe('404 NOT_FOUND');
    expect(items(await svc.list(ctx('custA'), { side: 'CUSTOMER' }))).toHaveLength(2);
    expect(items(await svc.list(ctx('custA'), { side: 'PROVIDER' }))).toHaveLength(0);
  });

  it('Super Admin: PLAT list of all agreements, side null; switched into a company it sees only that company’s, still side null', async () => {
    const { svc } = store();
    await svc.create(SA, saDraft);
    await svc.create(SA, { ...saDraft, customerCompanyId: 'custB' });
    const all = items(await svc.list(SA, {}));
    expect(all).toHaveLength(2);
    expect(all.every((x) => x.side === null)).toBe(true);
    const switched = items(await svc.list(asSA('custB'), {}));
    expect(switched.map((x) => x.customerCompanyId)).toEqual(['custB']);
    expect(switched[0].side).toBeNull();
  });

  it('only parties approve; only the customer (or Super Admin) suspends; illegal transitions are 409 INVALID_STATE', async () => {
    const { svc, v } = store();
    const a = await svc.create(SA, saDraft);
    expect(await status(svc.approve(ctx('custA'), a.id, v(a.id)))).toBe('409 INVALID_STATE');
    await svc.propose(SA, a.id, undefined, 'ready');
    expect(await status(svc.approve(SA, a.id, v(a.id)))).toBe('403 FORBIDDEN_GRANT');
    await svc.approve(ctx('custA'), a.id, v(a.id));
    expect(await status(svc.approve(ctx('custA'), a.id, v(a.id)))).toBe('409 INVALID_STATE');
    expect(await status(svc.update(ctx('prov'), a.id, { grants: ['VIEW_REPORTS'] }))).toBe('409 INVALID_STATE');
    await svc.approve(ctx('prov'), a.id, v(a.id));
    expect(await status(svc.suspend(ctx('prov'), a.id, 'no'))).toBe('403 FORBIDDEN_GRANT');
    expect(await status(svc.suspend(SA, a.id, 'platform hold'))).toBe('ok');
  });

  it('creation rules: party only, different business companies, customer sites, one live agreement per pair', async () => {
    const { svc } = store();
    expect(await status(svc.create(ctx('custB'), draft))).toBe('403 FORBIDDEN_GRANT');
    expect(await status(svc.create(SA, { ...saDraft, customerCompanyId: 'prov' }))).toBe('400 VALIDATION_FAILED');
    expect(await status(svc.create(SA, { ...saDraft, customerCompanyId: 'family' }))).toBe('400 VALIDATION_FAILED');
    expect(await status(svc.create(SA, { ...saDraft, customerCompanyId: 'platform' }))).toBe('400 VALIDATION_FAILED');
    expect(await status(svc.create(SA, { ...saDraft, customerCompanyId: '00000000-0000-4000-8000-000000000000' }))).toBe('404 NOT_FOUND');
    expect(await status(svc.create(SA, { ...saDraft, siteIds: ['site-b'] }))).toBe('400 VALIDATION_FAILED');
    expect(await status(svc.create(SA, { ...saDraft, validTo: '2026-10-01T00:00:00Z' }))).toBe('400 VALIDATION_FAILED');
    const first = await svc.create(SA, saDraft);
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
    const a = await svc.create(SA, { ...saDraft, grants: [] });
    await expect(svc.propose(SA, a.id, undefined, 'r')).rejects.toThrow(/at least one grant/);
  });

  it('error classes match doc 05 §4', async () => {
    const { svc } = store();
    await expect(svc.get(ctx('custA'), randomUUID())).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.create(ctx('custB'), draft)).rejects.toBeInstanceOf(ForbiddenException);
    await svc.create(SA, saDraft);
    await expect(svc.create(SA, saDraft)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('F1 (R-12): agreement commands need whole-company data scope', () => {
  const branch = (companyId: string) => ctx(companyId, false, 'ASSIGNED');

  it('a branch-scoped user can neither create, edit, propose, approve, suspend, resume nor end: 403 SCOPE_REQUIRED', async () => {
    const { svc, v } = store();
    expect(await status(svc.create(branch('prov'), draft))).toBe('403 SCOPE_REQUIRED');
    const a = await svc.create(ctx('prov'), draft);
    expect(await status(svc.update(branch('prov'), a.id, { grants: ['VIEW_REPORTS'] }))).toBe('403 SCOPE_REQUIRED');
    expect(await status(svc.propose(branch('custA'), a.id))).toBe('403 SCOPE_REQUIRED');
    expect(await status(svc.end(branch('custA'), a.id, 'x'))).toBe('403 SCOPE_REQUIRED');
    await svc.propose(ctx('prov'), a.id);
    expect(await status(svc.approve(branch('custA'), a.id, v(a.id)))).toBe('403 SCOPE_REQUIRED');
    await svc.approve(ctx('custA'), a.id, v(a.id));
    await svc.approve(ctx('prov'), a.id, v(a.id));
    expect(await status(svc.suspend(branch('custA'), a.id, 'x'))).toBe('403 SCOPE_REQUIRED');
    await svc.suspend(ctx('custA'), a.id, 'hold');
    expect(await status(svc.resume(branch('custA'), a.id))).toBe('403 SCOPE_REQUIRED');
  });

  it('allowedActions follow the menu grant too: a viewer without etms_partners:edit is offered nothing (QA BUG-3)', async () => {
    const { svc } = store();
    const a = await svc.create(ctx('prov'), draft);
    const dispatcher = { ...ctx('custA'), permissions: { etms_partners: ['view'] } } as AuthContext;
    expect((await svc.get(dispatcher, a.id)).allowedActions).toEqual([]);
    expect(items(await svc.list(dispatcher, {}))[0].allowedActions).toEqual([]);
  });

  it('a branch-scoped user still reads the agreement, but is offered no commands', async () => {
    const { svc } = store();
    const a = await svc.create(ctx('prov'), draft);
    expect((await svc.get(branch('custA'), a.id)).allowedActions).toEqual([]);
    expect(items(await svc.list(branch('prov'), {}))[0].allowedActions).toEqual([]);
    expect((await svc.get(ctx('custA'), a.id)).allowedActions).toEqual(['edit', 'propose', 'end']);
  });
});

describe('F2 (P1): VeeTrax support drafts but never approves, also after switching company', () => {
  it('Super Admin switched into the customer, then the provider, cannot approve either side: 403 FORBIDDEN_GRANT', async () => {
    const { svc, rows, v } = store();
    const a = await svc.create(SA, saDraft);
    await svc.propose(SA, a.id, undefined, 'ready');
    expect(await status(svc.approve(asSA('custA'), a.id, v(a.id)))).toBe('403 FORBIDDEN_GRANT');
    expect(await status(svc.approve(asSA('prov'), a.id, v(a.id)))).toBe('403 FORBIDDEN_GRANT');
    expect(rows[0]).toMatchObject({ status: 'PROPOSED', approvedByCustomerAt: null, approvedByProviderAt: null });
    expect((await svc.get(asSA('custA'), a.id)).allowedActions).toEqual(['end']);
  });

  it('Super Admin may suspend and end but never resume (re-activating the grants is the customer’s call)', async () => {
    const { svc, v } = store();
    const a = await svc.create(ctx('prov'), draft);
    await svc.propose(ctx('prov'), a.id);
    await svc.approve(ctx('custA'), a.id, v(a.id));
    await svc.approve(ctx('prov'), a.id, v(a.id));
    await svc.suspend(asSA('custA'), a.id, 'incident review');
    expect((await svc.get(SA, a.id)).allowedActions).toEqual(['end']);
    expect(await status(svc.resume(SA, a.id))).toBe('403 FORBIDDEN_GRANT');
    expect(await status(svc.resume(asSA('custA'), a.id))).toBe('403 FORBIDDEN_GRANT');
    expect(await status(svc.resume(ctx('custA'), a.id))).toBe('ok');
  });
});

describe('F3: provider grants need the customer module on; the customer keeps control when it comes back', () => {
  it('module back on: the customer sees the agreement and can suspend it', async () => {
    const { svc, v, companies: cs } = store();
    const a = await svc.create(ctx('prov'), draft);
    await svc.propose(ctx('prov'), a.id);
    await svc.approve(ctx('custA'), a.id, v(a.id));
    await svc.approve(ctx('prov'), a.id, v(a.id));
    const custA = cs.find((c) => c.id === 'custA')!;
    custA.settings = { features: [] }; // Super Admin switches the module off (the HTTP layer then 404s, see etms-access.spec)
    custA.settings = { features: ['etms'] }; // …and on again
    expect((await svc.get(ctx('custA'), a.id)).allowedActions).toEqual(['suspend', 'end']);
    expect((await svc.suspend(ctx('custA'), a.id, 'checking after module re-enable')).status).toBe('SUSPENDED');
  });
});

describe('F5: minimum data in the agreement DTO', () => {
  it('each side sees only its own approver id; the creator id only VeeTrax support', async () => {
    const { svc, v } = store();
    const a = await svc.create(ctx('prov'), draft);
    await svc.propose(ctx('prov'), a.id);
    await svc.approve(ctx('custA'), a.id, v(a.id));
    await svc.approve(ctx('prov'), a.id, v(a.id));
    expect(await svc.get(ctx('custA'), a.id)).toMatchObject({ approvedByCustomerUserId: 'user-custA', approvedByProviderUserId: null, createdById: null });
    expect(await svc.get(ctx('prov'), a.id)).toMatchObject({ approvedByCustomerUserId: null, approvedByProviderUserId: 'user-prov', createdById: null });
    expect(await svc.get(SA, a.id)).toMatchObject({ approvedByCustomerUserId: 'user-custA', approvedByProviderUserId: 'user-prov', createdById: 'user-prov' });
    const csv = JSON.stringify(items(await svc.list(ctx('custA'), {})));
    expect(csv).not.toContain('user-prov');
  });
});

describe('F6: approve requires expectedVersion', () => {
  it('the DTO rejects a missing version; the service refuses one too; a stale one is 409', async () => {
    expect(validateSync(plainToInstance(AgreementApproveDto, {})).length).toBeGreaterThan(0);
    expect(validateSync(plainToInstance(AgreementApproveDto, { expectedVersion: 2 }))).toEqual([]);
    const { svc, v } = store();
    const a = await svc.create(ctx('prov'), draft);
    await svc.propose(ctx('prov'), a.id);
    expect(await status(svc.approve(ctx('custA'), a.id, undefined as unknown as number))).toBe('400 VALIDATION_FAILED');
    expect(await status(svc.approve(ctx('custA'), a.id, 1))).toBe('409 VERSION_CONFLICT');
    expect(await status(svc.approve(ctx('custA'), a.id, v(a.id)))).toBe('ok');
  });
});

describe('F7: VeeTrax support gives a reason; its changes land in the customer’s audit log', () => {
  it('create, edit and propose by the Super Admin need a reason (400 without)', async () => {
    const { svc } = store();
    expect(await status(svc.create(SA, draft))).toBe('400 VALIDATION_FAILED');
    expect(await status(svc.create(SA, { ...draft, reason: '   ' }))).toBe('400 VALIDATION_FAILED');
    const a = await svc.create(SA, saDraft);
    expect(await status(svc.update(SA, a.id, { grants: ['VIEW_REPORTS'] }))).toBe('400 VALIDATION_FAILED');
    expect(await status(svc.update(asSA('prov'), a.id, { grants: ['VIEW_REPORTS'], reason: 'provider asked' }))).toBe('ok');
    expect(await status(svc.propose(SA, a.id))).toBe('400 VALIDATION_FAILED');
    expect(await status(svc.propose(SA, a.id, undefined, 'both agreed by mail'))).toBe('ok');
  });

  it('audit rows of the Super Admin go to the customer company with the reason; parties’ rows stay in their own company', async () => {
    const { svc, audits } = store();
    const a = await svc.create(SA, saDraft);
    await svc.update(asSA('prov'), a.id, { grants: ['VIEW_REPORTS'], reason: 'provider asked' });
    await svc.end(ctx('prov'), a.id, 'not needed');
    expect(audits.map((x) => x.companyId)).toEqual(['custA', 'custA', 'prov']);
    expect((audits[0].after as Obj).supportReason).toBe('set up for the customer');
    expect((audits[1].after as Obj).supportReason).toBe('provider asked');
    expect((audits[2].after as Obj).supportReason).toBeUndefined();
  });

  it('parties need no reason to edit or propose', async () => {
    const { svc } = store();
    const a = await svc.create(ctx('custA'), draft);
    expect(await status(svc.update(ctx('custA'), a.id, { grants: ['VIEW_REPORTS'] }))).toBe('ok');
    expect(await status(svc.propose(ctx('prov'), a.id))).toBe('ok');
  });
});

describe('F8: no draft against a company outside ETMS', () => {
  it('the other party must be ACTIVE with the etms add-on; it answers like an unknown id (404)', async () => {
    const { svc } = store();
    expect(await status(svc.create(ctx('prov'), { ...draft, customerCompanyId: 'noEtms' }))).toBe('404 NOT_FOUND');
    expect(await status(svc.create(ctx('prov'), { ...draft, customerCompanyId: 'suspended' }))).toBe('404 NOT_FOUND');
    expect(await status(svc.create(SA, { ...saDraft, providerCompanyId: 'noEtms' }))).toBe('404 NOT_FOUND');
    expect(await status(svc.create(ctx('prov'), draft))).toBe('ok');
  });
});
