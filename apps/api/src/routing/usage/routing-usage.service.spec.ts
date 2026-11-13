import { etmsRoutingEnabled } from '../../etms/transport-feature.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { normaliseDelta, PrismaRoutingUsageStore, RoutingUsageDay, RoutingUsageService, RoutingUsageStore, usageDay, UsageCounters, USAGE_MAX_DAYS } from './routing-usage.service';

const CO = '7d4c6a0e-8a3b-4b8e-9a51-2f6f1f0b9c11';

class MemoryStore implements RoutingUsageStore {
  rows = new Map<string, UsageCounters>();
  calls = 0;
  fail = false;
  lastFrom: Date | null = null;

  async increment(companyId: string, day: Date, inc: UsageCounters): Promise<void> {
    this.calls++;
    if (this.fail) throw new Error('relation "RoutingUsage" does not exist');
    const k = `${companyId}|${day.toISOString().slice(0, 10)}`;
    const cur = this.rows.get(k) ?? { routes: 0, matrixCells: 0, optimizeJobs: 0, cacheHits: 0 };
    this.rows.set(k, {
      routes: cur.routes + inc.routes,
      matrixCells: cur.matrixCells + inc.matrixCells,
      optimizeJobs: cur.optimizeJobs + inc.optimizeJobs,
      cacheHits: cur.cacheHits + inc.cacheHits,
    });
  }

  async list(companyId: string, fromDay: Date): Promise<RoutingUsageDay[]> {
    this.lastFrom = fromDay;
    const from = fromDay.toISOString().slice(0, 10);
    return [...this.rows.entries()]
      .filter(([k]) => k.startsWith(`${companyId}|`) && k.slice(-10) >= from)
      .map(([k, v]) => ({ day: k.slice(-10), ...v }))
      .sort((a, b) => b.day.localeCompare(a.day));
  }
}

const prisma = {} as PrismaService;

describe('RoutingUsageService', () => {
  it('UTC day and delta normalisation', () => {
    expect(usageDay(new Date('2026-11-11T23:59:59+05:30')).toISOString()).toBe('2026-11-11T00:00:00.000Z');
    expect(usageDay(new Date('2026-11-12T01:00:00+05:30')).toISOString()).toBe('2026-11-11T00:00:00.000Z');
    expect(normaliseDelta({ routes: 2.7, matrixCells: -5, optimizeJobs: Number.NaN })).toEqual({ routes: 2, matrixCells: 0, optimizeJobs: 0, cacheHits: 0 });
  });

  it('switched off (ETMS_ROUTING=off kill switch): nothing is written or read', async () => {
    const store = new MemoryStore();
    const svc = new RoutingUsageService(prisma, store, () => etmsRoutingEnabled({ ETMS_ROUTING: 'off' }));
    await svc.add(CO, { routes: 1 });
    expect(store.calls).toBe(0);
    expect(await svc.list(CO, 7)).toEqual([]);
    expect(store.lastFrom).toBeNull();
  });

  it('adds per company and UTC day, newest first', async () => {
    const store = new MemoryStore();
    const svc = new RoutingUsageService(prisma, store, () => true);
    const d1 = new Date('2026-11-10T10:00:00Z');
    const d2 = new Date('2026-11-11T10:00:00Z');
    await svc.add(CO, { routes: 1, cacheHits: 1 }, d1);
    await svc.add(CO, { matrixCells: 2500 }, d2);
    await svc.add(CO, { routes: 2, optimizeJobs: 1 }, d2);
    await svc.add('other', { routes: 9 }, d2);
    await svc.add(CO, {}, d2); // nothing to count: no write
    expect(store.calls).toBe(4);
    expect(await svc.list(CO, 7, d2)).toEqual([
      { day: '2026-11-11', routes: 2, matrixCells: 2500, optimizeJobs: 1, cacheHits: 0 },
      { day: '2026-11-10', routes: 1, matrixCells: 0, optimizeJobs: 0, cacheHits: 1 },
    ]);
    expect(await svc.list(CO, 1, d2)).toHaveLength(1);
  });

  it('clamps the window to 1..400 days', async () => {
    const store = new MemoryStore();
    const svc = new RoutingUsageService(prisma, store, () => true);
    const now = new Date('2026-11-11T10:00:00Z');
    await svc.list(CO, 100_000, now);
    expect(store.lastFrom).toEqual(new Date(usageDay(now).getTime() - (USAGE_MAX_DAYS - 1) * 86_400_000));
    await svc.list(CO, 0, now);
    expect(store.lastFrom).toEqual(new Date('2026-11-11T00:00:00Z'));
  });

  it('a metering failure never fails the routing call', async () => {
    const store = new MemoryStore();
    store.fail = true;
    const svc = new RoutingUsageService(prisma, store, () => true);
    await expect(svc.add(CO, { routes: 1 })).resolves.toBeUndefined();
    expect(store.calls).toBe(1);
  });
});

describe('PrismaRoutingUsageStore', () => {
  const DAY = new Date('2026-11-11T00:00:00Z');

  it('one atomic upsert-increment per call on (companyId, day)', async () => {
    const upsert = jest.fn(async () => ({}));
    await new PrismaRoutingUsageStore({ routingUsage: { upsert } } as never).increment(CO, DAY, { routes: 1, matrixCells: 4, optimizeJobs: 0, cacheHits: 2 });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith({
      where: { companyId_day: { companyId: CO, day: DAY } },
      create: { companyId: CO, day: DAY, routes: 1, matrixCells: 4, optimizeJobs: 0, cacheHits: 2 },
      update: { routes: { increment: 1 }, matrixCells: { increment: 4 }, optimizeJobs: { increment: 0 }, cacheHits: { increment: 2 } },
    });
  });

  it('lists one company from a day, newest first, DATE as YYYY-MM-DD', async () => {
    const findMany = jest.fn(async () => [{ companyId: CO, day: DAY, routes: 3, matrixCells: 0, optimizeJobs: 1, cacheHits: 0, updatedAt: DAY }]);
    const rows = await new PrismaRoutingUsageStore({ routingUsage: { findMany } } as never).list(CO, new Date('2026-11-05T00:00:00Z'));
    expect(rows).toEqual([{ day: '2026-11-11', routes: 3, matrixCells: 0, optimizeJobs: 1, cacheHits: 0 }]);
    expect(findMany).toHaveBeenCalledWith({ where: { companyId: CO, day: { gte: new Date('2026-11-05T00:00:00Z') } }, orderBy: { day: 'desc' } });
  });
});
