/**
 * Partner directory query on a real PostgreSQL (the JSON `settings.features` filter cannot be checked in memory).
 * Not part of the normal run (testRegex is *.spec.ts):
 *   ETMS_DB_TEST_URL=postgresql://user:pass@127.0.0.1:5432/veetrax_assess \
 *     npx jest --testRegex 'company-directory\.db-test\.ts$' --runInBand
 * Allowed databases (test/scratch-db.ts): any *_test database; locally also veetrax_assess; never veetracer. CI: job api-db. Runs inside ONE transaction that is always
 * rolled back, so no row is left behind.
 */
import { PrismaClient } from '@prisma/client';
import { dbDescribe } from '../../test/scratch-db';
import type { AuthContext } from '../../access/auth-context';
import { CompanyDirectoryService } from './company-directory.service';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);

class Rollback extends Error {}

d(`company directory on ${dbName}`, () => {
  jest.setTimeout(60_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  afterAll(() => prisma.$disconnect());

  it('returns only active business companies with the etms add-on that opted in to the directory, three fields only', async () => {
    const tag = `Zqx${Date.now().toString(36)}`;
    let result: unknown;
    await prisma
      .$transaction(async (tx) => {
        const partner = await tx.partner.create({ data: { name: `${tag} partner`, slug: `${tag.toLowerCase()}-p` } });
        const mk = (name: string, extra: Record<string, unknown> = {}) => tx.company.create({ data: { partnerId: partner.id, name: `${tag} ${name}`, ...extra } as never });
        const me = await mk('Self', { settings: { features: ['etms'] } });
        const on = await mk('On', { settings: { features: ['attendance', 'etms'], etms: { directoryListed: true } } });
        await mk('Unlisted', { settings: { features: ['etms'] } });
        await mk('OptedOut', { settings: { features: ['etms'], etms: { directoryListed: false } } });
        await mk('ListedNoEtms', { settings: { features: ['attendance'], etms: { directoryListed: true } } });
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
