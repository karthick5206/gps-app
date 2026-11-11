import type { AuthContext } from '../../access/auth-context';
import { CompanyDirectoryService } from './company-directory.service';
import { FixedWindowLimiter } from './lookup-rate-limit';

/** Partner directory (E1a gap 1): ETMS companies only, three fields only, minimum length and rate limit. */
type Obj = Record<string, unknown>;
const COMPANIES: Obj[] = [
  { id: 'me', name: 'Acme Transport', status: 'ACTIVE', accountType: 'BUSINESS', isPlatform: false, settings: { features: ['etms'] }, billingProfile: { city: 'Chennai', email: 'billing@acme.example', gstin: 'X' } },
  { id: 'c1', name: 'Acme Logistics', status: 'ACTIVE', accountType: 'BUSINESS', isPlatform: false, settings: { features: ['etms', 'attendance'] }, billingProfile: { city: ' Pune ' } },
  { id: 'c2', name: 'Acme Foods', status: 'ACTIVE', accountType: 'BUSINESS', isPlatform: false, settings: { features: ['attendance'] }, billingProfile: null },
  { id: 'c3', name: 'Acme Corp', status: 'ACTIVE', accountType: 'BUSINESS', isPlatform: false, settings: { features: ['etms'] }, billingProfile: { city: '' } },
  { id: 'c4', name: 'Acme Platform', status: 'ACTIVE', accountType: 'BUSINESS', isPlatform: true, settings: {}, billingProfile: null },
  { id: 'c5', name: 'Acme Old', status: 'ACTIVE', accountType: 'BUSINESS', isPlatform: false, settings: null, billingProfile: null },
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
  const svc = new CompanyDirectoryService(prisma as never, (redis === null ? null : { client: redis }) as never);
  return { svc, calls };
}
const ctx = (userId = 'u1'): AuthContext => ({ userId, companyId: 'me', homeCompanyId: 'me', isSuperAdmin: false, permissions: {}, dataScope: 'COMPANY', branchIds: [], objectIds: [], ip: null }) as unknown as AuthContext;
const status = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { getStatus(): number; getResponse(): { code?: string } }) => `${e.getStatus()} ${e.getResponse().code ?? ''}`.trim());

describe('GET /transport/companies/lookup', () => {
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
    expect(calls[0].where).toMatchObject({ status: 'ACTIVE', accountType: 'BUSINESS', isPlatform: false, id: { not: 'me' }, settings: { path: ['features'], array_contains: ['etms'] } });
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
    const { svc } = setup();
    for (let i = 0; i < 30; i++) expect(await status(svc.lookup(ctx('u1'), 'acme'))).toBe('ok');
    expect(await status(svc.lookup(ctx('u1'), 'acme'))).toBe('429 RATE_LIMITED');
    expect(await status(svc.lookup(ctx('u2'), 'acme'))).toBe('ok');
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
