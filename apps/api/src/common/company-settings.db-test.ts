/**
 * F9: setCompanySetting on a real PostgreSQL (jsonb_set cannot be checked in memory). Not part of the normal run:
 *   ETMS_DB_TEST_URL=postgresql://user:pass@127.0.0.1:5432/veetrax_assess npx jest --testRegex 'company-settings\.db-test\.ts$' --runInBand
 * Allowed databases: see test/scratch-db.ts (CI: job api-db). Runs inside ONE transaction that is always rolled back.
 */
import { PrismaClient } from '@prisma/client';
import { dbDescribe } from '../test/scratch-db';
import { setCompanySetting } from './company-settings';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);

class Rollback extends Error {}

d(`setCompanySetting on ${dbName}`, () => {
  jest.setTimeout(60_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  afterAll(() => prisma.$disconnect());

  it('writes one key atomically: a save from a stale read can no longer undo another key (the features switch)', async () => {
    const tag = `Zcs${Date.now().toString(36)}`;
    let after: unknown;
    let odd: unknown;
    await prisma
      .$transaction(async (tx) => {
        const partner = await tx.partner.create({ data: { name: `${tag} partner`, slug: `${tag.toLowerCase()}-p` } });
        const c = await tx.company.create({ data: { partnerId: partner.id, name: `${tag} co`, settings: { features: ['etms'], thresholds: { overspeedKmh: 80 }, driverEvents: { cabinChannel: 1 } } } });
        // The company admin's form was loaded before the Super Admin switched ETMS off (rollback) …
        await setCompanySetting(tx, c.id, 'features', []);
        // … and now saves thresholds: only `thresholds` is written, so ETMS stays off.
        await setCompanySetting(tx, c.id, 'thresholds', { overspeedKmh: 90 });
        await setCompanySetting(tx, c.id, 'etms', { directoryListed: true });
        after = (await tx.company.findUniqueOrThrow({ where: { id: c.id }, select: { settings: true } })).settings;
        const o = await tx.company.create({ data: { partnerId: partner.id, name: `${tag} odd` } });
        await tx.$executeRaw`UPDATE "Company" SET "settings" = '[]'::jsonb WHERE "id" = ${o.id}::uuid`;
        await setCompanySetting(tx, o.id, 'features', ['etms']);
        odd = (await tx.company.findUniqueOrThrow({ where: { id: o.id }, select: { settings: true } })).settings;
        throw new Rollback();
      })
      .catch((e: unknown) => {
        if (!(e instanceof Rollback)) throw e;
      });
    expect(after).toEqual({ features: [], thresholds: { overspeedKmh: 90 }, driverEvents: { cabinChannel: 1 }, etms: { directoryListed: true } });
    expect(odd).toEqual({ features: ['etms'] });
  });
});
