import { Inject, Injectable, Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { RedisService } from '../redis/redis.service';
import { ROUTING_SWEEP_LOCK, type JobQueue } from '../routing-jobs/job-queue';
import type { RoutingJobStore } from '../routing-jobs/job-store';
import { defaultWorkerOptions, RoutingJobWorker } from '../routing-jobs/job-worker';
import { MATRIX_PORT, MatrixPort, providerMatrixPort } from '../routing-jobs/matrix-port';
import { optimizeRunner } from '../routing-jobs/optimize-runner';
import { OptimizerClient } from '../routing-jobs/optimizer.client';
import { PrismaPlanGateway } from '../routing-jobs/prisma-plan-gateway';
import { routingJobProviders } from '../routing-jobs/routing-jobs.module';
import { ROUTING_JOB_QUEUE, ROUTING_JOB_STORE } from '../routing-jobs/routing-jobs.service';
import { InMemoryUsageHook, ROUTING_USAGE_HOOK, RoutingUsageHook, safeUsage } from '../routing-jobs/usage-hook';
import { ROUTING_PROVIDER, RoutingProvider } from '../routing/provider/routing-provider';
import { RoutingModule } from '../routing/routing.module';

/** Builds the job worker of this process (kinds: `optimize`; `matrix` jobs are not executed yet). */
@Injectable()
export class RoutingWorkerHost {
  readonly worker: RoutingJobWorker;

  constructor(
    @Inject(ROUTING_JOB_STORE) store: RoutingJobStore,
    @Inject(ROUTING_JOB_QUEUE) queue: JobQueue,
    plans: PrismaPlanGateway,
    @Inject(MATRIX_PORT) matrix: MatrixPort,
    readonly optimizer: OptimizerClient,
    @Inject(ROUTING_USAGE_HOOK) readonly usage: RoutingUsageHook,
    redis: RedisService,
  ) {
    const sweepLock = async (owner: string, ttlMs: number) => (await redis.client.set(ROUTING_SWEEP_LOCK, owner, 'PX', ttlMs, 'NX').catch(() => null)) === 'OK';
    const runners = new Map([['optimize', optimizeRunner({ plans, matrix, solver: optimizer, usage: safeUsage(usage) })]]);
    this.worker = new RoutingJobWorker(store, queue, runners, defaultWorkerOptions(sweepLock), (job) => plans.release(job));
  }
}

/**
 * Routing worker process (`dist/routing-worker/main.js`, veetrax-routing-worker.service): optimisation jobs from
 * `vt:routing:jobs`. Engine access only through RoutingProvider (GraphHopper; the M1 matrix builder of E4-B plugs in
 * at MATRIX_PORT), the solver through OptimizerClient (OPTIMIZER_URL + OPTIMIZER_TOKEN).
 */
@Module({
  imports: [AppConfigModule, PrismaModule, RedisModule, RoutingModule],
  providers: [
    ...routingJobProviders,
    { provide: MATRIX_PORT, useFactory: (p: RoutingProvider) => providerMatrixPort(p), inject: [ROUTING_PROVIDER] },
    { provide: OptimizerClient, useFactory: () => new OptimizerClient() },
    { provide: ROUTING_USAGE_HOOK, useClass: InMemoryUsageHook },
    RoutingWorkerHost,
  ],
})
export class RoutingWorkerModule {}
