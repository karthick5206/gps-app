import { Logger } from '@nestjs/common';
import type { SolverProblem, SolverResult } from '@veetracer/shared';
import type { SolverProblemV2 } from './optimize-problem';
import { isLocalHost, redactUrl } from '../monitoring/map-services';
import { JobError } from './job-worker';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Minimum token length the optimiser service accepts (server.py MIN_TOKEN). */
export const OPTIMIZER_MIN_TOKEN = 24;

export interface OptimizerConfig {
  baseUrl: string;
  token: string;
  /** Why the configuration is refused (then `baseUrl` is empty); null when usable or simply not set. */
  problem: string | null;
}

/**
 * OPTIMIZER_URL (+ OPTIMIZER_TOKEN) from the environment. Private hosts only (loopback / RFC 1918 / single label,
 * the same rule as the map-service probes); no credentials in the URL; the token is required and ≥ 24 characters.
 * Production: http://127.0.0.1:8090 (veetrax-optimizer.service binds loopback).
 */
export function readOptimizerConfig(env: NodeJS.ProcessEnv = process.env): OptimizerConfig {
  const raw = (env.OPTIMIZER_URL ?? '').trim().replace(/\/+$/, '');
  const token = (env.OPTIMIZER_TOKEN ?? '').trim();
  if (!raw) return { baseUrl: '', token: '', problem: null };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { baseUrl: '', token: '', problem: 'OPTIMIZER_URL is not a URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { baseUrl: '', token: '', problem: `OPTIMIZER_URL: unsupported protocol ${u.protocol}` };
  if (u.username || u.password) return { baseUrl: '', token: '', problem: 'OPTIMIZER_URL must not carry credentials (use OPTIMIZER_TOKEN)' };
  if (!isLocalHost(u.hostname)) return { baseUrl: '', token: '', problem: `OPTIMIZER_URL host ${u.hostname} is not a loopback or private host` };
  if (token.length < OPTIMIZER_MIN_TOKEN) return { baseUrl: '', token: '', problem: `OPTIMIZER_TOKEN is missing or shorter than ${OPTIMIZER_MIN_TOKEN} characters` };
  return { baseUrl: raw, token, problem: null };
}

export interface OptimizerHealth {
  configured: boolean;
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
  /** /health body fields (ortools version, slots, busy) when reachable. */
  info?: { ortools?: string; slots?: number; busy?: number };
}

/**
 * HTTP client of `services/routing-optimizer` (`POST /optimize`, `GET /health`, bearer token). Every failure is a
 * typed JobError (OPTIMIZER_UNAVAILABLE / OPTIMIZER_BUSY: retried; INVALID_INPUT: final). It never substitutes a
 * heuristic plan: no optimiser, no plan. Request and response bodies are never logged (they describe passengers).
 */
export class OptimizerClient {
  private readonly logger = new Logger('OptimizerClient');
  readonly config: OptimizerConfig;

  constructor(
    config: OptimizerConfig = readOptimizerConfig(),
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i),
  ) {
    this.config = config;
    if (config.problem) this.logger.error(`optimizer disabled: ${config.problem}`);
  }

  get configured(): boolean {
    return !!this.config.baseUrl;
  }

  /** Probe URL for display (no userinfo / query). */
  get probeUrl(): string | null {
    return this.config.baseUrl ? redactUrl(`${this.config.baseUrl}/health`) : null;
  }

  async health(timeoutMs = 2000): Promise<OptimizerHealth> {
    if (!this.configured) return { configured: false, ok: false, latencyMs: null, error: this.config.problem ?? 'OPTIMIZER_URL is not set' };
    const t0 = Date.now();
    try {
      const res = await this.fetchImpl(`${this.config.baseUrl}/health`, { headers: { Authorization: `Bearer ${this.config.token}` }, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
      const latencyMs = Date.now() - t0;
      if (!res.ok) return { configured: true, ok: false, latencyMs, error: res.status === 401 ? 'token refused (HTTP 401)' : `HTTP ${res.status}` };
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; ortools?: string; slots?: number; busy?: number };
      return { configured: true, ok: body.ok === true, latencyMs, error: body.ok === true ? null : 'unexpected /health answer', info: { ortools: body.ortools, slots: body.slots, busy: body.busy } };
    } catch (e) {
      return { configured: true, ok: false, latencyMs: null, error: (e as Error).name === 'TimeoutError' ? 'timed out' : 'not reachable' };
    }
  }

  async solve(problem: SolverProblem | SolverProblemV2, signal?: AbortSignal): Promise<SolverResult> {
    if (!this.configured) throw new JobError('OPTIMIZER_UNAVAILABLE', this.config.problem ? `Optimizer refused: ${this.config.problem}` : 'Optimizer is not configured (OPTIMIZER_URL)');
    const limitS = problem.options?.timeLimitS ?? 10;
    const timeout = AbortSignal.timeout((limitS + 20) * 1000); // solver time limit + serialisation slack
    const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.baseUrl}/optimize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.token}` },
        body: JSON.stringify(problem),
        signal: both,
        redirect: 'manual',
      });
    } catch (e) {
      if (signal?.aborted) throw signal.reason as Error; // cancel / job timeout / lease loss: not the optimiser's fault
      const timedOut = timeout.aborted;
      this.logger.warn(`optimizer ${timedOut ? 'timed out' : 'unreachable'}: ${(e as Error).name}`);
      throw new JobError('OPTIMIZER_UNAVAILABLE', timedOut ? 'Optimizer did not answer in time' : 'Optimizer unavailable');
    }
    if (res.status === 429) throw new JobError('OPTIMIZER_BUSY', 'Optimizer busy; retried shortly');
    const body = (await res.json().catch(() => null)) as (SolverResult & { error?: string }) | null;
    if (res.status === 400) throw new JobError('INVALID_INPUT', `Optimizer rejected the problem: ${String(body?.error ?? 'invalid input').slice(0, 200)}`);
    if (res.status === 401 || res.status === 403) throw new JobError('OPTIMIZER_UNAVAILABLE', `Optimizer refused the request (HTTP ${res.status}: check OPTIMIZER_TOKEN / OPTIMIZER_ALLOW)`);
    if (!res.ok) throw new JobError('OPTIMIZER_UNAVAILABLE', `Optimizer error (HTTP ${res.status})`);
    if (!body || typeof body.status !== 'string' || !Array.isArray(body.routes) || !Array.isArray(body.unassigned)) {
      throw new JobError('OPTIMIZER_UNAVAILABLE', 'Optimizer returned an unreadable answer');
    }
    return body;
  }
}
