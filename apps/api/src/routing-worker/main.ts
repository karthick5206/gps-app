import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from '../config/env';
import { etmsRoutingEnabled } from '../etms/transport-feature.guard';
import { startHeartbeat } from '../monitoring/heartbeat';
import { RedisService } from '../redis/redis.service';
import { optimizerHealth } from '../routing-jobs/optimizer-port';
import { RoutingWorkerHost, RoutingWorkerModule } from './routing-worker.module';

/**
 * ETMS routing worker process (E4 WP 4.2, doc 17 §7 P8): executes optimisation jobs from the Valkey stream
 * `vt:routing:jobs` (RoutingJob rows are the source of truth), separately from the API — same pattern as the notifier /
 * summarizer processes.
 *
 *   node dist/routing-worker/main.js     # ROUTING_WORKER_CONCURRENCY slots (default 1)
 *
 * v1.16: exits 0 at once only when the env kill switch is pulled (ETMS_ROUTING=off or ETMS=off; the systemd unit,
 * Restart=on-failure, then stays stopped). Otherwise it runs and IDLES while the platform switch "Automatic route
 * planning" is off: it reads the switch every ROUTING_SWITCH_CACHE_MS (5 s, one primary-key query), publishes its
 * heartbeat (System Health / readiness need it), does not probe the optimiser and makes no GraphHopper call. Jobs only
 * reach it when the API accepted them (switch on); a job still queued at a switch-off is claimed and ended FAILED
 * ROUTING_OFF without any engine work, a running one finishes. SIGTERM / SIGINT: stop claiming, wait up to ROUTING_WORKER_GRACE_MS (30 s) for
 * running jobs, exit. A crash or kill -9 is recovered by any other worker's lease sweeper (the job is re-queued and
 * never executed twice at the same time; after maxAttempts lost leases it is FAILED with WORKER_LOST).
 * Logs carry job / plan ids, counts and error codes only — never coordinates or names.
 */
async function main(): Promise<void> {
  loadEnv();
  const logger = new Logger('RoutingWorker');
  if (!etmsRoutingEnabled()) {
    logger.warn('ETMS_ROUTING=off (or ETMS=off): the emergency kill switch is on; routing worker not started');
    process.exit(0);
  }
  const app = await NestFactory.createApplicationContext(RoutingWorkerModule, { logger: ['log', 'warn', 'error'] });
  const host = app.get(RoutingWorkerHost);
  const redis = app.get(RedisService);
  const { worker, optimizer, switches } = host;
  let optimizerOk: boolean | null = null;
  let switchOn = await switches.platformOn(true);
  logger.log(`automatic route planning is switched ${switchOn ? 'ON' : 'OFF (idle)'}`);
  // Optimiser probe only while switched on (loopback /health every 30 s); idle costs one switch read per cache TTL.
  const probe = async () => {
    const was = switchOn;
    switchOn = await switches.platformOn();
    if (was !== switchOn) logger.log(`automatic route planning switched ${switchOn ? 'ON' : 'OFF (idle)'}`);
    optimizerOk = switchOn ? (await optimizerHealth(optimizer)).ok : null;
  };
  void probe();
  const probeTimer = setInterval(() => void probe(), 30_000);
  probeTimer.unref();
  const switchTimer = setInterval(() => void switches.platformOn().then((v) => (switchOn = v)), switches.ttlMs);
  switchTimer.unref();
  if (!optimizer.configured) logger.warn('OPTIMIZER_URL / OPTIMIZER_TOKEN not usable: optimisation jobs will fail with OPTIMIZER_UNAVAILABLE');
  const heartbeat = startHeartbeat(redis.client, 'routing-worker', () => ({ ...worker.metrics(), optimizerOk, switchOn }));
  worker.start(Number(process.env.ROUTING_WORKER_CONCURRENCY ?? 1));
  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    logger.log(`${sig}: stopping after the current jobs…`);
    clearInterval(probeTimer);
    clearInterval(switchTimer);
    await worker.stop(Number(process.env.ROUTING_WORKER_GRACE_MS ?? 30_000));
    await heartbeat.stop();
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
