import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { dedupeKey, MAX_TAKEOVERS } from './delivery-state';
import { NotificationLedger } from './notification-ledger';
import { NotifierService } from './notifier.service';
import { NotifySweeper } from './notify-sweeper';
import { FakeMailer, FakeSms } from './notifier.spec-helpers';
import type { SmsMessage, SmsResult } from './sms';

jest.mock('./retry', () => {
  const actual = jest.requireActual('./retry');
  return { ...actual, withRetries: (send: () => Promise<unknown>, attempts = 3) => actual.withRetries(send, attempts, [0, 0]) };
});

/**
 * D6 G2 / G3 on a real PostgreSQL (all migrations incl. 20261114070000_notifier_durability) and a real Valkey.
 * Runs only when NOTIFY_TEST_DATABASE_URL names a scratch database ending in "_test" and NOTIFY_TEST_REDIS_URL names
 * Valkey db 1 (the isolated test instance; never db 0). The stream key is private to the run and deleted afterwards.
 * Optional NOTIFY_EVIDENCE_FILE: the measured numbers are written there as JSON.
 */
const DB_URL = process.env.NOTIFY_TEST_DATABASE_URL ?? '';
const REDIS_URL = process.env.NOTIFY_TEST_REDIS_URL ?? '';
const enabled = /\/[a-z0-9_]+_test(\?|$)/i.test(DB_URL) && /\/1$/.test(REDIS_URL);
const d = enabled ? describe : describe.skip;

d('D6 G2 / G3 durable notifications (real DB + Valkey db 1)', () => {
  jest.setTimeout(120_000);
  const prisma = new PrismaClient({ datasourceUrl: DB_URL });
  const redis = enabled ? new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 }) : (null as unknown as Redis);
  const run = randomUUID().slice(0, 8);
  const stream = `vt:test:g2:${run}:notify`;
  const ids = { partner: randomUUID(), company: randomUUID(), object: randomUUID() };
  const evidence: Record<string, unknown> = { run, date: new Date().toISOString() };
  const env = process.env.NODE_ENV;

  /** Rules / recipients are stubbed (they are not under test); everything else is the real notifier on the real DB. */
  function notifier(opts: { recipients?: string[]; channels?: string[]; sms?: FakeSms; mailer?: FakeMailer; rulesThrow?: Error } = {}) {
    const fakeRedis = { client: { xack: jest.fn(async () => 1), pipeline: () => ({ xpending: () => undefined, exec: async () => [] }) } };
    const svc = new NotifierService(prisma as never, fakeRedis as never, (opts.mailer ?? new FakeMailer(null)) as never, { enabled: false } as never);
    const internals = svc as unknown as Record<string, unknown>;
    const channels = opts.channels ?? ['SMS'];
    const recipients = opts.recipients ?? ['+919800000001'];
    internals.rules = {
      get: async () => {
        if (opts.rulesThrow) throw opts.rulesThrow;
        return { effective: () => new Map([['OVERSPEED', { channels: { WARNING: channels } }]]) };
      },
      invalidate: () => undefined,
    };
    internals.expander = {
      loadLists: async () => [],
      chainFor: async () => ({}),
      resolve: async (_o: unknown, _t: unknown, _s: unknown, chs: string[]) => chs.map((channel) => ({ channel, recipients: recipients.map((address) => ({ address })) })),
      expand: async () => [],
    };
    if (opts.sms) internals.sms = opts.sms;
    return { svc, xack: fakeRedis.client.xack };
  }

  async function makeAlerts(n: number, ageMs = 120_000): Promise<string[]> {
    const created = new Date(Date.now() - ageMs);
    const rows = Array.from({ length: n }, () => ({ id: randomUUID(), companyId: ids.company, objectId: ids.object, type: 'OVERSPEED', severity: 'WARNING' as const, message: '92 km/h', occurredAt: created, createdAt: created }));
    await prisma.alert.createMany({ data: rows });
    return rows.map((r) => r.id);
  }

  const dupRecords = async () =>
    Number(
      (
        await prisma.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM (SELECT 1 FROM "NotificationLog" WHERE "companyId" = ${ids.company}::uuid AND "alertId" IS NOT NULL
           GROUP BY "alertId", "channel", lower("recipient") HAVING count(*) > 1) t`
      )[0].n,
    );

  async function streamJobs(): Promise<string[]> {
    const entries = (await redis.xrange(stream, '-', '+')) as [string, string[]][];
    return entries.map(([, f]) => f[f.indexOf('alertId') + 1]).filter(Boolean);
  }

  const expireLeases = (alertIds: string[]) => prisma.$executeRaw`UPDATE "NotificationLog" SET "nextAttemptAt" = now() - interval '1 second' WHERE "alertId" = ANY(${alertIds}::uuid[]) AND "status" = 'QUEUED'`;
  const sweeper = () => new NotifySweeper(prisma, redis, { streamKey: stream, group: 'notifier' });

  beforeAll(async () => {
    await redis.connect();
    await prisma.partner.create({ data: { id: ids.partner, name: `G2 ${run}`, slug: `g2-${run}` } });
    await prisma.company.create({ data: { id: ids.company, partnerId: ids.partner, name: `G2 ${run}` } });
    await prisma.trackedObject.create({ data: { id: ids.object, companyId: ids.company, name: `TN G2 ${run}` } });
  });

  afterAll(async () => {
    process.env.NODE_ENV = env;
    await prisma.notificationLog.deleteMany({ where: { companyId: ids.company } });
    await prisma.alert.deleteMany({ where: { companyId: ids.company } });
    await prisma.trackedObject.deleteMany({ where: { id: ids.object } });
    await prisma.company.deleteMany({ where: { id: ids.company } });
    await prisma.partner.deleteMany({ where: { id: ids.partner } });
    if (redis) {
      await redis.del(stream);
      redis.disconnect();
    }
    await prisma.$disconnect();
    if (process.env.NOTIFY_EVIDENCE_FILE) writeFileSync(process.env.NOTIFY_EVIDENCE_FILE, JSON.stringify(evidence, null, 2));
  });

  beforeEach(async () => {
    process.env.NODE_ENV = 'production'; // no development copies
    await redis.del(stream);
  });

  it('migration: new columns, the partial unique index, and the sweeper query uses the partial index', async () => {
    const idx = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('NotificationLog_dedupeKey_key', 'Alert_notify_pending_idx', 'NotificationLog_queued_createdAt_idx') ORDER BY indexname`;
    expect(idx.map((i) => i.indexname)).toEqual(['Alert_notify_pending_idx', 'NotificationLog_dedupeKey_key', 'NotificationLog_queued_createdAt_idx']);
    expect(idx.find((i) => i.indexname === 'NotificationLog_dedupeKey_key')!.indexdef).toMatch(/UNIQUE.*WHERE \("dedupeKey" IS NOT NULL\)/);
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(`EXPLAIN SELECT "id" FROM "Alert" WHERE "notifiedAt" IS NULL AND "notifyError" IS NULL
        AND "createdAt" >= TIMESTAMP '2026-11-01 00:00:00' AND "createdAt" < (now() AT TIME ZONE 'UTC') - interval '60 seconds'
        AND "createdAt" > (now() AT TIME ZONE 'UTC') - interval '24 hours' ORDER BY "createdAt" LIMIT 500`);
    });
    expect(plan.map((p) => p['QUERY PLAN']).join('\n')).toContain('Alert_notify_pending_idx');
  });

  describe('per-recipient ledger (SQL)', () => {
    const ledger = new NotificationLedger(prisma);
    const input = (alertId: string, recipient = '+911') => ({ companyId: ids.company, alertId, channel: 'SMS' as const, recipient, templateId: null, subject: null, body: 'x', dedupeKey: dedupeKey(alertId, 'SMS', recipient) });

    it('20 concurrent claims of one key: exactly one wins, one DB record', async () => {
      const [alertId] = await makeAlerts(1);
      const results = await Promise.all(Array.from({ length: 20 }, () => ledger.claim(input(alertId))));
      expect(results.filter((r) => r.kind === 'claimed')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'busy')).toHaveLength(19);
      expect(await prisma.notificationLog.count({ where: { alertId } })).toBe(1);
    });

    it('final rows are "done"; an expired lease is taken over at most 3 times, then abandoned FAILED', async () => {
      const [a, b] = await makeAlerts(2);
      const c = await ledger.claim(input(a));
      expect(c.kind).toBe('claimed');
      await ledger.finish((c as { id: string }).id, 1, { status: 'SENT', error: null, provider: 'fake', sendAttempts: 1 });
      expect((await ledger.claim(input(a))).kind).toBe('done');

      const first = await ledger.claim(input(b));
      expect(first).toMatchObject({ kind: 'claimed', attempts: 1, takeover: false });
      const kinds: string[] = [];
      for (let i = 0; i < MAX_TAKEOVERS + 1; i++) {
        await expireLeases([b]);
        const r = await ledger.claim(input(b));
        kinds.push(r.kind === 'claimed' ? `takeover:${r.attempts}` : r.kind);
      }
      expect(kinds).toEqual(['takeover:2', 'takeover:3', 'takeover:4', 'abandoned']);
      expect(await prisma.notificationLog.findFirst({ where: { alertId: b } })).toMatchObject({ status: 'FAILED', error: 'abandoned after 3 lease takeovers' });
    });
  });

  it('processor saved 100 alerts, the XADD failed: the sweeper recovers every one, each recipient gets exactly one record', async () => {
    // Earlier tests left un-notified alerts of this company: close them so the counts below are exact.
    await prisma.alert.updateMany({ where: { companyId: ids.company, notifiedAt: null }, data: { notifiedAt: new Date() } });
    const alertIds = await makeAlerts(100);
    // (no XADD: the enqueue after the processor's commit "failed")
    const sms = new FakeSms(true);
    const { svc } = notifier({ recipients: ['+919800000001', '+919800000002', '+919800000003'], sms });
    const t0 = Date.now();
    const swept = await sweeper().tick();
    expect(swept.alerts).toBeGreaterThanOrEqual(100);
    const jobs = (await streamJobs()).filter((id) => alertIds.includes(id));
    expect(new Set(jobs)).toEqual(new Set(alertIds));
    for (const id of jobs) await svc.handleAlert(id);
    const recoveryMs = Date.now() - t0;

    expect(await prisma.alert.count({ where: { id: { in: alertIds }, notifiedAt: null } })).toBe(0);
    expect(await prisma.notificationLog.count({ where: { alertId: { in: alertIds } } })).toBe(300);
    expect(await prisma.notificationLog.count({ where: { alertId: { in: alertIds }, status: 'SENT', attempts: 1, providerMessageId: { not: null } } })).toBe(300);
    expect(await dupRecords()).toBe(0);
    expect(sms.calls).toBe(300);

    // Duplicate jobs (stream entry + sweep, or a redelivery): nothing new is sent or recorded.
    for (const id of jobs) await svc.handleAlert(id);
    await redis.del(stream);
    await sweeper().tick();
    expect((await streamJobs()).filter((id) => alertIds.includes(id))).toEqual([]);
    expect(await prisma.notificationLog.count({ where: { alertId: { in: alertIds } } })).toBe(300);
    expect(sms.calls).toBe(300);
    evidence.xaddFailRecovery = { alerts: 100, recipients: 300, lost: 0, duplicateDbRecords: 0, recoveryMs };
  });

  it('a sweep leaves young alerts to the stream path and ignores alerts outside the 24 h window', async () => {
    const [young] = await makeAlerts(1, 10_000);
    const [old] = await makeAlerts(1, 25 * 3600_000);
    await sweeper().tick();
    const jobs = await streamJobs();
    expect(jobs).not.toContain(young);
    expect(jobs).not.toContain(old);
    await prisma.alert.updateMany({ where: { id: { in: [young, old] } }, data: { notifiedAt: new Date() } });
  });

  it('partial resend: the notifier dies after 1 of 3 recipients; after restart all 3 have exactly one record', async () => {
    const [alertId] = await makeAlerts(1);
    const recipients = ['+919811111111', '+919822222222', '+919833333333'];
    // First process: recipient 1 is sent, the other two hang (the process is killed mid-send).
    const dying = new FakeSms(true, (m) => (m.to === recipients[0] ? { provider: 'fake', messageId: 'S1' } : new Promise<SmsResult>(() => undefined)));
    void notifier({ recipients, sms: dying }).svc.handleAlert(alertId);
    await waitFor(async () => (await prisma.notificationLog.count({ where: { alertId, status: 'SENT' } })) === 1);
    expect(await prisma.alert.findUnique({ where: { id: alertId } })).toMatchObject({ notifiedAt: null });

    // Restart (new process); the leases of the dead process expire; the sweeper / redelivery runs the job again.
    await expireLeases([alertId]);
    const fresh = new FakeSms(true);
    await notifier({ recipients, sms: fresh }).svc.handleAlert(alertId);
    const rows = await prisma.notificationLog.findMany({ where: { alertId }, orderBy: { recipient: 'asc' } });
    expect(rows.map((r) => [r.recipient, r.status])).toEqual(recipients.map((x) => [x, 'SENT']));
    expect(fresh.accepted.map((m) => m.to).sort()).toEqual(recipients.slice(1));
    expect(await dupRecords()).toBe(0);
    expect((await prisma.alert.findUnique({ where: { id: alertId } }))!.notifiedAt).not.toBeNull();
  });

  it('kill between provider acceptance and the status UPDATE (100 iterations): duplicates are bounded and measured', async () => {
    const alertIds = await makeAlerts(100);
    const accepted = new Map<string, number>();
    const record = (m: SmsMessage, alertId: string) => accepted.set(dedupeKey(alertId, 'SMS', m.to), (accepted.get(dedupeKey(alertId, 'SMS', m.to)) ?? 0) + 1);
    // Process A: the provider accepts, then the process dies before the UPDATE.
    for (const id of alertIds) {
      const crash = new FakeSms(true, (m) => {
        record(m, id);
        return new Promise<SmsResult>(() => undefined);
      });
      void notifier({ sms: crash }).svc.handleAlert(id);
    }
    await waitFor(async () => (await prisma.notificationLog.count({ where: { alertId: { in: alertIds } } })) === 100 && accepted.size === 100);
    // Process B after the lease expired: takes over each row once and sends again.
    await expireLeases(alertIds);
    for (const id of alertIds) {
      const ok = new FakeSms(true, (m) => {
        record(m, id);
        return { provider: 'fake', messageId: 'S' };
      });
      await notifier({ sms: ok }).svc.handleAlert(id);
    }
    const perKey = [...accepted.values()];
    const extra = perKey.map((n) => n - 1);
    const rows = await prisma.notificationLog.findMany({ where: { alertId: { in: alertIds } }, select: { status: true, attempts: true } });
    expect(rows).toHaveLength(100);
    expect(rows.every((r) => r.status === 'SENT' && r.attempts === 2)).toBe(true); // 1 interrupted run + 1 send
    expect(await dupRecords()).toBe(0);
    expect(Math.max(...extra)).toBeLessThanOrEqual(MAX_TAKEOVERS);
    expect(extra.every((e) => e === 1)).toBe(true); // one takeover each = exactly one extra message
    evidence.killMidSend = { iterations: 100, keys: accepted.size, acceptedMessages: perKey.reduce((a, b) => a + b, 0), duplicateExternalMessages: extra.reduce((a, b) => a + b, 0), maxExtraPerKey: Math.max(...extra), bound: MAX_TAKEOVERS, duplicateDbRecords: 0, window: 'provider accepted, process died before the status UPDATE (lease takeover)' };
  });

  it('worst case: a row crashing on every takeover stops at the bound (1 + 3 sends), then FAILED', async () => {
    const [alertId] = await makeAlerts(1);
    let sends = 0;
    const crash = () => new FakeSms(true, () => {
      sends++;
      return new Promise<SmsResult>(() => undefined);
    });
    for (let i = 0; i <= MAX_TAKEOVERS; i++) {
      void notifier({ sms: crash() }).svc.handleAlert(alertId);
      await waitFor(async () => sends === i + 1);
      await expireLeases([alertId]);
    }
    const last = new FakeSms(true);
    await notifier({ sms: last }).svc.handleAlert(alertId);
    expect(last.calls).toBe(0);
    expect(sends).toBe(1 + MAX_TAKEOVERS);
    expect(await prisma.notificationLog.findMany({ where: { alertId } })).toEqual([expect.objectContaining({ status: 'FAILED', error: 'abandoned after 3 lease takeovers' })]);
    expect((await prisma.alert.findUnique({ where: { id: alertId } }))!.notifiedAt).not.toBeNull();
    evidence.slowSendTakeoverChain = { sends, extraMessages: sends - 1, bound: MAX_TAKEOVERS, finalStatus: 'FAILED' };
  });

  it('provider idempotency: the e-mail Message-ID is stable across a crash and takeover of the same dedupe key', async () => {
    const [alertId] = await makeAlerts(1);
    const ids: string[] = [];
    const crashMailer = new FakeMailer('smtp', (m) => {
      ids.push(m.messageId!);
      return new Promise(() => undefined);
    });
    void notifier({ channels: ['EMAIL'], recipients: ['ops@example.com'], mailer: crashMailer }).svc.handleAlert(alertId);
    await waitFor(async () => ids.length === 1);
    await expireLeases([alertId]);
    const okMailer = new FakeMailer('smtp', (m) => {
      ids.push(m.messageId!);
      return { provider: 'smtp', messageId: m.messageId!, file: '' };
    });
    await notifier({ channels: ['EMAIL'], recipients: ['ops@example.com'], mailer: okMailer }).svc.handleAlert(alertId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(await prisma.notificationLog.findFirst({ where: { alertId } })).toMatchObject({ status: 'SENT', providerMessageId: ids[0] });
    evidence.idempotencyKeys = {
      smtp: 'supported (receiver-side): stable Message-ID <sha256(dedupeKey)@veetrax.notify> on every retry / takeover',
      zoho: 'not verifiable (the v1.1 email API call used here has no idempotency field); request_id stored',
      smartping: 'not verifiable (no documented client-reference parameter); transactionId stored',
      expo: 'not supported (push API has no idempotency key); ticket ids stored',
      arattai: 'not verifiable; no id returned',
      measuredStableMessageId: ids[0] === ids[1],
    };
  });

  it('job failure: not acked, redelivered; DEAD at the 5th delivery with notifyError; the sweeper skips it', async () => {
    const [alertId] = await makeAlerts(1);
    const failing = notifier({ rulesThrow: new Error('injected DB fault') });
    const job = { id: '1-0', alertId, logIds: [] };
    for (let n = 1; n <= 4; n++) await failing.svc.processAll([job], new Map([['1-0', n]]));
    expect(failing.xack).not.toHaveBeenCalled();
    expect((await prisma.alert.findUnique({ where: { id: alertId } }))!.notifyError).toBeNull();
    await failing.svc.processAll([job], new Map([['1-0', 5]]));
    expect(failing.xack).toHaveBeenCalledTimes(1);
    expect((await prisma.alert.findUnique({ where: { id: alertId } }))!.notifyError).toBe('dead after 5 deliveries: injected DB fault');
    expect(await streamJobs()).toEqual([]);
    await sweeper().tick();
    expect(await streamJobs()).not.toContain(alertId);

    // Transient fault: fails twice, then succeeds once the fault is removed.
    const [b] = await makeAlerts(1);
    const flaky = notifier({ rulesThrow: new Error('transient') });
    await flaky.svc.processAll([{ id: '2-0', alertId: b, logIds: [] }], new Map([['2-0', 1]]));
    expect(flaky.xack).not.toHaveBeenCalled();
    const healthy = notifier({ sms: new FakeSms(true) });
    await healthy.svc.processAll([{ id: '2-0', alertId: b, logIds: [] }], new Map([['2-0', 2]]));
    expect(healthy.xack).toHaveBeenCalledWith('vt:notify', 'notifier', '2-0');
    expect(await prisma.notificationLog.findMany({ where: { alertId: b } })).toEqual([expect.objectContaining({ status: 'SENT' })]);
  });

  it('Valkey semantics the retry budget relies on: XPENDING times_delivered grows with each XAUTOCLAIM', async () => {
    await redis.xgroup('CREATE', stream, 'notifier', '0', 'MKSTREAM');
    const id = (await redis.xadd(stream, '*', 'alertId', 'x'))!;
    await redis.xreadgroup('GROUP', 'notifier', 'c1', 'COUNT', 1, 'STREAMS', stream, '>');
    const times = async () => Number(((await redis.xpending(stream, 'notifier', id, id, 1)) as [string, string, number, number][])[0][3]);
    expect(await times()).toBe(1);
    for (let n = 2; n <= 5; n++) {
      const reply = (await redis.xautoclaim(stream, 'notifier', 'c2', 0, '0-0', 'COUNT', 10)) as unknown[];
      expect(reply).toHaveLength(3); // [next, entries, deletedIds] (Valkey / Redis >= 7)
      expect(await times()).toBe(n);
    }
    await redis.xack(stream, 'notifier', id);
    expect(await redis.xpending(stream, 'notifier', id, id, 1)).toEqual([]);
  });

  it('zero-channel and zero-recipient alerts get notifiedAt and are never swept', async () => {
    const [noChannel, noRecipient] = await makeAlerts(2);
    await notifier({ channels: [] }).svc.handleAlert(noChannel);
    await notifier({ recipients: [] }).svc.handleAlert(noRecipient);
    const rows = await prisma.alert.findMany({ where: { id: { in: [noChannel, noRecipient] } } });
    expect(rows.every((r) => r.notifiedAt !== null)).toBe(true);
    await sweeper().tick();
    const jobs = await streamJobs();
    expect(jobs).not.toContain(noChannel);
    expect(jobs).not.toContain(noRecipient);
  });

  it('alerts handled by the previous notifier (rows without dedupe key) are marked notified, not re-sent', async () => {
    const [alertId] = await makeAlerts(1);
    await prisma.notificationLog.create({ data: { companyId: ids.company, alertId, channel: 'SMS', recipient: '+911', body: 'old', status: 'SENT', provider: 'console' } });
    const sms = new FakeSms(true);
    await notifier({ sms }).svc.handleAlert(alertId);
    expect(sms.calls).toBe(0);
    expect(await prisma.notificationLog.count({ where: { alertId } })).toBe(1);
    expect((await prisma.alert.findUnique({ where: { id: alertId } }))!.notifiedAt).not.toBeNull();
  });

  it('G3 on the test instance without providers: SMS + e-mail alert gives SKIPPED "provider not configured", no SENT', async () => {
    const [alertId] = await makeAlerts(1);
    const sms = new FakeSms(false);
    const mailer = new FakeMailer(null, () => ({ provider: null, messageId: null, file: '' }));
    await notifier({ channels: ['SMS', 'EMAIL'], recipients: ['ops@example.com'], sms, mailer }).svc.handleAlert(alertId);
    const rows = await prisma.notificationLog.findMany({ where: { alertId }, orderBy: { channel: 'asc' } });
    expect(rows.map((r) => [r.channel, r.status, r.error, r.provider, r.attempts])).toEqual([
      ['EMAIL', 'SKIPPED', 'E-mail provider not configured', 'mailer', 0],
      ['SMS', 'SKIPPED', 'SMS provider not configured', 'console', 0],
    ]);
    expect(sms.calls + mailer.sent.length).toBe(0);
    expect((await prisma.alert.findUnique({ where: { id: alertId } }))!.notifiedAt).not.toBeNull();
    evidence.g3NoProviders = rows.map((r) => ({ channel: r.channel, status: r.status, error: r.error, provider: r.provider }));
  });

  it('pre-rendered QUEUED messages whose job was lost are re-queued and sent once', async () => {
    const log = await prisma.notificationLog.create({ data: { companyId: ids.company, channel: 'SMS', recipient: '+919844444444', body: 'test', status: 'QUEUED', createdAt: new Date(Date.now() - 10 * 60_000) } });
    const res = await sweeper().tick();
    expect(res.logs).toBeGreaterThanOrEqual(1);
    const entries = (await redis.xrange(stream, '-', '+')) as [string, string[]][];
    const logIds = entries.flatMap(([, f]) => (f.includes('logIds') ? (JSON.parse(f[f.indexOf('logIds') + 1]) as string[]) : []));
    expect(logIds).toContain(log.id);
    const sms = new FakeSms(true);
    const { svc } = notifier({ sms });
    await svc.handleLogs(logIds);
    await svc.handleLogs(logIds); // duplicate job
    expect(sms.calls).toBe(1);
    expect(await prisma.notificationLog.findUnique({ where: { id: log.id } })).toMatchObject({ status: 'SENT', attempts: 1, providerMessageId: 'SMS-1' });
  });
});

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor: condition not met');
}
