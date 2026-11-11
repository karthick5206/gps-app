import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { routingRateKey, ValkeyJobQueue } from './job-queue';
import { PrismaJobStore } from './prisma-job-store';
import { PrismaPlanGateway } from './prisma-plan-gateway';
import { RoutingJobsController } from './routing-jobs.controller';
import { RateLimiter, ROUTING_JOB_QUEUE, ROUTING_JOB_STORE, ROUTING_PLAN_LINK, ROUTING_RATE_LIMITER, RoutingJobsService } from './routing-jobs.service';

/** Per-user submit counter in Valkey (one-minute window). Valkey down: allowed (the DB limits still apply), logged by the caller. */
export function valkeyRateLimiter(redis: RedisService): RateLimiter {
  return {
    async hit(userId, limit, now) {
      const key = routingRateKey(userId, Math.floor(now / 60_000));
      try {
        const n = await redis.client.incr(key);
        if (n === 1) await redis.client.expire(key, 120);
        return n <= limit;
      } catch {
        return true;
      }
    },
  };
}

/** Shared providers of the API module and the routing-worker module. */
export const routingJobProviders = [
  { provide: ROUTING_JOB_STORE, useFactory: (p: PrismaService) => new PrismaJobStore(p), inject: [PrismaService] },
  { provide: PrismaPlanGateway, useFactory: (p: PrismaService) => new PrismaPlanGateway(p), inject: [PrismaService] },
  { provide: ROUTING_PLAN_LINK, useExisting: PrismaPlanGateway },
  { provide: ROUTING_JOB_QUEUE, useFactory: (r: RedisService) => new ValkeyJobQueue(r.client), inject: [RedisService] },
];

/**
 * API side of the ETMS optimisation jobs (E4 WP 4.2): `/api/routing/jobs` (enqueue / read / list / cancel). The API
 * never executes jobs; `dist/routing-worker/main.js` (veetrax-routing-worker.service) does.
 */
@Module({
  controllers: [RoutingJobsController],
  providers: [
    ...routingJobProviders,
    { provide: ROUTING_RATE_LIMITER, useFactory: valkeyRateLimiter, inject: [RedisService] },
    RoutingJobsService,
  ],
  exports: [RoutingJobsService, ROUTING_JOB_STORE],
})
export class RoutingJobsModule {}
