import { Prisma } from '@prisma/client';
import { DEFAULT_SWEEPER_OPTIONS, NOTIFY_SWEEP_FLOOR, NOTIFY_SWEEP_LOCK, NotifySweeper } from './notify-sweeper';

type Row = { id: string; companyId: string };

function setup(opts: { locked?: boolean; alerts?: Row[]; logs?: Row[]; groups?: unknown[]; xaddError?: Error; xinfoError?: Error } = {}) {
  const queries: Prisma.Sql[] = [];
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...values);
      queries.push(sql);
      if (sql.sql.includes('pg_try_advisory_xact_lock')) return [{ locked: opts.locked ?? true }];
      if (sql.sql.includes('FROM "Alert"')) return opts.alerts ?? [];
      if (sql.sql.includes('FROM "NotificationLog"')) return opts.logs ?? [];
      return [];
    }),
  };
  const db = { $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const xadds: unknown[][] = [];
  const redis = {
    xinfo: jest.fn(async () => {
      if (opts.xinfoError) throw opts.xinfoError;
      return opts.groups ?? [];
    }),
    pipeline: () => {
      const batch: unknown[][] = [];
      return {
        xadd: (...args: unknown[]) => batch.push(args),
        exec: async () => {
          if (opts.xaddError) return batch.map(() => [opts.xaddError, null]);
          xadds.push(...batch);
          return batch.map(() => [null, 'id']);
        },
      };
    },
  };
  let now = Date.parse('2026-11-14T10:00:00Z');
  const clock = { advance: (ms: number) => (now += ms) };
  const sweeper = new NotifySweeper(db as never, redis as never, {}, () => now);
  return { sweeper, db, tx, redis, xadds, queries, clock };
}

const group = (name: string, lag: number, pending: number) => ['name', name, 'consumers', 1, 'pending', pending, 'last-delivered-id', '1-0', 'entries-read', 10, 'lag', lag];

describe('NotifySweeper (D6 G2)', () => {
  it('uses the approved bounds: 60 s minimum age, 24 h window, 500 rows, every 30 s, 5 min re-queue, backlog 1000', () => {
    expect(DEFAULT_SWEEPER_OPTIONS).toMatchObject({ intervalMs: 30_000, minAgeMs: 60_000, windowMs: 86_400_000, batch: 500, requeueEveryMs: 300_000, maxBacklog: 1000, streamKey: 'vt:notify', group: 'notifier' });
  });

  it('queries only un-notified, non-DEAD alerts inside the window, with the index floor literal', async () => {
    const { sweeper, queries } = setup();
    await sweeper.tick();
    const q = queries.find((s) => s.sql.includes('FROM "Alert"'))!;
    expect(q.sql).toContain('"notifiedAt" IS NULL AND "notifyError" IS NULL');
    expect(q.sql).toContain(`TIMESTAMP '${NOTIFY_SWEEP_FLOOR}'`);
    expect(q.sql).toMatch(/"createdAt" < \(now\(\) AT TIME ZONE 'UTC'\) - /);
    expect(q.sql).toMatch(/"createdAt" > \(now\(\) AT TIME ZONE 'UTC'\) - /);
    expect(q.values).toEqual([60_000, 86_400_000, 500]);
    const l = queries.find((s) => s.sql.includes('FROM "NotificationLog"'))!;
    expect(l.sql).toContain(`"status" = 'QUEUED' AND "dedupeKey" IS NULL`);
    expect(l.values).toEqual([300_000, 86_400_000, 500]);
  });

  it('re-queues un-notified alerts as alertId jobs and pre-rendered rows as logIds jobs', async () => {
    const { sweeper, xadds } = setup({ alerts: [{ id: 'a1', companyId: 'c1' }, { id: 'a2', companyId: 'c1' }], logs: [{ id: 'l1', companyId: 'c1' }, { id: 'l2', companyId: 'c2' }] });
    expect(await sweeper.tick()).toEqual({ alerts: 2, logs: 2 });
    expect(xadds.map((a) => a.slice(5))).toEqual([
      ['alertId', 'a1', 'companyId', 'c1', 'swept', '1'],
      ['alertId', 'a2', 'companyId', 'c1', 'swept', '1'],
      ['logIds', '["l1"]', 'companyId', 'c1', 'swept', '1'],
      ['logIds', '["l2"]', 'companyId', 'c2', 'swept', '1'],
    ]);
    expect(xadds[0].slice(0, 4)).toEqual(['vt:notify', 'MAXLEN', '~', 100_000]);
  });

  it('re-queues the same id at most once per 5 minutes', async () => {
    const { sweeper, xadds, clock } = setup({ alerts: [{ id: 'a1', companyId: 'c1' }] });
    await sweeper.tick();
    clock.advance(30_000);
    expect(await sweeper.tick()).toEqual({ alerts: 0, logs: 0 });
    clock.advance(270_000);
    expect(await sweeper.tick()).toEqual({ alerts: 1, logs: 0 });
    expect(xadds).toHaveLength(2);
  });

  it('only one instance sweeps: no lock, no query, no XADD', async () => {
    const { sweeper, tx, xadds, queries } = setup({ locked: false, alerts: [{ id: 'a1', companyId: 'c1' }] });
    expect(await sweeper.tick()).toEqual({ skipped: 'lock', alerts: 0, logs: 0 });
    expect(queries[0].sql).toContain('pg_try_advisory_xact_lock');
    expect(queries[0].values).toEqual([NOTIFY_SWEEP_LOCK]);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(xadds).toHaveLength(0);
  });

  it('pauses while the notifier group is behind (lag + pending > 1000)', async () => {
    const { sweeper, db } = setup({ groups: [group('webhooks', 9999, 0), group('notifier', 900, 101)], alerts: [{ id: 'a1', companyId: 'c1' }] });
    expect(await sweeper.tick()).toEqual({ skipped: 'backlog', alerts: 0, logs: 0 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('sweeps when the backlog is at the limit or the stream does not exist yet', async () => {
    expect((await setup({ groups: [group('notifier', 900, 100)], alerts: [{ id: 'a', companyId: 'c' }] }).sweeper.tick()).alerts).toBe(1);
    expect((await setup({ xinfoError: new Error('ERR no such key'), alerts: [{ id: 'a', companyId: 'c' }] }).sweeper.tick()).alerts).toBe(1);
  });

  it('Valkey down: the tick fails, nothing is marked as queued, and the next tick retries', async () => {
    const s = setup({ alerts: [{ id: 'a1', companyId: 'c1' }], xaddError: new Error('connection refused') });
    await expect(s.sweeper.tick()).rejects.toThrow('connection refused');
    const ok = setup({ alerts: [{ id: 'a1', companyId: 'c1' }] });
    // a fresh sweeper over the same rows re-queues them (the throttle only records successful XADDs)
    expect((await ok.sweeper.tick()).alerts).toBe(1);
    expect((s.sweeper as unknown as { recent: Map<string, number> }).recent.size).toBe(0);
  });

  it('does not overlap ticks', async () => {
    const { sweeper } = setup();
    const first = sweeper.tick();
    expect(await sweeper.tick()).toEqual({ skipped: 'running', alerts: 0, logs: 0 });
    await first;
  });

  it('splits pre-rendered rows into jobs of at most 50 ids', async () => {
    const logs = Array.from({ length: 120 }, (_, i) => ({ id: `l${i}`, companyId: 'c1' }));
    const { sweeper, xadds } = setup({ logs });
    expect((await sweeper.tick()).logs).toBe(120);
    expect(xadds.map((a) => (JSON.parse(a[6] as string) as string[]).length)).toEqual([50, 50, 20]);
  });

  it('reports the un-notified alerts found by the last sweep for the notifier heartbeat (M1)', async () => {
    const { sweeper, clock } = setup({ alerts: [{ id: 'a1', companyId: 'c1' }, { id: 'a2', companyId: 'c1' }] });
    expect(sweeper.stats()).toEqual({ unnotifiedAlerts: null, lastSweepAt: null, sweptAlerts: 0 });
    await sweeper.tick();
    expect(sweeper.stats()).toEqual({ unnotifiedAlerts: 2, lastSweepAt: '2026-11-14T10:00:00.000Z', sweptAlerts: 2 });
    clock.advance(30_000);
    await sweeper.tick(); // still found (not re-queued again within 5 min): the count stays visible
    expect(sweeper.stats()).toMatchObject({ unnotifiedAlerts: 2, lastSweepAt: '2026-11-14T10:00:30.000Z', sweptAlerts: 2 });
  });

  it('without the lock it reports nothing (another instance sweeps)', async () => {
    const { sweeper } = setup({ locked: false, alerts: [{ id: 'a1', companyId: 'c1' }] });
    await sweeper.tick();
    expect(sweeper.stats().unnotifiedAlerts).toBeNull();
  });
});
