import type { SolverProblem } from '@veetracer/shared';
import { OptimizerClient } from '../routing/optimizer/optimizer.client';
import { RoutingError } from '../routing/routing.errors';
import { JobError } from './job-worker';
import type { SolverProblemV2 } from './optimize-problem';
import type { SolverPort } from './optimize-runner';

/**
 * The worker's view of the shared OptimizerClient (E4-D salvage, `routing/optimizer/optimizer.client.ts`,
 * `POST {OPTIMIZER_URL}/optimize`): its RoutingError codes become job error codes. OPTIMIZER_BUSY (429) and
 * OPTIMIZER_UNAVAILABLE (unreachable, 5xx incl. 503 = a solver worker process died, unreadable answer) are retried by
 * the job; a rejected problem (400 / 413, LIMIT_EXCEEDED there) is final as INVALID_INPUT; a refused token / source
 * (401 / 403, OPTIMIZER_REFUSED) is final under its own code.
 * Cancel / timeout / lease loss abort the job run at once (the runner races the abort signal); the HTTP call itself
 * ends at the client's own timeout (solver limit + 15 s).
 */
export function solverPort(client: Pick<OptimizerClient, 'solve'>): SolverPort {
  return {
    async solve(problem: SolverProblemV2, signal?: AbortSignal) {
      if (signal?.aborted) throw signal.reason as Error;
      try {
        // v2 fields (trip, nullable start / end, weights) are additive to the shared v1 type (README "contract v2").
        return await client.solve(problem as unknown as SolverProblem);
      } catch (e) {
        if (e instanceof RoutingError) {
          if (e.code === 'OPTIMIZER_BUSY' || e.code === 'OPTIMIZER_UNAVAILABLE') throw new JobError(e.code, e.message);
          // E4 review L4: token / source refused: final (not in TRANSIENT_CODES), with its own code.
          if (e.code === 'OPTIMIZER_REFUSED') throw new JobError(e.code, e.message);
          throw new JobError('INVALID_INPUT', `Optimizer rejected the problem: ${e.message.slice(0, 200)}`);
        }
        throw e;
      }
    },
  };
}

export interface OptimizerHealth {
  configured: boolean;
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
}

/** /health probe with latency, for System Health and the worker heartbeat. */
export async function optimizerHealth(client: Pick<OptimizerClient, 'health' | 'configured' | 'config'>): Promise<OptimizerHealth> {
  if (!client.configured) return { configured: false, ok: false, latencyMs: null, error: client.config.problem ?? 'not configured' };
  const t0 = Date.now();
  const ok = await client.health();
  return { configured: true, ok, latencyMs: ok ? Date.now() - t0 : null, error: ok ? null : 'not answering /health (down, busy or token refused)' };
}

/** Probe URL for display (no userinfo / query). */
export function optimizerProbeUrl(client: Pick<OptimizerClient, 'configured' | 'config'>): string | null {
  if (!client.configured) return null;
  try {
    const u = new URL(`${client.config.baseUrl}/health`);
    u.username = '';
    u.password = '';
    u.search = '';
    return u.toString();
  } catch {
    return null;
  }
}
