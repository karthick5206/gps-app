import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from '../config/env';
import { etmsRoutingEnabled } from '../etms/transport-feature.guard';
import { startHeartbeat } from '../monitoring/heartbeat';
import { RedisService } from '../redis/redis.service';
import { RoutingWorkerHost, RoutingWorkerModule } from './routing-worker.module';

/**
 * ETMS routing worker process (E4 WP 4.2, doc 17 §7 P8): executes optimisation jobs from the Valkey stream
 * `vt:routing:jobs` (RoutingJob rows are the source of truth), separately from the API — same pattern as the notifier /
 * summarizer processes.
 *
 *   node dist/routing-worker/main.js     # ROUTING_WORKER_CONCURRENCY slots (default 1)
 *
 * Exits 0 at once unless ETMS_ROUTING=on (and ETMS not off): nothing runs by default, and the systemd unit
 * (Restart=on-failure) stays stopped. SIGTERM / SIGINT: stop claiming, wait up to ROUTING_WORKER_GRACE_MS (30 s) for
 * running jobs, exit. A crash or kill -9 is recovered by any other worker's lease sweeper (the job is re-queued and
 * never executed twice at the same time; after maxAttempts lost leases it is FAILED with WORKER_LOST).
 * Logs carry job / plan ids, counts and error codes only — never coordinates or names.
 */
async function main(): Promise<void> {
  loadEnv();
  const logger = new Logger('RoutingWorker');
  if (!etmsRoutingEnabled()) {
    logger.warn('ETMS_ROUTING is not "on" (or ETMS=off): routing worker not started');
    process.exit(0);
  }
  const app = await NestFactory.createApplicationContext(RoutingWorkerModule, { logger: ['log', 'warn', 'error'] });
  const host = app.get(RoutingWorkerHost);
  const redis = app.get(RedisService);
  const { worker, optimizer } = host;
  let optimizerOk: boolean | null = null;
  const probe = async () => {
    optimizerOk = (await optimizer.health()).ok;
  };
  void probe();
  const probeTimer = setInterval(() => void probe(), 30_000);
  probeTimer.unref();
  if (!optimizer.configured) logger.warn('OPTIMIZER_URL / OPTIMIZER_TOKEN not usable: optimisation jobs will fail with OPTIMIZER_UNAVAILABLE');
  const heartbeat = startHeartbeat(redis.client, 'routing-worker', () => ({ ...worker.metrics(), optimizerOk }));
  worker.start(Number(process.env.ROUTING_WORKER_CONCURRENCY ?? 1));
  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    logger.log(`${sig}: stopping after the current jobs…`);
    clearInterval(probeTimer);
    await worker.stop(Number(process.env.ROUTING_WORKER_GRACE_MS ?? 30_000));
    await heartbeat.stop();
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
