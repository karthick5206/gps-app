import { Alert } from '@prisma/client';
import { dedupeKey } from './delivery-state';
import { FakeMailer, FakePush, FakeSms, fakePrisma, makeNotifier } from './notifier.spec-helpers';

jest.mock('./retry', () => {
  const actual = jest.requireActual('./retry');
  // Same retry semantics (3 attempts), no backoff sleeps in unit tests.
  return { ...actual, withRetries: (send: () => Promise<unknown>, attempts = 3) => actual.withRetries(send, attempts, [0, 0]) };
});

const alert = {
  id: '00000000-0000-4000-8000-000000000001',
  companyId: '00000000-0000-4000-8000-0000000000c1',
  objectId: '00000000-0000-4000-8000-0000000000o1',
  type: 'OVERSPEED',
  severity: 'WARNING',
  message: '92 km/h',
  data: {},
  createdAt: new Date('2026-11-14T10:00:00Z'),
  notifiedAt: null,
  notifyError: null,
} as unknown as Alert;
const msg = { templateId: null, subject: '[WARNING] Overspeed: TN 01', body: '<p>Overspeed</p>', text: 'Overspeed', missing: [] };
const r = (address: string) => ({ address }) as never;
type Deliver = (a: Alert, ch: string, rc: unknown, m: unknown) => Promise<'done' | 'busy'>;
const deliverOf = (svc: unknown) => (svc as { deliver: Deliver }).deliver.bind(svc) as Deliver;

describe('NotifierService.processAll (D6 G2 retry budget)', () => {
  const job = (id: string, alertId: string | null = 'a1', logIds: string[] = []) => ({ id, alertId, logIds });

  it('acknowledges a job only after it finished', async () => {
    const { svc, redis } = makeNotifier();
    jest.spyOn(svc, 'handleAlert').mockResolvedValue(undefined);
    await svc.processAll([job('1-0')]);
    expect(redis.client.xack).toHaveBeenCalledWith('vt:notify', 'notifier', '1-0');
  });

  it('does NOT acknowledge a job that threw (left pending for XAUTOCLAIM), and still runs webhooks', async () => {
    const webhooks = { onAlert: jest.fn(async () => undefined) };
    const { svc, redis, prisma } = makeNotifier({ webhooks });
    jest.spyOn(svc, 'handleAlert').mockRejectedValue(new Error('db down'));
    await svc.processAll([job('1-0')], new Map([['1-0', 1]]));
    await svc.processAll([job('1-0')], new Map([['1-0', 4]]));
    expect(redis.client.xack).not.toHaveBeenCalled();
    expect(prisma.alert.updateMany).not.toHaveBeenCalled();
    expect(webhooks.onAlert).toHaveBeenCalledTimes(2);
    expect(svc.metrics().lastError?.message).toBe('db down');
  });

  it('declares the job DEAD at the 5th delivery: notifyError, unfinished rows FAILED, then XACK', async () => {
    const { svc, redis, prisma } = makeNotifier();
    jest.spyOn(svc, 'handleAlert').mockRejectedValue(new Error('provider fault'));
    await svc.processAll([job('1-0', 'a1')], new Map([['1-0', 5]]));
    expect(prisma.alert.updateMany).toHaveBeenCalledWith({ where: { id: 'a1', notifiedAt: null }, data: { notifyError: 'dead after 5 deliveries: provider fault' } });
    expect(prisma.notificationLog.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ alertId: 'a1', status: 'QUEUED' }), data: expect.objectContaining({ status: 'FAILED' }) }));
    expect(redis.client.xack).toHaveBeenCalledWith('vt:notify', 'notifier', '1-0');
    expect(svc.deadJobs).toBe(1);
    expect(svc.metrics().lastError?.message).toContain('DEAD alert a1');
  });

  it('DEAD state stays visible in metrics: deadJobs + lastDead survive later ordinary failures (M1)', async () => {
    const { svc } = makeNotifier();
    const handle = jest.spyOn(svc, 'handleAlert').mockRejectedValue(new Error('template broken'));
    await svc.processAll([job('1-0', 'a1')], new Map([['1-0', 5]]));
    handle.mockRejectedValue(new Error('db blip'));
    await svc.processAll([job('2-0', 'a2')], new Map([['2-0', 1]]));
    const m = svc.metrics();
    expect(m.lastError?.message).toBe('db blip'); // overwritten, as before …
    expect(m.deadJobs).toBe(1); // … but the DEAD counter and record are kept apart
    expect(m.lastDead?.message).toBe('DEAD alert a1: dead after 5 deliveries: template broken');
    expect(m.lastDead?.at).toEqual(expect.any(String));
  });

  it('metrics carry the sweeper counts (un-notified alerts at the last sweep)', async () => {
    const { svc } = makeNotifier();
    expect(svc.metrics()).toMatchObject({ deadJobs: 0, lastDead: null, unnotifiedAlerts: null, lastSweepAt: null, sweptAlerts: 0 });
    svc.attachSweeper({ stats: () => ({ unnotifiedAlerts: 7, lastSweepAt: '2026-11-14T10:00:00.000Z', sweptAlerts: 12 }) });
    expect(svc.metrics()).toMatchObject({ unnotifiedAlerts: 7, lastSweepAt: '2026-11-14T10:00:00.000Z', sweptAlerts: 12 });
  });

  it('a job redelivered beyond the budget is DEAD without running (poison job)', async () => {
    const { svc, redis, prisma } = makeNotifier();
    const handle = jest.spyOn(svc, 'handleAlert').mockResolvedValue(undefined);
    await svc.processAll([job('2-0', 'a2')], new Map([['2-0', 6]]));
    expect(handle).not.toHaveBeenCalled();
    expect(prisma.alert.updateMany).toHaveBeenCalledWith({ where: { id: 'a2', notifiedAt: null }, data: { notifyError: 'dead after 6 deliveries: redelivered without finishing' } });
    expect(redis.client.xack).toHaveBeenCalledWith('vt:notify', 'notifier', '2-0');
  });

  it('a DEAD pre-rendered job closes its QUEUED rows as FAILED', async () => {
    const { svc, prisma } = makeNotifier();
    jest.spyOn(svc, 'handleLogs').mockRejectedValue(new Error('boom'));
    await svc.processAll([job('3-0', null, ['l1', 'l2'])], new Map([['3-0', 5]]));
    expect(prisma.notificationLog.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: ['l1', 'l2'] }, status: 'QUEUED' }) }));
  });

  it('if the DEAD record cannot be written, the entry stays pending (no XACK)', async () => {
    const prisma = fakePrisma();
    prisma.alert.updateMany.mockRejectedValue(new Error('db down'));
    const { svc, redis } = makeNotifier({ prisma });
    jest.spyOn(svc, 'handleAlert').mockRejectedValue(new Error('db down'));
    await expect(svc.processAll([job('1-0')], new Map([['1-0', 5]]))).rejects.toThrow('db down');
    expect(redis.client.xack).not.toHaveBeenCalled();
  });
});

describe('NotifierService per-recipient dedupe (D6 G2)', () => {
  it('claims once per alert + channel + recipient; a redelivered job sends nothing twice', async () => {
    const sms = new FakeSms(true);
    const { svc, ledger } = makeNotifier({ sms });
    const deliver = deliverOf(svc);
    for (let run = 0; run < 3; run++) {
      for (const to of ['+911', '+912', '+913']) await deliver(alert, 'SMS', r(to), msg);
    }
    expect(sms.calls).toBe(3);
    expect(ledger.list).toHaveLength(3);
    expect(new Set(ledger.list.map((x) => x.dedupeKey)).size).toBe(3);
    expect(ledger.list.every((x) => x.status === 'SENT')).toBe(true);
  });

  it('a live lease held by another worker is "busy" (nothing sent)', async () => {
    const sms = new FakeSms(true);
    const { svc, ledger } = makeNotifier({ sms });
    await ledger.claim({ companyId: alert.companyId, alertId: alert.id, channel: 'SMS', recipient: '+911', templateId: null, subject: null, body: 'x', dedupeKey: dedupeKey(alert.id, 'SMS', '+911') });
    expect(await deliverOf(svc)(alert, 'SMS', r('+911'), msg)).toBe('busy');
    expect(sms.calls).toBe(0);
  });

  it('a stale lease is taken over (at most 3 times), then abandoned as FAILED: duplicate external sends are bounded', async () => {
    let hang = true;
    // The provider accepts, then the worker "dies" before recording the status (the promise never settles).
    const sms = new FakeSms(true, (_m, n) => (hang ? new Promise(() => undefined) : { provider: 'fake', messageId: `S-${n}` }));
    const { svc, ledger } = makeNotifier({ sms });
    const deliver = deliverOf(svc);
    for (let i = 0; i < 4; i++) {
      void deliver(alert, 'SMS', r('+911'), msg); // claim (i=0) or takeover (i=1..3), then hang
      await new Promise((res) => setImmediate(res));
      ledger.expireLeases();
    }
    hang = false;
    expect(await deliver(alert, 'SMS', r('+911'), msg)).toBe('done');
    const row = ledger.list[0];
    expect(ledger.list).toHaveLength(1);
    expect(row.status).toBe('FAILED');
    expect(row.error).toBe('abandoned after 3 lease takeovers');
    expect(sms.calls).toBe(4); // 1 original + 3 takeovers = the documented bound (3 extra)
  });

  it('stores and logs no recipient address: hashed dedupe key, takeover log names the row only (PII)', async () => {
    let hang = true;
    const sms = new FakeSms(true, () => (hang ? new Promise(() => undefined) : { provider: 'fake', messageId: 'S-1' }));
    const { svc, ledger } = makeNotifier({ sms });
    const warn = jest.spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn').mockImplementation(() => undefined);
    const deliver = deliverOf(svc);
    void deliver(alert, 'SMS', r('+919800000001'), msg);
    await new Promise((res) => setImmediate(res));
    ledger.expireLeases();
    hang = false;
    await deliver(alert, 'SMS', r('+919800000001'), msg);
    const row = ledger.list[0];
    expect(row.dedupeKey).toMatch(new RegExp(`^${alert.id}:SMS:[0-9a-f]{64}$`));
    expect(row.dedupeKey).not.toContain('9800000001');
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain(`Taking over SMS row ${row.id} of alert ${alert.id}`);
    expect(logged).not.toContain('9800000001');
    expect(logged).not.toContain(row.dedupeKey);
  });
});

describe('NotifierService truthful statuses (D6 G3)', () => {
  const env = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = env;
  });

  async function deliverOne(channel: string, opts: Parameters<typeof makeNotifier>[0] = {}, to = '+919800000001') {
    const n = makeNotifier(opts);
    await deliverOf(n.svc)(alert, channel, r(to), msg);
    return { row: n.ledger.list[0], ...n };
  }

  it('console SMS in production: SKIPPED "SMS provider not configured", provider not called', async () => {
    process.env.NODE_ENV = 'production';
    const sms = new FakeSms(false);
    const { row } = await deliverOne('SMS', { sms });
    expect(row).toMatchObject({ status: 'SKIPPED', error: 'SMS provider not configured', provider: 'console', attempts: 0 });
    expect(sms.calls).toBe(0);
  });

  it('console SMS in development: the copy is written but the status stays SKIPPED', async () => {
    process.env.NODE_ENV = 'development';
    const sms = new FakeSms(false);
    const { row } = await deliverOne('SMS', { sms });
    expect(row).toMatchObject({ status: 'SKIPPED', error: 'SMS provider not configured (development copy only)' });
    expect(sms.calls).toBe(1);
  });

  it('Smartping fake OK: SENT with the provider message id, attempts 1', async () => {
    const sms = new FakeSms(true, () => ({ provider: 'smartping', messageId: 'TX-77' }), 'smartping');
    const { row } = await deliverOne('SMS', { sms });
    expect(row).toMatchObject({ status: 'SENT', provider: 'smartping', providerMessageId: 'TX-77', attempts: 1, error: null });
  });

  it('Smartping fake 5xx: FAILED after 3 attempts with attempts = 3', async () => {
    const sms = new FakeSms(true, () => Promise.reject(new Error('Smartping 503 SUBMIT_FAILED')), 'smartping');
    const { row } = await deliverOne('SMS', { sms });
    expect(sms.calls).toBe(3);
    expect(row).toMatchObject({ status: 'FAILED', attempts: 3, error: 'Smartping 503 SUBMIT_FAILED' });
  });

  it.each([['production'], ['development']])('SMTP / Zoho unset (%s): e-mail SKIPPED "E-mail provider not configured"', async (mode) => {
    process.env.NODE_ENV = mode;
    const mailer = new FakeMailer(null, () => ({ provider: null, messageId: null, file: 'var/mail/x.html' }));
    const { row } = await deliverOne('EMAIL', { mailer }, 'ops@example.com');
    expect(row.status).toBe('SKIPPED');
    expect(row.error).toBe(mode === 'production' ? 'E-mail provider not configured' : 'E-mail provider not configured (development copy only)');
    expect(mailer.sent).toHaveLength(mode === 'production' ? 0 : 1);
  });

  it('Zoho configured: SENT with request id; the Message-ID passed is stable per dedupe key', async () => {
    const mailer = new FakeMailer('zoho', () => ({ provider: 'zoho', messageId: 'zoho-req-9', file: '' }));
    const { row, svc } = await deliverOne('EMAIL', { mailer }, 'ops@example.com');
    expect(row).toMatchObject({ status: 'SENT', provider: 'zoho', providerMessageId: 'zoho-req-9' });
    // A second notifier (e.g. after a takeover) builds the same Message-ID for the same key.
    const again = makeNotifier({ mailer: new FakeMailer('smtp') });
    await deliverOf(again.svc)(alert, 'EMAIL', r('ops@example.com'), msg);
    expect(again.mailer.sent[0].messageId).toBe(mailer.sent[0].messageId);
    expect(mailer.sent[0].messageId).toMatch(/^<[0-9a-f]{32}@veetrax\.notify>$/);
    expect(svc).toBeDefined();
  });

  it('SMTP error: FAILED after 3 attempts', async () => {
    const mailer = new FakeMailer('smtp', () => Promise.reject(new Error('421 try later')));
    const { row } = await deliverOne('EMAIL', { mailer }, 'ops@example.com');
    expect(row).toMatchObject({ status: 'FAILED', attempts: 3, error: '421 try later' });
  });

  it('Expo fake OK: SENT with ticket ids', async () => {
    const push = new FakePush(true, () => ({ sent: 2, invalidTokens: [], error: null, ticketIds: ['T1', 'T2'] }));
    const { row } = await deliverOne('PUSH', { push }, 'user:u1');
    expect(row).toMatchObject({ status: 'SENT', provider: 'expo', providerMessageId: 'T1,T2', attempts: 1 });
  });

  it('Expo fake error ticket: FAILED', async () => {
    const push = new FakePush(true, () => ({ sent: 0, invalidTokens: [], error: 'MessageRateExceeded', ticketIds: [] }));
    const { row } = await deliverOne('PUSH', { push }, 'user:u1');
    expect(row).toMatchObject({ status: 'FAILED', error: 'MessageRateExceeded' });
  });

  it('Expo HTTP failure: FAILED after 3 attempts', async () => {
    const push = new FakePush(true, () => Promise.reject(new Error('Expo push HTTP 503')));
    const { row } = await deliverOne('PUSH', { push }, 'user:u1');
    expect(push.calls).toBe(3);
    expect(row).toMatchObject({ status: 'FAILED', attempts: 3 });
  });

  it('push disabled: SKIPPED "Push provider not configured"', async () => {
    const push = new FakePush(false);
    const { row } = await deliverOne('PUSH', { push }, 'user:u1');
    expect(row).toMatchObject({ status: 'SKIPPED', error: 'Push provider not configured', attempts: 0 });
    expect(push.calls).toBe(0);
  });

  it('Arattai switched off (default): SKIPPED', async () => {
    const { row } = await deliverOne('ARATTAI');
    expect(row).toMatchObject({ status: 'SKIPPED', error: 'Arattai is switched off in Platform Settings' });
  });

  it('WhatsApp: SKIPPED "WhatsApp provider not configured"', async () => {
    const prisma = fakePrisma({ messagingSettings: { findUnique: jest.fn(async () => ({ smsEnabled: true, emailEnabled: true, whatsappEnabled: true, arattaiEnabled: false })) } });
    const { row } = await deliverOne('WHATSAPP', { prisma });
    expect(row).toMatchObject({ status: 'SKIPPED', error: 'WhatsApp provider not configured' });
  });

  it('a Super-Admin-disabled channel stays SKIPPED without calling the provider', async () => {
    const prisma = fakePrisma({ messagingSettings: { findUnique: jest.fn(async () => ({ smsEnabled: false, emailEnabled: true, whatsappEnabled: false, arattaiEnabled: false })) } });
    const sms = new FakeSms(true);
    const { row } = await deliverOne('SMS', { prisma, sms });
    expect(row).toMatchObject({ status: 'SKIPPED', error: 'SMS is switched off in Platform Settings' });
    expect(sms.calls).toBe(0);
  });

  it('metrics count SKIPPED separately from SENT / FAILED', async () => {
    process.env.NODE_ENV = 'production';
    const { svc } = await deliverOne('SMS', { sms: new FakeSms(false) });
    expect(svc.metrics()).toMatchObject({ sent: {}, failed: {}, skipped: 1 });
  });
});
