import { Logger } from '@nestjs/common';
import { SOLVER_LIMITS, SolverProblem, SolverResult } from '@veetracer/shared';
import { etmsRoutingEnabled } from '../../etms/transport-feature.guard';
import { defaultFetch, FetchLike } from '../fetch-like';
import { privateServiceUrlProblem } from '../private-url';
import { RoutingError } from '../routing.errors';


export interface OptimizerClientConfig {
  baseUrl: string;
  token: string;
  /** Why the client is off, for logs and capabilities; null when configured. */
  problem: string | null;
}

/**
 * Reads `OPTIMIZER_URL` / `OPTIMIZER_TOKEN`. The client is configured only when `ETMS_ROUTING=on`, the URL is a
 * private / loopback URL (`privateServiceUrlProblem`) and a token is set (the service refuses to start without one).
 */
export function readOptimizerConfig(env: NodeJS.ProcessEnv = process.env): OptimizerClientConfig {
  const baseUrl = (env.OPTIMIZER_URL ?? '').trim().replace(/\/+$/, '');
  const token = (env.OPTIMIZER_TOKEN ?? '').trim();
  if (!etmsRoutingEnabled(env)) return { baseUrl: '', token: '', problem: 'ETMS_ROUTING is off' };
  if (!baseUrl) return { baseUrl: '', token: '', problem: 'OPTIMIZER_URL is not set' };
  const urlProblem = privateServiceUrlProblem(baseUrl, env);
  if (urlProblem) return { baseUrl: '', token: '', problem: `OPTIMIZER_URL refused: ${urlProblem}` };
  if (!token) return { baseUrl: '', token: '', problem: 'OPTIMIZER_TOKEN is not set' };
  return { baseUrl, token, problem: null };
}

/** Default solver time limit of the service when the problem names none (solver.py). */
export const OPTIMIZER_DEFAULT_TIME_LIMIT_S = 10;
/** Solver time limit plus slack for the matrix upload and serialisation. */
export const OPTIMIZER_TIMEOUT_SLACK_S = 15;
export const OPTIMIZER_HEALTH_TIMEOUT_MS = 2000;

/**
 * HTTP client for the OR-Tools service (`services/routing-optimizer`), ported from the routing branch's
 * `OptimizerAdapter` (doc 17 §5.1, engine-neutral), speaking the shared solver wire format (`SolverProblem` /
 * `SolverResult`, P4). Bearer token on every call; a full service (HTTP 429) is
 * `OPTIMIZER_BUSY` (the job is retried with back-off), a rejected problem (HTTP 400) is `LIMIT_EXCEEDED`, anything
 * else unexpected is `OPTIMIZER_UNAVAILABLE`. The optimiser never sees an engine: the API builds the matrix.
 */
export class OptimizerClient {
  private readonly logger = new Logger(OptimizerClient.name);
  readonly config: OptimizerClientConfig;

  constructor(config?: OptimizerClientConfig, private readonly fetchImpl: FetchLike = defaultFetch) {
    this.config = config ?? readOptimizerConfig();
    // Only a real misconfiguration is worth an error line; "switched off" is the normal state.
    if (this.config.problem && etmsRoutingEnabled() && !/is not set$/.test(this.config.problem)) this.logger.error(this.config.problem);
  }

  get configured(): boolean {
    return this.config.problem === null;
  }

  private headers(json = false): Record<string, string> {
    return { Authorization: `Bearer ${this.config.token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) };
  }

  async health(): Promise<boolean> {
    if (!this.configured) return false;
    try {
      const res = await this.fetchImpl(`${this.config.baseUrl}/health`, { headers: this.headers(), signal: AbortSignal.timeout(OPTIMIZER_HEALTH_TIMEOUT_MS) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async solve(problem: SolverProblem): Promise<SolverResult> {
    if (!this.configured) throw new RoutingError('OPTIMIZER_UNAVAILABLE', `Optimizer is not configured (${this.config.problem})`);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.baseUrl}/optimize`, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify(problem),
        signal: AbortSignal.timeout((Math.min(problem.options?.timeLimitS ?? OPTIMIZER_DEFAULT_TIME_LIMIT_S, SOLVER_LIMITS.timeLimitS) + OPTIMIZER_TIMEOUT_SLACK_S) * 1000),
      });
    } catch (e) {
      this.logger.warn(`optimizer unreachable: ${(e as Error).message}`);
      throw new RoutingError('OPTIMIZER_UNAVAILABLE', 'Optimizer unavailable');
    }
    // Every solver slot busy: transient, the caller retries with back-off instead of failing.
    if (res.status === 429) throw new RoutingError('OPTIMIZER_BUSY', 'Optimizer busy; retried shortly');
    const body = (await res.json().catch(() => ({}))) as Partial<SolverResult>;
    if (res.status === 400) throw new RoutingError('LIMIT_EXCEEDED', body.error ?? 'Optimizer rejected the problem');
    if (!res.ok) throw new RoutingError('OPTIMIZER_UNAVAILABLE', `Optimizer error (HTTP ${res.status})`);
    if (!Array.isArray(body.routes) || !Array.isArray(body.unassigned) || typeof body.status !== 'string') {
      throw new RoutingError('OPTIMIZER_UNAVAILABLE', 'Optimizer answer is not a result');
    }
    return body as SolverResult;
  }
}
