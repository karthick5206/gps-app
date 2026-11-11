/**
 * Routing usage metering on a real PostgreSQL with all migrations applied (table `RoutingUsage` from
 * routing_engine_v2). Not part of the normal run (testRegex is *.spec.ts):
 *   ETMS_DB_TEST_URL=postgresql://user:pass@localhost:5432/veetrax_e4d_usage_test \
 *     npx jest --testRegex 'routing-usage\.db-test\.ts$' --runInBand
 * Allowed databases: *_test only (see test/scratch-db.ts). Concurrent increments need real commits, so the suite
 * creates one synthetic partner + company and deletes them (and their usage rows) afterwards.
 */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { dbDescribe } from '../../test/scratch-db';
import { PrismaRoutingUsageStore, RoutingUsageService } from './routing-usage.service';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d } = dbDescribe(URL_);

d('RoutingUsage metering (real database)', () => {
  jest.setTimeout(60_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const run = randomUUID().slice(0, 8);
  const ids = { partner: randomUUID(), a: randomUUID(), b: randomUUID() };

  beforeAll(async () => {
    await prisma.partner.create({ data: { id: ids.partner, name: `usage ${run}`, slug: `usage-${run}` } });
    await prisma.company.create({ data: { id: ids.a, partnerId: ids.partner, name: `usage A ${run}` } });
    await prisma.company.create({ data: { id: ids.b, partnerId: ids.partner, name: `usage B ${run}` } });
  });

  afterAll(async () => {
    await prisma.routingUsage.deleteMany({ where: { companyId: { in: [ids.a, ids.b] } } });
    await prisma.company.deleteMany({ where: { id: { in: [ids.a, ids.b] } } });
    await prisma.partner.delete({ where: { id: ids.partner } });
    await prisma.$disconnect();
  });

  it('concurrent increments are atomic, per company and UTC day', async () => {
    const svc = new RoutingUsageService(prisma as never, new PrismaRoutingUsageStore(prisma as never), () => true);
    const day1 = new Date('2026-11-10T20:00:00Z');
    const day2 = new Date('2026-11-11T03:00:00Z');
    await Promise.all(Array.from({ length: 25 }, () => svc.add(ids.a, { routes: 1, matrixCells: 4 }, day2)));
    await Promise.all([svc.add(ids.a, { optimizeJobs: 1 }, day1), svc.add(ids.b, { routes: 7 }, day2), svc.add(ids.a, { cacheHits: 3 }, day2)]);
    expect(await svc.list(ids.a, 7, day2)).toEqual([
      { day: '2026-11-11', routes: 25, matrixCells: 100, optimizeJobs: 0, cacheHits: 3 },
      { day: '2026-11-10', routes: 0, matrixCells: 0, optimizeJobs: 1, cacheHits: 0 },
    ]);
    expect(await svc.list(ids.b, 7, day2)).toEqual([{ day: '2026-11-11', routes: 7, matrixCells: 0, optimizeJobs: 0, cacheHits: 0 }]);
  });

  it('switched off: no row is written', async () => {
    const svc = new RoutingUsageService(prisma as never, new PrismaRoutingUsageStore(prisma as never), () => false);
    await svc.add(ids.b, { routes: 100 }, new Date('2026-11-01T00:00:00Z'));
    expect(await prisma.routingUsage.count({ where: { companyId: ids.b, day: new Date('2026-11-01T00:00:00Z') } })).toBe(0);
  });
});
