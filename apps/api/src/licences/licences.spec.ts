import { DEFAULT_API_PLANS } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { BillingService } from './billing.service';
import { nextInvoiceSeq } from './invoice-numbering';
import { LicencePolicyService } from './licence-policy.service';
import { istHour, reminderText } from './licence-reminders.service';
import { hmacHex, verifyCheckoutSignature, verifyWebhookSignature, webhookPayment } from './razorpay';
import { isFree, pickFreeSeat, quoteLines, reminderDue, SeatLike, summarise } from './seat-logic';
import { LicenceRequiredException, SeatsService } from './seats.service';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-19T06:00:00Z');

const seat = (id: string, days: number, subject: Partial<SeatLike> = {}, type: SeatLike['type'] = 'GPS_DEVICE'): SeatLike => ({
  id,
  type,
  expiresAt: new Date(NOW + days * DAY),
  userId: null,
  deviceId: null,
  fuelObjectId: null,
  ...subject,
});

describe('seat assignment and reuse', () => {
  it('picks a free, unexpired seat of the type — the one expiring first', () => {
    const seats = [seat('a', 200, { deviceId: 'd1' }), seat('b', 300), seat('c', 100), seat('d', -1), seat('e', 50, {}, 'USER')];
    expect(pickFreeSeat(seats, 'GPS_DEVICE', NOW)?.id).toBe('c');
    expect(pickFreeSeat(seats, 'USER', NOW)?.id).toBe('e');
    expect(pickFreeSeat(seats, 'DASHCAM', NOW)).toBeNull();
  });

  it('a deleted subject leaves its seat in the pool, reused by the next one', () => {
    const pool = [seat('a', 200, { deviceId: 'd1' })];
    expect(pickFreeSeat(pool, 'GPS_DEVICE', NOW)).toBeNull();
    pool[0].deviceId = null; // device deleted → FK sets the seat's subject to null
    expect(isFree(pool[0])).toBe(true);
    expect(pickFreeSeat(pool, 'GPS_DEVICE', NOW)?.id).toBe('a');
  });

  it('an expired seat is never handed out (not even in grace)', () => {
    expect(pickFreeSeat([seat('x', -2)], 'GPS_DEVICE', NOW)).toBeNull();
  });

  it('summarises total / used / free / expiring / expired per type', () => {
    const s = summarise([seat('a', 200, { deviceId: 'd' }), seat('b', 10), seat('c', -5, { deviceId: 'e' }), seat('u', 90, { deviceId: 'p1' }, 'MOBILE_TRACKER')], NOW, 15);
    expect(s.find((x) => x.type === 'GPS_DEVICE')).toEqual({ type: 'GPS_DEVICE', total: 2, used: 1, free: 1, expiring: 1, expired: 1 });
    expect(s.find((x) => x.type === 'MOBILE_TRACKER')).toMatchObject({ total: 1, used: 1, free: 0 });
    // Users are free: no USER line any more.
    expect(s.find((x) => (x.type as string) === 'USER')).toBeUndefined();
  });

  const ctx = (sa: boolean, override?: string): AuthContext =>
    ({ userId: 'u', homeCompanyId: 'c', companyId: 'c', isSuperAdmin: sa, permissions: {}, dataScope: 'COMPANY', branchIds: [], objectIds: [], ip: null, licenceOverride: override }) as AuthContext;

  function seatsService(free: { id: string }[], platform = false) {
    const created: unknown[] = [];
    const audits: unknown[] = [];
    const policy = { isExempt: jest.fn(async () => platform), invalidate: jest.fn() } as unknown as LicencePolicyService;
    const settings = { get: jest.fn(async () => ({ overrideDays: 30 })) };
    const audit = { record: jest.fn(async (...a: unknown[]) => void audits.push(a)) };
    const svc = new SeatsService(policy, settings as never, audit as never);
    const tx = {
      $queryRaw: jest.fn(async () => free.splice(0, 1)),
      // A business account: no free trial, so "no free seat" still means LICENCE_REQUIRED.
      company: { findUnique: jest.fn(async () => ({ accountType: 'BUSINESS' })) },
      licenceSeat: { create: jest.fn(async ({ data }: { data: unknown }) => (created.push(data), { id: 'new' })) },
    };
    return { svc, tx, created, audits };
  }

  it('assigns a free seat from the pool', async () => {
    const { svc, tx } = seatsService([{ id: 's1' }]);
    await expect(svc.assign(tx as never, ctx(false), 'c', 'GPS_DEVICE', 'd1')).resolves.toBe('s1');
  });

  it('refuses without a free seat (402 LICENCE_REQUIRED); an override from a non-Super Admin is ignored', async () => {
    const { svc, tx } = seatsService([]);
    await expect(svc.assign(tx as never, ctx(false, 'please'), 'c', 'GPS_DEVICE', 'd2')).rejects.toBeInstanceOf(LicenceRequiredException);
    const err = await svc.assign(tx as never, ctx(false), 'c', 'GPS_DEVICE', 'd2').catch((e: LicenceRequiredException) => e);
    expect((err as LicenceRequiredException).getStatus()).toBe(402);
    expect((err as LicenceRequiredException).getResponse()).toMatchObject({ code: 'LICENCE_REQUIRED', licenceType: 'GPS_DEVICE' });
  });

  it('a Super Admin override grants a short complimentary seat and is audited', async () => {
    const { svc, tx, created, audits } = seatsService([]);
    await expect(svc.assign(tx as never, ctx(true, 'Demo for customer'), 'c', 'DASHCAM', 'd3')).resolves.toBe('new');
    expect(created[0]).toMatchObject({ type: 'DASHCAM', source: 'OVERRIDE', deviceId: 'd3', companyId: 'c' });
    expect(audits).toHaveLength(1);
  });

  it('platform companies need no seats', async () => {
    const { svc, tx } = seatsService([], true);
    await expect(svc.assign(tx as never, ctx(false), 'c', 'GPS_DEVICE', 'd4')).resolves.toBeNull();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('expiry, grace and locking', () => {
  function policy(platform = false) {
    const findMany = jest.fn(async () => [{ id: 'locked-vehicle' }]);
    const prisma = { company: { findUnique: jest.fn(async () => ({ isPlatform: platform })) }, trackedObject: { findMany } };
    const settings = { graceDays: jest.fn(async () => 15) };
    return { p: new LicencePolicyService(prisma as never, settings as never), findMany };
  }

  it('viewing is limited to vehicles whose current device seat is within grace', async () => {
    const { p } = policy();
    const where = (await p.viewableWhere({ companyId: 'c', isSuperAdmin: false }, NOW)) as { OR: unknown[] };
    expect(JSON.stringify(where)).toContain(new Date(NOW - 15 * DAY).toISOString());
    expect(where.OR).toHaveLength(2);
    await expect(p.assertViewable({ companyId: 'c', isSuperAdmin: false }, 'locked-vehicle')).rejects.toMatchObject({ status: 403 });
    await expect(p.assertViewable({ companyId: 'c', isSuperAdmin: false }, 'other')).resolves.toBeUndefined();
  });

  it('Super Admins and platform companies are never locked', async () => {
    const sa = policy();
    expect(await sa.p.viewableWhere({ companyId: 'c', isSuperAdmin: true })).toEqual({});
    expect((await sa.p.lockedObjectIds({ companyId: 'c', isSuperAdmin: true })).size).toBe(0);
    expect(sa.findMany).not.toHaveBeenCalled();
    const platform = policy(true);
    expect(await platform.p.viewableWhere({ companyId: 'c', isSuperAdmin: false })).toEqual({});
  });

  it('only hides data: the gateway and processor (recording) never consult licences', () => {
    const { readdirSync, readFileSync, statSync } = jest.requireActual<typeof import('node:fs')>('node:fs');
    const { join } = jest.requireActual<typeof import('node:path')>('node:path');
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
    for (const dir of ['gateway', 'processor']) {
      for (const f of files(join(__dirname, '..', dir)).filter((x) => x.endsWith('.ts'))) expect(readFileSync(f, 'utf8')).not.toMatch(/licences\//);
    }
  });

  it('reminders from 20 days before, on the expiry day, during grace and on the lock day, each once', () => {
    const at = (days: number) => new Date(NOW + days * DAY);
    const due = (state: string, daysLeft: number, locked = false) => ({ state, daysLeft, locked });
    expect(reminderDue(at(30), null, NOW)).toBeNull();
    expect(reminderDue(at(20), null, NOW)).toEqual(due('D20', 20));
    expect(reminderDue(at(19), 'D20', NOW)).toBeNull();
    expect(reminderDue(at(15), 'D20', NOW)).toEqual(due('D15', 15));
    expect(reminderDue(at(10), 'D15', NOW)).toEqual(due('D10', 10));
    expect(reminderDue(at(7), 'D10', NOW)).toEqual(due('D7', 7));
    expect(reminderDue(at(5), 'D7', NOW)).toEqual(due('D5', 5));
    expect(reminderDue(at(3), 'D5', NOW)).toEqual(due('D3', 3));
    expect(reminderDue(at(2), 'D3', NOW)).toEqual(due('D2', 2));
    expect(reminderDue(at(1), 'D2', NOW)).toEqual(due('D1', 1));
    expect(reminderDue(at(-0.5), 'D1', NOW)).toEqual(due('D0', 0));
    expect(reminderDue(at(-0.5), 'D0', NOW)).toBeNull();
    // grace (15 days): 3, 7, 10 days after expiry, then the lock day; nothing after that
    expect(reminderDue(at(-3), 'D0', NOW, 15)).toEqual(due('D-3', -3));
    expect(reminderDue(at(-7), 'D-3', NOW, 15)).toEqual(due('D-7', -7));
    expect(reminderDue(at(-10), 'D-7', NOW, 15)).toEqual(due('D-10', -10));
    expect(reminderDue(at(-15), 'D-10', NOW, 15)).toEqual(due('D-15', -15, true));
    expect(reminderDue(at(-16), 'D-15', NOW, 15)).toBeNull();
    // a short grace skips the grace reminders it doesn't reach
    expect(reminderDue(at(-5), 'D-3', NOW, 5)).toEqual(due('D-5', -5, true));
    // after downtime only the most urgent reminder goes out
    expect(reminderDue(at(3), null, NOW)).toEqual(due('D3', 3));
    expect(reminderDue(at(-20), 'D10', NOW, 15)).toEqual(due('D-15', -20, true));
  });

  it('reminder text covers expiring, expired-in-grace and locked seats', () => {
    const exp = new Date('2026-11-09T00:00:00Z');
    const seat = (daysLeft: number, locked = false) => ({ type: 'GPS_DEVICE' as const, subject: 'device 1', expiresAt: exp, daysLeft, locked });
    expect(reminderText('Acme', [seat(20)], 15).lines[0]).toMatch(/expires on .* \(in 20 days\)/);
    expect(reminderText('Acme', [seat(0)], 15).lines[0]).toMatch(/expires today .* viewing stops on/);
    expect(reminderText('Acme', [seat(-3)], 15).lines[0]).toMatch(/viewing stops on .* \(in 12 days\)/);
    const locked = reminderText('Acme', [seat(-15, true)], 15);
    expect(locked.subject).toMatch(/viewing locked/);
    expect(locked.lines[0]).toMatch(/Data is still being recorded/);
  });

  it('reminders go out 09:00–19:00 IST only', () => {
    expect(istHour(Date.parse('2026-10-19T03:30:00Z'))).toBe(9);
    expect(istHour(Date.parse('2026-10-19T13:29:00Z'))).toBe(18);
    expect(istHour(Date.parse('2026-10-19T20:00:00Z'))).toBe(1);
  });

  it('quote lines: new seats run a year from payment, renewals per seat (no pro-rata)', () => {
    const paidAt = new Date('2026-10-19T06:00:00Z');
    const prices = { GPS_DEVICE: 120_000, DASHCAM: 300_000, FUEL_SENSOR: 80_000, MOBILE_TRACKER: 50_000 };
    const lines = quoteLines([{ type: 'GPS_DEVICE', quantity: 3 }], [{ id: 's1', type: 'MOBILE_TRACKER', expiresAt: new Date('2026-11-01T00:00:00Z') }, { id: 's2', type: 'MOBILE_TRACKER', expiresAt: new Date('2026-01-01T00:00:00Z') }], prices, paidAt, DEFAULT_API_PLANS);
    expect(lines[0]).toMatchObject({ kind: 'NEW', quantity: 3, amountPaise: 360_000, periodTo: '2027-10-19T06:00:00.000Z' });
    expect(lines[1]).toMatchObject({ kind: 'RENEWAL', periodFrom: '2026-11-01T00:00:00.000Z', periodTo: '2027-11-01T00:00:00.000Z', amountPaise: 50_000 });
    expect(lines[2]).toMatchObject({ kind: 'RENEWAL', periodFrom: paidAt.toISOString(), periodTo: '2027-10-19T06:00:00.000Z' });
  });
});

describe('Razorpay signatures', () => {
  it('verifies the webhook HMAC-SHA256 of the raw body (known vector)', () => {
    const body = '{"event":"payment.captured"}';
    const sig = '149f0921b8dab66ba5504a4de4e376f5e30470d680899c30ffda46ef7391a360';
    expect(hmacHex('test_webhook_secret', body)).toBe(sig);
    expect(verifyWebhookSignature('test_webhook_secret', Buffer.from(body), sig)).toBe(true);
    expect(verifyWebhookSignature('test_webhook_secret', Buffer.from(`${body} `), sig)).toBe(false);
    expect(verifyWebhookSignature('other_secret', Buffer.from(body), sig)).toBe(false);
    expect(verifyWebhookSignature('test_webhook_secret', Buffer.from(body), undefined)).toBe(false);
  });

  it('verifies the checkout signature of "order_id|payment_id" (known vector)', () => {
    const sig = '6d0a2f9e0f77d4132453bd423131ef8fa6518e708022b1018c64d955f510a609';
    expect(verifyCheckoutSignature('test_key_secret', 'order_IEIaMR65cu6nz3', 'pay_IH4NVgf4Dreq1l', sig)).toBe(true);
    expect(verifyCheckoutSignature('test_key_secret', 'order_IEIaMR65cu6nz3', 'pay_other', sig)).toBe(false);
  });

  it('reads payment / order ids from webhook payloads', () => {
    expect(webhookPayment({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 118000, status: 'captured' } } } })).toEqual({
      event: 'payment.captured',
      paymentId: 'pay_1',
      orderId: 'order_1',
      amount: 118000,
      status: 'captured',
    });
  });
});

describe('Razorpay webhook processing', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  function billing() {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
    process.env.RAZORPAY_KEY_SECRET = 'test_key_secret';
    process.env.RAZORPAY_WEBHOOK_SECRET = 'test_webhook_secret';
    let status = 'CREATED';
    const order = { id: 'o1', razorpayOrderId: 'order_1', amountPaise: 118000, companyId: 'c1', partnerId: null, items: { lines: [] }, mode: 'ONLINE' };
    const tx = {
      licenceOrder: {
        updateMany: jest.fn(async () => {
          if (status !== 'CREATED') return { count: 0 };
          status = 'PAID';
          return { count: 1 };
        }),
        findUniqueOrThrow: jest.fn(async () => order),
      },
    };
    const prisma = {
      licenceOrder: { findUnique: jest.fn(async () => order), updateMany: jest.fn(async () => ({ count: 1 })) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const invoices = { issue: jest.fn(async () => ({ id: 'inv1' })), deliver: jest.fn(async () => undefined) };
    const pools = { rebalance: jest.fn(async () => 0) };
    const policy = { invalidate: jest.fn() };
    const apiAccess = { invalidate: jest.fn() };
    const svc = new BillingService(prisma as never, {} as never, policy as never, invoices as never, pools as never, {} as never, apiAccess as never);
    return { svc, invoices };
  }

  const payload = (amount = 118000) => Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount, status: 'captured' } } } }));
  const sign = (b: Buffer) => hmacHex('test_webhook_secret', b);

  it('activates once: a duplicate delivery of the same payment is ignored', async () => {
    const { svc, invoices } = billing();
    const body = payload();
    await expect(svc.webhook(body, sign(body))).resolves.toEqual({ ok: true, result: 'activated' });
    await expect(svc.webhook(body, sign(body))).resolves.toEqual({ ok: true, result: 'duplicate' });
    expect(invoices.issue).toHaveBeenCalledTimes(1);
  });

  it('rejects a bad signature and never activates on an amount mismatch', async () => {
    const { svc, invoices } = billing();
    await expect(svc.webhook(payload(), 'deadbeef')).rejects.toMatchObject({ status: 400 });
    const wrong = payload(100);
    await expect(svc.webhook(wrong, sign(wrong))).resolves.toEqual({ ok: true, result: 'amount mismatch' });
    expect(invoices.issue).not.toHaveBeenCalled();
  });
});

describe('invoice numbering under concurrency (simulated row lock)', () => {
  /** Postgres semantics of the counter upsert: the row lock is held until commit / rollback; rollback undoes it. */
  function fakeDb() {
    const committed = new Map<string, number>();
    const locks = new Map<string, Promise<void>>();
    const issued: string[] = [];
    async function transaction<T>(fn: (tx: { $queryRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<{ lastSeq: number }[]> }) => Promise<T>): Promise<T | null> {
      let release: (() => void) | null = null;
      const pending = new Map<string, number>();
      const tx = {
        $queryRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => {
          const fy = String(values[0]);
          while (locks.has(fy)) await locks.get(fy);
          locks.set(fy, new Promise<void>((r) => (release = () => (locks.delete(fy), r()))));
          const next = (committed.get(fy) ?? 0) + 1;
          pending.set(fy, next);
          await new Promise((r) => setTimeout(r, Math.random() * 3));
          return [{ lastSeq: next }];
        },
      };
      try {
        const out = await fn(tx);
        for (const [fy, v] of pending) committed.set(fy, v);
        return out;
      } catch {
        return null;
      } finally {
        (release as (() => void) | null)?.();
      }
    }
    return { transaction, issued, committed };
  }

  it('is consecutive and gap-free per financial year, with concurrent and rolled-back invoices', async () => {
    const db = fakeDb();
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        db.transaction(async (tx) => {
          const fy = i % 3 === 0 ? '2025-26' : '2026-27';
          const seq = await nextInvoiceSeq(tx as never, fy);
          await new Promise((r) => setTimeout(r, Math.random() * 3));
          if (i % 7 === 0) throw new Error('rollback (e.g. e-mail-independent failure inside the transaction)');
          return `${fy}/${seq}`;
        }),
      ),
    );
    const ok = results.filter((r): r is string => !!r);
    for (const fy of ['2025-26', '2026-27']) {
      const seqs = ok.filter((r) => r.startsWith(fy)).map((r) => Number(r.split('/')[1])).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, k) => k + 1));
      expect(db.committed.get(fy)).toBe(seqs.length);
    }
  });
});
