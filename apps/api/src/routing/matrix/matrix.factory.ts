import type Redis from 'ioredis';
import { readRouterConfig, RouterConfig } from '../provider/router-config';
import { GraphHopperMatrixEngine } from './gh-matrix-client';
import { MatrixBuilder, MatrixEngineSource } from './matrix-builder';
import { MatrixCache, redisCacheClient } from './matrix-cache';
import { MatrixConfig, readMatrixConfig } from './matrix-config';
import { MATRIX_STATS_KEY, MATRIX_STATS_TTL_SEC, MatrixMetrics } from './matrix-metrics';

/** The engine for the matrix: GraphHopper only, from the single `ROUTER_URL` + `ROUTER_ENGINE=graphhopper` (doc 17 R-3). */
export function matrixEngineSource(router: RouterConfig): MatrixEngineSource {
  if (router.state === 'graphhopper') return { engine: new GraphHopperMatrixEngine(router.baseUrl) };
  return { engine: null, reason: router.state === 'disabled' ? 'ENGINE_DISABLED' : 'ENGINE_NOT_SUPPORTED', message: router.message };
}

/** Builder wired to Valkey (cache + stats). `redis` null = no cache, no published stats (tests, CLI). */
export function createMatrixBuilder(
  redis: Redis | null,
  env: NodeJS.ProcessEnv = process.env,
  config: MatrixConfig = readMatrixConfig(env),
  router: RouterConfig = readRouterConfig(env),
): MatrixBuilder {
  const cache = new MatrixCache(redis ? redisCacheClient(redis) : null, config.cacheSecret, config.cacheTtlSec, config.cacheMaxCells);
  const metrics = new MatrixMetrics();
  if (redis) metrics.publish = (s) => redis.set(MATRIX_STATS_KEY, JSON.stringify(s), 'EX', MATRIX_STATS_TTL_SEC);
  return new MatrixBuilder(config, matrixEngineSource(router), cache, metrics);
}
