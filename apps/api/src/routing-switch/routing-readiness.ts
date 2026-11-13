import { pythonVersionOk, ROUTING_MIN_PYTHON, type RoutingEnvMode, type RoutingReadinessCheck, type RoutingReadinessDto } from '@veetracer/shared';
import type Redis from 'ioredis';
import { HEARTBEAT_TTL_SEC } from '../monitoring/heartbeat';
import { RedisKeys } from '../redis/keys';
import type { OptimizerClient } from '../routing/optimizer/optimizer.client';
import type { ProviderHealth } from '../routing/provider/routing-provider';

/** What the readiness check probes (each port is cheap: loopback /health calls, one Valkey index read). */
export interface ReadinessPorts {
  envMode: RoutingEnvMode;
  optimizer: Pick<OptimizerClient, 'configured' | 'config' | 'healthInfo'>;
  workers: () => Promise<number>;
  engine: () => Promise<ProviderHealth>;
}

const MIN_PY = ROUTING_MIN_PYTHON.join('.');

/**
 * v1.16 "if I enable it, it should work": every item must pass before the platform switch may go ON. Details name what
 * is missing and how to fix it (env names, unit names), never a host, token or coordinate. With ETMS_ROUTING=off
 * nothing is probed (the kill switch wins; the other items read "not checked").
 */
export async function evaluateRoutingReadiness(p: ReadinessPorts, now: Date = new Date()): Promise<RoutingReadinessDto> {
  const checks: RoutingReadinessCheck[] = [];
  if (p.envMode === 'off') {
    checks.push({ key: 'env', ok: false, detail: 'ETMS_ROUTING=off (or ETMS=off) in apps/api/.env is the emergency kill switch. Remove the line (or set ETMS_ROUTING=auto), then restart veetrax-api and veetrax-routing-worker.' });
    for (const key of ['optimizerConfig', 'optimizer', 'optimizerVersion', 'worker', 'engine'] as const) checks.push({ key, ok: false, detail: 'Not checked while the kill switch is on.' });
    return { ready: false, checks, checkedAt: now.toISOString() };
  }
  checks.push({ key: 'env', ok: true, detail: null });
  const [info, workers, engine] = await Promise.all([
    p.optimizer.configured ? p.optimizer.healthInfo() : Promise.resolve(null),
    p.workers().catch(() => 0),
    p.engine().catch((): ProviderHealth => ({ reachable: false, checkedAt: now.toISOString(), message: 'health check failed' })),
  ]);
  checks.push(
    p.optimizer.configured
      ? { key: 'optimizerConfig', ok: true, detail: null }
      : { key: 'optimizerConfig', ok: false, detail: `${p.optimizer.config.problem ?? 'not configured'}. Set OPTIMIZER_URL=http://127.0.0.1:8090 in apps/api/.env; the token comes from /etc/veetrax/optimizer.env (install-ubuntu.sh).` },
  );
  if (!info) checks.push({ key: 'optimizer', ok: false, detail: 'Not checked: the optimiser is not configured.' });
  else checks.push(info.ok ? { key: 'optimizer', ok: true, detail: null } : { key: 'optimizer', ok: false, detail: 'Not answering /health: start veetrax-optimizer (systemctl status veetrax-optimizer) and check the token.' });
  if (!info?.ok) checks.push({ key: 'optimizerVersion', ok: false, detail: 'Not checked: the optimiser is not answering.' });
  else if (!info.python) checks.push({ key: 'optimizerVersion', ok: false, detail: `The optimiser does not report its Python version (older than 0.4): update it with release.sh (Python ${MIN_PY} venv).` });
  else if (!pythonVersionOk(info.python)) checks.push({ key: 'optimizerVersion', ok: false, detail: `Python ${info.python} is older than ${MIN_PY}: rebuild the optimiser venv with Python ${MIN_PY} (install-ubuntu.sh, release.sh).` });
  else if (!info.ortools) checks.push({ key: 'optimizerVersion', ok: false, detail: 'The optimiser does not report its OR-Tools version.' });
  else checks.push({ key: 'optimizerVersion', ok: true, detail: `Python ${info.python}, OR-Tools ${info.ortools}` });
  checks.push(workers > 0 ? { key: 'worker', ok: true, detail: `${workers} running` } : { key: 'worker', ok: false, detail: 'No routing worker heartbeat: start veetrax-routing-worker (systemctl status veetrax-routing-worker).' });
  checks.push(engine.reachable ? { key: 'engine', ok: true, detail: null } : { key: 'engine', ok: false, detail: `GraphHopper is not healthy (${engine.degraded ?? 'ENGINE_UNREACHABLE'}): check ROUTER_URL / ROUTER_ENGINE=graphhopper and the graphhopper service.` });
  return { ready: checks.every((c) => c.ok), checks, checkedAt: now.toISOString() };
}

/** Live routing-worker processes: heartbeat keys `vt:health:proc:routing-worker:*` (TTL 20 s). */
export async function liveRoutingWorkers(client: Pick<Redis, 'zrangebyscore' | 'exists'>, now = Date.now()): Promise<number> {
  try {
    const keys = await client.zrangebyscore(RedisKeys.healthProcessIndex, now - HEARTBEAT_TTL_SEC * 1000, '+inf');
    const mine = keys.filter((k) => k.startsWith(RedisKeys.healthProcess('routing-worker', '')));
    if (!mine.length) return 0;
    return (await Promise.all(mine.map((k) => client.exists(k)))).reduce((n, e) => n + e, 0);
  } catch {
    return 0;
  }
}
