import { Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { SOLVER_LIMITS, SolverProblem, SolverResult } from '@veetracer/shared';
import { etmsRoutingEnabled } from '../../etms/transport-feature.guard';
import { defaultFetch, FetchLike } from '../fetch-like';
import { privateServiceUrlProblem } from '../private-url';
import { RoutingError } from '../routing.errors';
import { scrubCoordinates } from '../engine-text';

export interface OptimizerClientConfig {
  baseUrl: string;
  token: string;
  /** Why the client is off, for logs and capabilities; null when configured. */
  problem: string | null;
}

/**
 * The token in a token file: the optimiser's own EnvironmentFile format (`OPTIMIZER_TOKEN=<token>`, last one wins, quotes
 * stripped; /etc/veetrax/optimizer.env, so one file serves the optimiser, the API, the worker and the health gate), or
 * a file holding just the token.
 */
export function tokenFromFile(content: string): string {
  const lines = content.split(/\r?\n/).map((l) => /^\s*OPTIMIZER_TOKEN=(.*)$/.exec(l)?.[1]).filter((v): v is string => v !== undefined);
  const raw = lines.length ? lines[lines.length - 1] : content;
  return raw.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
}

/**
 * Reads `OPTIMIZER_URL` and the token. The client is configured only when `ETMS_ROUTING=on`, the URL is a
 * private / loopback URL (`privateServiceUrlProblem`) and a token is set (the service refuses to start without one).
 *
 * Token (E4 security review L9): `OPTIMIZER_TOKEN_FILE` (production: /etc/veetrax/optimizer.env, root:veetrax 0640, set
 * by the veetrax-api and veetrax-routing-worker units; the other units have the path made inaccessible) wins over
 * `OPTIMIZER_TOKEN` (dev, tests), so the token need not sit in apps/api/.env, which every VeeTrax unit loads. An
 * unreadable or empty file leaves the client off (never falls back to the env value).
 */
export function readOptimizerConfig(env: NodeJS.ProcessEnv = process.env, readFile: (path: string) => string = (f) => readFileSync(f, 'utf8')): OptimizerClientConfig {
  const baseUrl = (env.OPTIMIZER_URL ?? '').trim().replace(/\/+$/, '');
  const tokenFile = (env.OPTIMIZER_TOKEN_FILE ?? '').trim();
  let token = (env.OPTIMIZER_TOKEN ?? '').trim();
  let tokenProblem: string | null = null;
  if (tokenFile) {
    try {
      token = tokenFromFile(readFile(tokenFile));
      if (!token) tokenProblem = 'OPTIMIZER_TOKEN_FILE is empty';
    } catch (e) {
      token = '';
      tokenProblem = `OPTIMIZER_TOKEN_FILE is not readable (${(e as { code?: string }).code ?? 'error'})`;
    }
  }
  if (!etmsRoutingEnabled(env)) return { baseUrl: '', token: '', problem: 'ETMS_ROUTING is off' };
  if (!baseUrl) return { baseUrl: '', token: '', problem: 'OPTIMIZER_URL is not set' };
  const urlProblem = privateServiceUrlProblem(baseUrl, env);
  if (urlProblem) return { baseUrl: '', token: '', problem: `OPTIMIZER_URL refused: ${urlProblem}` };
  if (tokenProblem) return { baseUrl: '', token: '', problem: tokenProblem };
  if (!token) return { baseUrl: '', token: '', problem: 'OPTIMIZER_TOKEN is not set' };
  return { baseUrl, token, problem: null };
}

/** Default solver time limit of the service when the problem names none (solver.py). */
export const OPTIMIZER_DEFAULT_TIME_LIMIT_S = 10;
/** Solver time limit plus slack for the matrix upload and serialisation. */
export const OPTIMIZER_TIMEOUT_SLACK_S = 15;
export const OPTIMIZER_HEALTH_TIMEOUT_MS = 2000;
/** T3-D6: request bodies at least this large can still be uploading when a busy service closes the connection. */
export const RESET_AS_BUSY_MIN_BYTES = 256 * 1024;

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
    const payload = JSON.stringify(problem);
    try {
      res = await this.fetchImpl(`${this.config.baseUrl}/optimize`, {
        method: 'POST',
        headers: this.headers(true),
        body: payload,
        signal: AbortSignal.timeout((Math.min(problem.options?.timeLimitS ?? OPTIMIZER_DEFAULT_TIME_LIMIT_S, SOLVER_LIMITS.timeLimitS) + OPTIMIZER_TIMEOUT_SLACK_S) * 1000),
      });
    } catch (e) {
      // T3-D6: a large body cut off by a reset: a busy service closed the connection while the body was still being
      // uploaded (older services did not read it after their 429) → busy, retried without using an attempt. A small
      // body fits the socket buffers, so its reset means the service itself went away → unavailable, like a refused
      // connection or a timeout.
      if (resetDuringUpload(e) && Buffer.byteLength(payload) >= RESET_AS_BUSY_MIN_BYTES) {
        this.logger.warn('optimizer closed the connection during the upload; treated as busy');
        throw new RoutingError('OPTIMIZER_BUSY', 'Optimizer busy (connection closed during the upload); retried shortly');
      }
      this.logger.warn(`optimizer unreachable: ${(e as Error).message}`);
      throw new RoutingError('OPTIMIZER_UNAVAILABLE', 'Optimizer unavailable');
    }
    // Every solver slot busy: transient, the caller retries with back-off instead of failing.
    if (res.status === 429) throw new RoutingError('OPTIMIZER_BUSY', 'Optimizer busy; retried shortly');
    const body = (await res.json().catch(() => ({}))) as Partial<SolverResult>;
    // A rejected problem (HTTP 400: limits or malformed input) is final, never retried (LIMIT_EXCEEDED is not a
    // transient code). Its text is the service's own fixed message, scrubbed and bounded anyway (L4).
    if (res.status === 400) {
      throw new RoutingError('LIMIT_EXCEEDED', typeof body.error === 'string' && body.error ? scrubCoordinates(body.error).slice(0, 200) : 'Optimizer rejected the problem');
    }
    if (!res.ok) throw new RoutingError('OPTIMIZER_UNAVAILABLE', `Optimizer error (HTTP ${res.status})`);
    if (!Array.isArray(body.routes) || !Array.isArray(body.unassigned) || typeof body.status !== 'string') {
      throw new RoutingError('OPTIMIZER_UNAVAILABLE', 'Optimizer answer is not a result');
    }
    return body as SolverResult;
  }
}

/** A connection reset / broken pipe / socket closed by the peer (not refused, not a timeout): see T3-D6. */
export function resetDuringUpload(e: unknown): boolean {
  const codes = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']);
  for (let x: unknown = e, i = 0; x && i < 4; x = (x as { cause?: unknown }).cause, i++) {
    const code = (x as { code?: unknown }).code;
    if (typeof code === 'string' && codes.has(code)) return true;
  }
  return false;
}
