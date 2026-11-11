import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import {
  OSM_ATTRIBUTION,
  ROUTING_JOB_STATE_OF,
  ROUTING_LIMITS,
  RoutingJobDto,
  RoutingJobError,
  RoutingJobInput,
  RoutingJobKind,
  RoutingJobPhase,
  RoutingJobStatus,
  RoutingProfile,
} from '@veetracer/shared';
import type { AuthContext } from '../access/auth-context';
import { idempotencyKey as parseIdempotencyKey, requestHash } from '../etms/dispatch/e3-common';
import type { JobQueue } from './job-queue';
import { DuplicateIdempotencyKey, JobRecord, RoutingJobStore, StoreTx } from './job-store';
import { RoutingHttpError } from './routing-flags';

export const ROUTING_JOB_STORE = Symbol('ROUTING_JOB_STORE');
export const ROUTING_JOB_QUEUE = Symbol('ROUTING_JOB_QUEUE');
export const ROUTING_PLAN_LINK = Symbol('ROUTING_PLAN_LINK');
export const ROUTING_RATE_LIMITER = Symbol('ROUTING_RATE_LIMITER');

/** Plan side of a job: reserve the plan (→ OPTIMIZING) with the job insert, release it when the job ends without a result. */
export interface PlanJobLink {
  /**
   * Inside the job-insert transaction: checks the plan is in the caller's scope, at `expectedVersion`, editable and
   * within the limits, and moves it to OPTIMIZING. Throws RoutingHttpError (404 / 409 PLAN_STALE / PLAN_NOT_EDITABLE /
   * 422 LIMIT_EXCEEDED). Returns the plan's routing profile.
   */
  reserve(tx: StoreTx, ctx: AuthContext, planId: string, expectedVersion: number): Promise<{ profile: RoutingProfile }>;
  /** Plan OPTIMIZING → DRAFT (no version change) after a job FAILED / was CANCELLED. Idempotent. */
  release(job: Pick<JobRecord, 'companyId' | 'planId'>): Promise<void>;
  /** Plan visible to the caller (job reads are filtered by it). */
  visible(ctx: AuthContext, planId: string): Promise<boolean>;
}

/** Per-user submit rate (fixed one-minute window). Returns false when over the limit. */
export interface RateLimiter {
  hit(userId: string, limit: number, now: number): Promise<boolean>;
}

export interface OptimizeJobRequest {
  planId: string;
  expectedVersion: number;
  timeLimitS?: number;
  objective?: 'duration' | 'distance';
}

export interface JobListQuery {
  planId?: string;
  state?: string;
  limit?: number;
}

/** Default whole-job budget: solver limit + matrix + slack. */
export const jobTimeoutS = (timeLimitS: number) => Math.min(900, timeLimitS + 240);
export const DEFAULT_MAX_ATTEMPTS = 3;

export function toJobDto(row: JobRecord): RoutingJobDto {
  const err = row.error;
  const pending = row.status === 'QUEUED' && err?.retry !== undefined;
  return {
    jobId: row.id,
    kind: row.kind as RoutingJobKind,
    state: ROUTING_JOB_STATE_OF[row.status],
    phase: (row.phase as RoutingJobPhase | null) ?? null,
    progress: row.progress,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    cancelRequested: row.cancelRequested,
    planId: row.planId,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    graphVersion: row.graphVersion,
    ...(row.status === 'SUCCEEDED' && row.result ? { result: row.result as RoutingJobDto['result'] } : {}),
    // A QUEUED job with an error is waiting for a retry: shown, so the dispatcher sees why (engine down …).
    ...(err && (row.status === 'FAILED' || pending || row.status === 'QUEUED') ? { error: { code: err.code as RoutingJobError['code'], message: err.message, ...(err.retry !== undefined ? { retry: err.retry } : {}) } } : {}),
    attribution: OSM_ATTRIBUTION,
  };
}

const STATES: Record<string, RoutingJobStatus> = { queued: 'QUEUED', running: 'RUNNING', succeeded: 'SUCCEEDED', failed: 'FAILED', cancelled: 'CANCELLED' };

/**
 * API side of the optimisation jobs (E4 WP 4.2): create (Idempotency-Key, company scope, per-company concurrency and
 * daily limits, per-user rate), read, list and cancel. The API never executes a job; the routing-worker process does.
 * Every read and cancel is filtered by the caller's company (another company's job is a plain 404).
 */
@Injectable()
export class RoutingJobsService {
  private readonly logger = new Logger(RoutingJobsService.name);

  constructor(
    @Inject(ROUTING_JOB_STORE) private readonly store: RoutingJobStore,
    @Inject(ROUTING_JOB_QUEUE) private readonly queue: JobQueue,
    @Inject(ROUTING_PLAN_LINK) private readonly plans: PlanJobLink,
    @Inject(ROUTING_RATE_LIMITER) private readonly rate: RateLimiter,
  ) {}

  async enqueueOptimize(ctx: AuthContext, req: OptimizeJobRequest, rawKey: string | undefined, now = new Date()): Promise<{ job: RoutingJobDto; replay: boolean }> {
    if (ctx.allCompanies) throw new BadRequestException({ message: 'Select one company to optimise its plans', code: 'VALIDATION_FAILED' });
    const key = parseIdempotencyKey(rawKey);
    const timeLimitS = Math.max(1, Math.min(ROUTING_LIMITS.optimizeTimeLimitS, Math.round(req.timeLimitS ?? 10)));
    const body = { kind: 'optimize', planId: req.planId, expectedVersion: req.expectedVersion, timeLimitS, objective: req.objective ?? 'duration' };
    const hash = requestHash(body);

    const existing = await this.store.findByKey(ctx.companyId, key);
    if (existing) return { job: this.replayOf(existing, hash), replay: true };

    if (!(await this.rate.hit(ctx.userId, ROUTING_LIMITS.perUserPerMinute, now.getTime()))) {
      throw new RoutingHttpError('QUOTA_EXCEEDED', `At most ${ROUTING_LIMITS.perUserPerMinute} routing requests per minute; try again shortly`);
    }
    if ((await this.store.activeCount(ctx.companyId, now)) >= ROUTING_LIMITS.concurrentOptimizePerCompany) {
      throw new RoutingHttpError('QUOTA_EXCEEDED', `At most ${ROUTING_LIMITS.concurrentOptimizePerCompany} optimisations may run at once for a company; wait for one to finish`);
    }
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if ((await this.store.createdSince(ctx.companyId, dayStart)) >= ROUTING_LIMITS.perCompanyPerDay) {
      throw new RoutingHttpError('QUOTA_EXCEEDED', 'The daily optimisation limit of this company is used up');
    }

    let row: JobRecord;
    try {
      row = await this.store.create(
        {
          companyId: ctx.companyId,
          userId: ctx.userId,
          planId: req.planId,
          kind: 'optimize',
          input: null, // set in onCreate (needs the plan's profile)
          idempotencyKey: key,
          requestHash: hash,
          timeoutS: jobTimeoutS(timeLimitS),
          maxAttempts: DEFAULT_MAX_ATTEMPTS,
        },
        async (tx) => {
          const { profile } = await this.plans.reserve(tx, ctx, req.planId, req.expectedVersion);
          const input: RoutingJobInput = { kind: 'optimize', planId: req.planId, planVersion: req.expectedVersion, profile, timeLimitS, ...(req.objective ? { objective: req.objective } : {}) };
          return { input };
        },
      );
    } catch (e) {
      if (e instanceof DuplicateIdempotencyKey) {
        const winner = await this.store.findByKey(ctx.companyId, key);
        if (winner) return { job: this.replayOf(winner, hash), replay: true };
      }
      throw e;
    }
    await this.queue.publish(row.id).catch((e) => this.logger.warn(`job ${row.id} not published (${(e as Error).message}); the sweeper re-publishes it`));
    this.logger.log(`optimise job ${row.id} queued for plan ${req.planId}`);
    return { job: toJobDto(row), replay: false };
  }

  private replayOf(row: JobRecord, hash: string): RoutingJobDto {
    if (row.requestHash && row.requestHash !== hash) {
      throw new RoutingHttpError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
    }
    return toJobDto(row);
  }

  async get(ctx: AuthContext, id: string): Promise<RoutingJobDto> {
    return toJobDto(await this.scoped(ctx, id));
  }

  private async scoped(ctx: AuthContext, id: string): Promise<JobRecord> {
    const row = await this.store.getScoped(ctx.companyId, id);
    if (!row || (row.planId && !(await this.plans.visible(ctx, row.planId)))) throw new RoutingHttpError('JOB_NOT_FOUND', 'Job not found');
    return row;
  }

  async list(ctx: AuthContext, q: JobListQuery): Promise<RoutingJobDto[]> {
    const status = q.state ? q.state.split(',').map((s) => STATES[s.trim().toLowerCase()]).filter(Boolean) : undefined;
    if (q.planId && !(await this.plans.visible(ctx, q.planId))) return [];
    const rows = await this.store.list(ctx.companyId, { planId: q.planId, status, limit: Math.max(1, Math.min(100, q.limit ?? 20)) });
    const out: RoutingJobDto[] = [];
    for (const r of rows) if (!r.planId || q.planId || (await this.plans.visible(ctx, r.planId))) out.push(toJobDto(r));
    return out;
  }

  /** QUEUED → CANCELLED at once (plan back to DRAFT); RUNNING → cancel requested (the worker stops at its next step). */
  async cancel(ctx: AuthContext, id: string, now = new Date()): Promise<RoutingJobDto> {
    await this.scoped(ctx, id);
    const r = await this.store.requestCancel(ctx.companyId, id, now);
    if (!r) throw new RoutingHttpError('JOB_NOT_FOUND', 'Job not found');
    if (r.outcome === 'final') throw new RoutingHttpError('PLAN_NOT_EDITABLE', `Job already ${ROUTING_JOB_STATE_OF[r.job.status]}`, { state: ROUTING_JOB_STATE_OF[r.job.status] });
    if (r.outcome === 'cancelled') await this.plans.release(r.job).catch((e) => this.logger.warn(`plan release after cancel: ${(e as Error).message}`));
    return toJobDto(r.job);
  }
}
