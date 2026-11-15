import { HttpException, Injectable, Logger } from '@nestjs/common';
import { Interval, Timeout } from '@nestjs/schedule';
import { addDaysYmd, periodBounds, type AvailabilityFrequency } from '@veetracer/shared';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AvailabilityService } from './availability.service';
import { CustomerInvoicesService } from './invoices.service';
import { localYmd, systemCtx } from './pricing-common';
import { TripPricingService } from './trip-pricing.service';

export const PRICING_JOB_LOCK_KEY = 'vt:pricing:billing:lock';
const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const LOCK_MS = 30 * 60_000;
/** BILLING_JOB=off is the kill switch (doc 19 §5.8); the job also only touches companies whose `pricing` add-on is on. */
export const billingJobEnabled = (env: NodeJS.ProcessEnv = process.env) => (env.BILLING_JOB ?? 'on').trim().toLowerCase() !== 'off';

/**
 * Doc 19 §5.8 scheduled billing (api process, licence-reminders pattern): a Valkey lock keeps it to one instance; inside,
 * every step is idempotent on its own (current-snapshot unique index for trip pricing, BillingRun row claim per
 * contract + period for period close and invoice generation, invoice-line source keys as the last guard), so a crash or a
 * second instance can never charge twice. Invoices are generated as DRAFTs only; issuing stays a human action.
 */
@Injectable()
export class PricingBillingJobService {
  private readonly logger = new Logger('PricingBillingJob');
  private readonly instance = randomUUID();
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly trips: TripPricingService,
    private readonly availability: AvailabilityService,
    private readonly invoices: CustomerInvoicesService,
  ) {}

  @Timeout(150_000)
  initial(): Promise<void> {
    return this.tick();
  }

  @Interval(30 * 60_000)
  async tick(): Promise<void> {
    if (!billingJobEnabled() || this.running) return;
    this.running = true;
    let locked = false;
    try {
      locked = (await this.redis.client.set(PRICING_JOB_LOCK_KEY, this.instance, 'PX', LOCK_MS, 'NX')) === 'OK';
      if (!locked) return;
      await this.run(new Date());
    } catch (error) {
      this.logger.error(`Billing job failed: ${(error as Error).message}`);
    } finally {
      if (locked) await this.redis.client.eval(RELEASE_LOCK, 1, PRICING_JOB_LOCK_KEY, this.instance).catch(() => undefined);
      this.running = false;
    }
  }

  /** One pass over every company with the `pricing` add-on. Returns counters (for tests / logs). */
  async run(now: Date): Promise<{ companies: number; tripsPriced: number; periodsClosed: number; invoicesDrafted: number }> {
    const companies = await this.prisma.$queryRaw<{ id: string; timezone: string }[]>`
      SELECT "id", "timezone" FROM "Company" WHERE "status" = 'ACTIVE' AND ("isPlatform" OR "settings"->'features' @> '["pricing"]'::jsonb)`;
    let tripsPriced = 0;
    let periodsClosed = 0;
    let invoicesDrafted = 0;
    for (const c of companies) {
      const ctx = systemCtx(c.id);
      try {
        tripsPriced += await this.trips.pricePending(ctx);
      } catch (e) {
        this.logger.warn(`trip pricing ${c.id}: ${(e as Error).message}`);
      }
      const today = localYmd(now, c.timezone);
      // The previous billing period of each contract, once it has fully ended (one day of grace for late trips).
      const contracts = await this.prisma.pricingContract.findMany({ where: { companyId: c.id, status: 'ACTIVE', billingFrequency: { in: ['DAILY', 'WEEKLY', 'MONTHLY'] } } });
      for (const contract of contracts) {
        const ref = addDaysYmd(today, -2);
        const { start, end } = periodBounds(contract.billingFrequency as AvailabilityFrequency, ref);
        if (end >= addDaysYmd(today, -1)) continue;
        const hasFee = await this.prisma.pricingVehicleAssignment.count({ where: { contractId: contract.id } });
        if (hasFee) {
          try {
            const r = await this.availability.close(ctx, contract.id, end, null);
            periodsClosed += r.periods.filter((p) => p.status === 'CLOSED').length;
          } catch (e) {
            if (!(e instanceof HttpException && [409, 404].includes(e.getStatus()))) this.logger.warn(`period close ${contract.id}: ${(e as Error).message}`);
          }
        }
        try {
          await this.invoices.generate(ctx, { contractId: contract.id, periodStart: start, periodEnd: end, branchId: null }, `job:${contract.id}:${start}`);
          invoicesDrafted++;
        } catch (e) {
          if (!(e instanceof HttpException && [409, 422].includes(e.getStatus()))) this.logger.warn(`invoice ${contract.id}: ${(e as Error).message}`);
        }
      }
    }
    return { companies: companies.length, tripsPriced, periodsClosed, invoicesDrafted };
  }
}
