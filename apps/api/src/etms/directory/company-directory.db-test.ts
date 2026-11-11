/**
 * Partner directory query on a real PostgreSQL (the JSON `settings.features` filter cannot be checked in memory).
 * Not part of the normal run (testRegex is *.spec.ts):
 *   ETMS_DB_TEST_URL=postgresql://user:pass@127.0.0.1:5432/veetrax_assess \
 *     npx jest --testRegex 'company-directory\.db-test\.ts$' --runInBand
 * Allowed databases: veetrax_assess or any *_test database; never veetracer. Runs inside ONE transaction that is always
 * rolled back, so no row is left behind.
 */
import { PrismaClient } from '@prisma/client';
import type { AuthContext } from '../../access/auth-context';
import { CompanyDirectoryService } from './company-directory.service';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const dbName = /\/([a-z0-9_]+)(\?|$)/i.exec(URL_)?.[1] ?? '';
const allowed = dbName === 'veetrax_assess' || /_test$/i.test(dbName);
const d = URL_ && allowed ? describe : describe.skip;

class Rollback extends Error {}

d(`company directory on ${dbName}`, () => {
  jest.setTimeout(60_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  afterAll(() => prisma.$disconnect());

  it('returns only active business companies with the etms add-on, three fields only', async () => {
    const tag = `Zqx${Date.now().toString(36)}`;
    let result: unknown;
    await prisma
      .$transaction(async (tx) => {
        const partner = await tx.partner.create({ data: { name: `${tag} partner`, slug: `${tag.toLowerCase()}-p` } });
        const mk = (name: string, extra: Record<string, unknown> = {}) => tx.company.create({ data: { partnerId: partner.id, name: `${tag} ${name}`, ...extra } as never });
        const me = await mk('Self', { settings: { features: ['etms'] } });
        const on = await mk('On', { settings: { features: ['attendance', 'etms'] } });
        await tx.billingProfile.create({ data: { companyId: on.id, billingName: 'x', address: 'secret street 1', city: 'Pune', stateCode: '27', email: 'secret@example.com' } });
        await mk('Off', { settings: { features: ['attendance'] } });
        await mk('Empty');
        await mk('Suspended', { settings: { features: ['etms'] }, status: 'SUSPENDED' });
        await mk('Family', { settings: { features: ['etms'] }, accountType: 'FAMILY' });
        const svc = new CompanyDirectoryService(tx as never, null as never);
        result = await svc.lookup({ userId: `${tag}-u`, companyId: me.id } as AuthContext, tag.toLowerCase());
        throw new Rollback();
      })
      .catch((e: unknown) => {
        if (!(e instanceof Rollback)) throw e;
      });
    expect(result).toEqual([{ id: expect.any(String), name: `${tag} On`, city: 'Pune' }]);
  });
});
