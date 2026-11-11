import type { AuthContext } from '../../access/auth-context';
import { CompanyDirectoryService } from './company-directory.service';
import { FixedWindowLimiter } from './lookup-rate-limit';

/** Partner directory (E1a gap 1): ETMS companies only, three fields only, minimum length and rate limit. */
type Obj = Record<string, unknown>;
const LISTED = { directoryListed: true };
const COMPANIES: Obj[] = [
  { id: 'me', name: 'Acme Transport', status: 'ACTIVE', accountType: 'BUSINESS', isPlatform: false, settings: { features: ['etms'], etms: LISTED }, billingProfile: { city: 'Chennai', email: 'billing@acme.example', gstin: 'X' } },
  { id: 'c1', name: 'Acme Logistics', status: 'ACTIVE', accountType: 'BUSINESS', isPlatform: false, settings: { features: ['etms', 'attendance'], etms: LISTED }, billingProfile: { city: ' Pune ' } },
  { id: 'c2', name: 'Acme Foods', status: 'ACTIVE', accountType: 'BUSINESS', isPlatform: false, settings: { features: ['attendance'], etms: LISTED }, billingProfile: null },
  { id: 'c3', name: 'Acme Corp', status: 'ACTIVE', accountType: 'BUSINESS', isPlatform: false, settings: { features: ['etms'], etms: LISTED }, billingProfile: { city: '' } },
  { id: 'c4', name: 'Acme Platform', status: 'ACTIVE', accountType: 'BUSINESS', isPlatform: true, settings: { etms: LISTED }, billingProfile: null },
  { id: 'c5', name: 'Acme Old', status: 'ACTIVE', accountType: 'BUSINESS', isPlatform: false, settings: null, billingProfile: null },
  // F4: ETMS on but not opted in (default), or opted out explicitly, or a malformed value.
  { id: 'c6', name: 'Acme Quiet', status: 'ACTIVE', accountType: 'BUSINESS', isPlatform: false, settings: { features: ['etms'] }, billingProfile: { city: 'Delhi' } },
  { id: 'c7', name: 'Acme Hidden', status: 'ACTIVE', accountType: 'BUSINESS', isPlatform: false, settings: { features: ['etms'], etms: { directoryListed: false } }, billingProfile: null },
  { id: 'c8', name: 'Acme Odd', status: 'ACTIVE', accountType: 'BUSINESS', isPlatform: false, settings: { features: ['etms'], etms: { directoryListed: 'yes' } }, billingProfile: null },
];

function setup(redis: unknown = null) {
  const calls: Obj[] = [];
  const prisma = {
    company: {
      // Ignores the JSON `settings` filter on purpose: the service must also filter in code.
      findMany: async (args: Obj) => {
        calls.push(args);
        const where = args.where as { name: { contains: string } };
        return COMPANIES.filter((c) => String(c.name).toLowerCase().includes(where.name.contains.toLowerCase()));
      },
    },
  };
  const audits: Obj[] = [];
  const audit = { record: async (c: AuthContext, e: Obj) => audits.push({ ...e, companyId: c.companyId, userId: c.userId }) };
  const svc = new CompanyDirectoryService(prisma as never, (redis === null ? null : { client: redis }) as never, audit as never);
  return { svc, calls, audits };
}
const ctx = (userId = 'u1', companyId = 'me'): AuthContext => ({ userId, companyId, homeCompanyId: 'me', isSuperAdmin: false, permissions: {}, dataScope: 'COMPANY', branchIds: [], objectIds: [], ip: null }) as unknown as AuthContext;
const status = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { getStatus(): number; getResponse(): { code?: string } }) => `${e.getStatus()} ${e.getResponse().code ?? ''}`.trim());

describe('GET /transport/companies/lookup', () => {
  it('F4: returns only companies that opted in to the directory (default off), filtered in the query and in code', async () => {
    const { svc, calls } = setup();
    const ids = (await svc.lookup(ctx(), 'acme')).map((c) => c.id);
    expect(ids).not.toEqual(expect.arrayContaining(['c6']));
    expect(ids.some((id) => ['c6', 'c7', 'c8'].includes(id))).toBe(false);
    expect(calls[0].where).toMatchObject({ AND: [{ settings: { path: ['features'], array_contains: ['etms'] } }, { settings: { path: ['etms', 'directoryListed'], equals: true } }] });
  });

  it('F4: every search is audited with query length and result count only (no query text, no company ids)', async () => {
    const { svc, audits } = setup();
    await svc.lookup(ctx(), '  Acme   Log ');
    expect(audits).toEqual([{ action: 'ACCESS', entity: 'etms_company_lookup', entityId: null, details: { queryLength: 8, resultCount: 1 }, companyId: 'me', userId: 'u1' }]);
    expect(JSON.stringify(audits)).not.toMatch(/Acme|Log|c1/);
  });

  it('F4: rate-limited per company too: many users of one company share 60 per minute; refusals are audited', async () => {
    const { svc, audits } = setup();
    for (let i = 0; i < 60; i++) expect(await status(svc.lookup(ctx(`u${i % 3}`), 'acme'))).toBe(i < 60 ? 'ok' : '');
    expect(await status(svc.lookup(ctx('u99'), 'acme'))).toBe('429 RATE_LIMITED');
    expect(audits.at(-1)).toMatchObject({ action: 'ACCESS', details: { queryLength: 4, resultCount: 0, rateLimited: 'company' } });
    expect(await status(svc.lookup(ctx('u99', 'other'), 'acme'))).toBe('ok'); // another company is unaffected
  });

  it('returns only ETMS-enabled business companies, never the caller’s own or the platform', async () => {
    const { svc } = setup();
    const res = await svc.lookup(ctx(), 'acme');
    expect(res).toEqual([
      { id: 'c1', name: 'Acme Logistics', city: 'Pune' },
      { id: 'c3', name: 'Acme Corp', city: null },
    ]);
  });

  it('returns only id, name and city; the query never selects contacts, users, vehicles', async () => {
    const { svc, calls } = setup();
    const res = await svc.lookup(ctx(), 'logistics');
    expect(Object.keys(res[0]).sort()).toEqual(['city', 'id', 'name']);
    const select = calls[0].select as Obj;
    expect(Object.keys(select).sort()).toEqual(['billingProfile', 'id', 'isPlatform', 'name', 'settings']);
    expect(select.billingProfile).toEqual({ select: { city: true } });
    expect(calls[0].where).toMatchObject({ status: 'ACTIVE', accountType: 'BUSINESS', isPlatform: false, id: { not: 'me' } });
  });

  it('needs at least 3 characters (trimmed): 400 VALIDATION_FAILED, no query run', async () => {
    const { svc, calls } = setup();
    expect(await status(svc.lookup(ctx(), 'ac'))).toBe('400 VALIDATION_FAILED');
    expect(await status(svc.lookup(ctx(), '  a  '))).toBe('400 VALIDATION_FAILED');
    expect(await status(svc.lookup(ctx(), undefined))).toBe('400 VALIDATION_FAILED');
    expect(calls).toHaveLength(0);
    expect(await status(svc.lookup(ctx(), ' acm '))).toBe('ok');
  });

  it('rate-limited per user: the 31st lookup in a minute is 429 RATE_LIMITED; other users unaffected', async () => {
    const { svc, audits } = setup();
    for (let i = 0; i < 30; i++) expect(await status(svc.lookup(ctx('u1'), 'acme'))).toBe('ok');
    expect(await status(svc.lookup(ctx('u1'), 'acme'))).toBe('429 RATE_LIMITED');
    expect(await status(svc.lookup(ctx('u2'), 'acme'))).toBe('ok');
    expect(audits.filter((a) => (a.details as Obj).rateLimited === 'user')).toHaveLength(1);
  });
});

describe('FixedWindowLimiter', () => {
  it('uses Valkey when available (one key per window)', async () => {
    const counts = new Map<string, number>();
    const redis = { eval: jest.fn(async (_s: string, _n: number, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1).get(key)) };
    const l = new FixedWindowLimiter(redis as never, 'p', 2, 60_000);
    const t = 120_000;
    expect((await l.hit('k', t)).allowed).toBe(true);
    expect((await l.hit('k', t)).allowed).toBe(true);
    expect(await l.hit('k', t + 30_000)).toEqual({ allowed: false, retryAfterSec: 30 });
    expect((await l.hit('k', t + 60_000)).allowed).toBe(true); // next window
    expect(redis.eval.mock.calls[0][2]).toBe('p:k:2');
  });

  it('falls back to an in-process window when Valkey fails, so the limit stays on', async () => {
    const l = new FixedWindowLimiter({ eval: async () => { throw new Error('down'); } }, 'p', 1, 60_000);
    expect((await l.hit('k', 0)).allowed).toBe(true);
    expect((await l.hit('k', 1)).allowed).toBe(false);
  });
});
