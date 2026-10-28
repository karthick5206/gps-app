import { apiPlanPriceKey, cappedKeyRates, DEFAULT_API_PLANS, readApiPlans } from '@veetracer/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiAccessDecision, apiMigrationSeatDue, currentApiSeat, webhooksLeft } from './api-access';
import { ApiAccessService } from './api-access.service';
import { applyPartnerApiPrices, LicenceSettingsService } from './licence-settings.service';
import { quoteLines, summarise } from './seat-logic';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-19T06:00:00Z');
const seat = (days: number, apiPlan = 'BASIC', id = 's1') => ({ id, expiresAt: new Date(NOW + days * DAY), apiPlan });

describe('Developer API plans', () => {
  it('defaults match the owner pricing (GST inclusive, per account per year)', () => {
    expect(DEFAULT_API_PLANS.BASIC).toEqual({ pricePaise: 600_000, maxVehicles: 25, ratePerMinute: 60, ratePerDay: 10_000, maxWebhooks: 1 });
    expect(DEFAULT_API_PLANS.STANDARD).toEqual({ pricePaise: 1_500_000, maxVehicles: 100, ratePerMinute: 120, ratePerDay: 50_000, maxWebhooks: 5 });
    expect(DEFAULT_API_PLANS.ENTERPRISE).toEqual({ pricePaise: 4_000_000, maxVehicles: null, ratePerMinute: 300, ratePerDay: 250_000, maxWebhooks: 20 });
  });

  it('price and limit edits are sanitised; missing values fall back to the defaults', () => {
    const p = readApiPlans({ BASIC: { pricePaise: 700_000.4, maxVehicles: '30', ratePerMinute: -5 }, STANDARD: { maxVehicles: null }, ENTERPRISE: 'junk' });
    expect(p.BASIC).toEqual({ pricePaise: 700_000, maxVehicles: 30, ratePerMinute: 1, ratePerDay: 10_000, maxWebhooks: 1 });
    expect(p.STANDARD.maxVehicles).toBeNull();
    expect(p.ENTERPRISE).toEqual(DEFAULT_API_PLANS.ENTERPRISE);
  });

  it('saves edited plans from Platform Settings → Licence pricing', async () => {
    let stored: Record<string, unknown> = { apiPlans: {}, pricesPaise: {}, gstRatePct: 18, graceDays: 15, overrideDays: 30 };
    const prisma = {
      platformBillingSettings: {
        findUnique: jest.fn(async () => stored),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => (stored = { ...stored, ...data })),
      },
    };
    const svc = new LicenceSettingsService(prisma as never);
    const plans = { ...DEFAULT_API_PLANS, STANDARD: { ...DEFAULT_API_PLANS.STANDARD, pricePaise: 1_800_000, maxWebhooks: 8 } };
    const out = await svc.updatePricing({ pricesPaise: { GPS_DEVICE: 2, DASHCAM: 3, FUEL_SENSOR: 4, MOBILE_TRACKER: 5 }, apiPlans: plans, gstRatePct: 18, graceDays: 15, overrideDays: 30 });
    expect(out.apiPlans.STANDARD).toMatchObject({ pricePaise: 1_800_000, maxWebhooks: 8 });
    expect(out.apiPlans.BASIC.pricePaise).toBe(600_000);
  });

  it('partner price overrides apply to API plans like other licence types', () => {
    const p = applyPartnerApiPrices(DEFAULT_API_PLANS, { [apiPlanPriceKey('BASIC')]: 500_000, GPS_DEVICE: 1 });
    expect(p.BASIC.pricePaise).toBe(500_000);
    expect(p.BASIC.maxVehicles).toBe(25);
    expect(p.STANDARD.pricePaise).toBe(1_500_000);
  });

  it('quotes an API plan at its price; a renewal keeps the seat plan', () => {
    const prices = { USER: 1, GPS_DEVICE: 1, DASHCAM: 1, FUEL_SENSOR: 1, MOBILE_TRACKER: 1 };
    const paidAt = new Date(NOW);
    const lines = quoteLines([{ type: 'API_ACCESS', quantity: 1, plan: 'STANDARD' }], [{ id: 'a1', type: 'API_ACCESS', expiresAt: new Date(NOW + 10 * DAY), apiPlan: 'ENTERPRISE' }], prices, paidAt, DEFAULT_API_PLANS);
    expect(lines[0]).toMatchObject({ kind: 'NEW', type: 'API_ACCESS', plan: 'STANDARD', amountPaise: 1_500_000 });
    expect(lines[1]).toMatchObject({ kind: 'RENEWAL', plan: 'ENTERPRISE', amountPaise: 4_000_000 });
  });

  it('caps key rates at the plan (minimum of key setting and plan)', () => {
    expect(cappedKeyRates({ ratePerMinute: 600, ratePerDay: 5_000 }, DEFAULT_API_PLANS.BASIC)).toEqual({ perMinute: 60, perDay: 5_000 });
    expect(cappedKeyRates({ ratePerMinute: 30, ratePerDay: 200_000 }, DEFAULT_API_PLANS.STANDARD)).toEqual({ perMinute: 30, perDay: 50_000 });
    expect(cappedKeyRates({ ratePerMinute: 600, ratePerDay: 200_000 }, null)).toEqual({ perMinute: 600, perDay: 200_000 });
  });
});

describe('Developer API licence decisions', () => {
  it('active and grace allow; past grace → LICENCE_EXPIRED; none → LICENCE_REQUIRED; platform exempt', () => {
    expect(apiAccessDecision(seat(30, 'STANDARD'), false, DEFAULT_API_PLANS, NOW, 15)).toMatchObject({ allowed: true, plan: 'STANDARD', limits: DEFAULT_API_PLANS.STANDARD });
    expect(apiAccessDecision(seat(-10), false, DEFAULT_API_PLANS, NOW, 15)).toMatchObject({ allowed: true, code: null });
    expect(apiAccessDecision(seat(-16), false, DEFAULT_API_PLANS, NOW, 15)).toMatchObject({ allowed: false, code: 'LICENCE_EXPIRED' });
    expect(apiAccessDecision(null, false, DEFAULT_API_PLANS, NOW, 15)).toMatchObject({ allowed: false, code: 'LICENCE_REQUIRED' });
    expect(apiAccessDecision(null, true, DEFAULT_API_PLANS, NOW, 15)).toMatchObject({ allowed: true, exempt: true, limits: null });
  });

  it('the latest-expiring seat is the current one (a new plan replaces the old seat)', () => {
    expect(currentApiSeat([seat(-1, 'BASIC', 'old'), seat(365, 'ENTERPRISE', 'new')])?.id).toBe('new');
    expect(currentApiSeat([])).toBeNull();
  });

  it('counts the company API seat as used, once, in the pool summary', () => {
    const s = summarise(
      [
        { id: 'old', type: 'API_ACCESS', expiresAt: new Date(NOW - DAY), userId: null, deviceId: null, fuelObjectId: null, companyId: 'c1' },
        { id: 'new', type: 'API_ACCESS', expiresAt: new Date(NOW + 300 * DAY), userId: null, deviceId: null, fuelObjectId: null, companyId: 'c1' },
      ],
      NOW,
      15,
    ).find((x) => x.type === 'API_ACCESS');
    expect(s).toEqual({ type: 'API_ACCESS', total: 1, used: 1, free: 0, expiring: 0, expired: 0 });
  });

  it('migration seat: only non-platform companies that already created API keys (BASIC, 12 months)', () => {
    expect(apiMigrationSeatDue({ isPlatform: false, apiKeyCount: 2, hasApiSeat: false })).toBe(true);
    expect(apiMigrationSeatDue({ isPlatform: false, apiKeyCount: 0, hasApiSeat: false })).toBe(false);
    expect(apiMigrationSeatDue({ isPlatform: true, apiKeyCount: 3, hasApiSeat: false })).toBe(false);
    expect(apiMigrationSeatDue({ isPlatform: false, apiKeyCount: 1, hasApiSeat: true })).toBe(false);
    const sql = readFileSync(join(__dirname, '..', '..', 'prisma', 'migrations', '20261019210000_licence_credit_notes_api', 'migration.sql'), 'utf8');
    const insert = sql.slice(sql.indexOf('INSERT INTO "LicenceSeat"'));
    expect(insert).toContain(`'API_ACCESS', c."id", 'MIGRATION'`);
    expect(insert).toContain(`INTERVAL '1 year', 'BASIC'`);
    expect(insert).toContain(`c."isPlatform" = false`);
    expect(insert).toContain(`EXISTS (SELECT 1 FROM "ApiKey" k WHERE k."companyId" = c."id")`);
  });
});

describe('Developer API plan limits (service)', () => {
  function service(seats: { expiresAt: Date; apiPlan: string }[], extra: { webhooks?: number; vehicles?: { id: string }[] } = {}) {
    const prisma = {
      licenceSeat: { findMany: jest.fn(async () => seats.map((s, i) => ({ id: `s${i}`, activatedAt: new Date(NOW), source: 'PURCHASE', ...s }))) },
      webhookEndpoint: { count: jest.fn(async () => extra.webhooks ?? 0) },
      trackedObject: {
        findMany: jest.fn(async ({ take }: { take: number }) => (extra.vehicles ?? []).slice(0, take)),
        count: jest.fn(async () => 1),
      },
    };
    const settings = { get: jest.fn(async () => ({ apiPlans: { BASIC: { maxVehicles: 2 } }, graceDays: 15 })) };
    const policy = { isExempt: jest.fn(async () => false) };
    return { svc: new ApiAccessService(prisma as never, settings as never, policy as never, { client: {} } as never), prisma };
  }
  const active = [{ expiresAt: new Date(Date.now() + 100 * DAY), apiPlan: 'BASIC' }];

  it('webhook endpoints: refused with 402 API_WEBHOOK_LIMIT once the plan count is reached', async () => {
    expect(webhooksLeft(0, DEFAULT_API_PLANS.BASIC)).toBe(1);
    expect(webhooksLeft(3, DEFAULT_API_PLANS.STANDARD)).toBe(2);
    await expect(service(active, { webhooks: 0 }).svc.assertWebhookCapacity('c1')).resolves.toBeUndefined();
    await expect(service(active, { webhooks: 1 }).svc.assertWebhookCapacity('c1')).rejects.toMatchObject({ status: 402, code: 'API_WEBHOOK_LIMIT' });
    await expect(service([], { webhooks: 0 }).svc.assertWebhookCapacity('c1')).rejects.toMatchObject({ status: 402, code: 'LICENCE_REQUIRED' });
  });

  it('vehicles: the first N by name are reachable; others get 402 API_VEHICLE_LIMIT', async () => {
    const { svc, prisma } = service(active, { vehicles: [{ id: 'v-a' }, { id: 'v-b' }, { id: 'v-c' }] });
    expect(await svc.allowedVehicleIds('c1')).toEqual(['v-a', 'v-b']);
    expect(prisma.trackedObject.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 2 }));
    await expect(svc.assertVehicleAllowed('c1', 'v-b')).resolves.toBeUndefined();
    await expect(svc.assertVehicleAllowed('c1', 'v-c')).rejects.toMatchObject({ status: 402, code: 'API_VEHICLE_LIMIT' });
  });
});

describe('Developer API upgrade (fulfilment)', () => {
  it('a newly bought plan runs 12 months from payment and ends the running API seat now', async () => {
    const paidAt = new Date(NOW);
    const order = { id: 'o1', companyId: 'c1', partnerId: null, mode: 'UPI', items: { lines: [{ kind: 'NEW', type: 'API_ACCESS', plan: 'ENTERPRISE', quantity: 1, unitPaise: 4_000_000, amountPaise: 4_000_000, periodFrom: '', periodTo: '', seatIds: [] }] } };
    const tx = {
      licenceOrder: { updateMany: jest.fn(async () => ({ count: 1 })), findUniqueOrThrow: jest.fn(async () => order) },
      licenceSeat: { updateMany: jest.fn(async () => ({ count: 1 })), create: jest.fn(async () => ({ id: 'new-seat' })) },
    };
    const prisma = { $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    const invoices = { issue: jest.fn(async () => ({ id: 'inv1' })), deliver: jest.fn(async () => undefined) };
    const { BillingService } = await import('./billing.service');
    const svc = new BillingService(prisma as never, {} as never, { invalidate: jest.fn() } as never, invoices as never, { rebalance: jest.fn(async () => 0) } as never, {} as never, { invalidate: jest.fn() } as never);
    await svc.fulfil('o1', { paidAt, reference: 'UTR' });
    expect(tx.licenceSeat.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { companyId: 'c1', type: 'API_ACCESS', expiresAt: { gt: paidAt } }, data: expect.objectContaining({ expiresAt: paidAt, notifiedState: 'REPLACED' }) }));
    expect(tx.licenceSeat.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'API_ACCESS', apiPlan: 'ENTERPRISE', expiresAt: new Date('2027-10-19T06:00:00Z') }) }));
    expect((invoices.issue.mock.calls as unknown as [unknown, unknown, unknown[]][])[0][2][0]).toMatchObject({ plan: 'ENTERPRISE', seatIds: ['new-seat'] });
  });
});
