import { Logger } from '@nestjs/common';
import type { RoutingJobPhase } from '@veetracer/shared';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { decideFailure, decideLeaseExpiry, JobErrorCode, PROGRESS } from './job-state';
import type { JobQueue } from './job-queue';
import type { JobRecord, RoutingJobStore, StoreTx } from './job-store';

/** A typed job failure: `code` decides retry vs final (job-state.ts TRANSIENT_CODES). Messages never hold coordinates. */
export class JobError extends Error {
  constructor(
    readonly code: JobErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'JobError';
  }
}

/** This worker lost the job (lease expired and taken over): stop without writing anything. */
export class LeaseLost extends Error {}

export interface JobContext {
  job: JobRecord;
  /** Aborted on timeout, cancel request or lease loss; pass it to every fetch. */
  signal: AbortSignal;
  /** Moves to a phase (MATRIX → SOLVING …) and sets progress. Throws LeaseLost. */
  phase(phase: RoutingJobPhase, progress: number): Promise<void>;
  progress(pct: number): Promise<void>;
  /** Throws the abort reason (JobError CANCELLED / TIMEOUT, LeaseLost); call between steps. */
  checkpoint(): Promise<void>;
}

export interface JobRunResult {
  /** Stored in `RoutingJob.result` (stop ids, sequences and times only — no coordinates). */
  result: unknown;
  graphVersion: string | null;
  /** Written in the same transaction as SUCCEEDED (the DRAFT plan); not run when the lease was lost. */
  within?: (tx: StoreTx) => Promise<void>;
}

export type JobRunner = (ctx: JobContext) => Promise<JobRunResult>;

/** Called after a job reached FAILED / CANCELLED (e.g. plan OPTIMIZING → DRAFT). Best effort. */
export type FinalHook = (job: JobRecord) => Promise<void>;

export interface WorkerOptions {
  leaseMs: number;
  heartbeatMs: number;
  sweepMs: number;
  /** QUEUED jobs older than this are re-published by the sweeper (lost or trimmed deliveries). */
  republishAfterMs: number;
  /** One sweeper at a time; resolves true when this worker may sweep now. */
  sweepLock: (owner: string, ttlMs: number) => Promise<boolean>;
}

const envMs = (k: string, d: number) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : d);

/** Production defaults; the env overrides exist for the real-process chaos test only. */
export function defaultWorkerOptions(sweepLock: WorkerOptions['sweepLock']): WorkerOptions {
  const leaseMs = envMs('ROUTING_JOB_LEASE_MS', 60_000);
  return {
    leaseMs,
    heartbeatMs: Math.max(200, Math.min(15_000, Math.floor(leaseMs / 4))),
    sweepMs: envMs('ROUTING_JOB_SWEEP_MS', 30_000),
    republishAfterMs: envMs('ROUTING_JOB_REPUBLISH_MS', 15_000),
    sweepLock,
  };
}

export interface WorkerMetrics {
  slots: number;
  inflight: number;
  claimed: number;
  succeeded: number;
  failed: number;
  retried: number;
  cancelled: number;
  leaseLost: number;
  takenOver: number;
  lastError: { code: string; at: string } | null;
}

export type ProcessOutcome = 'skipped' | 'succeeded' | 'failed' | 'retry' | 'cancelled' | 'lease-lost';

/**
 * Executes routing jobs (one `RoutingJobWorker` per routing-worker process; `slots` consumer loops). Exactly one run
 * owns a job at a time: the conditional claim, a lease renewed by the heartbeat, and conditional writes keyed on the
 * lease owner. A killed worker's job is re-queued by any worker's sweeper once its lease expired (R4 chaos), at most
 * `maxAttempts` times, then FAILED with WORKER_LOST.
 */
export class RoutingJobWorker {
  private readonly logger = new Logger('RoutingJobWorker');
  readonly id: string;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly aborters = new Set<AbortController>();
  private loops: Promise<void>[] = [];
  private stopping = false;
  private started = false;
  private slots = 0;
  readonly counters = { claimed: 0, succeeded: 0, failed: 0, retried: 0, cancelled: 0, leaseLost: 0, takenOver: 0 };
  private lastError: WorkerMetrics['lastError'] = null;

  constructor(
    private readonly store: RoutingJobStore,
    private readonly queue: JobQueue,
    private readonly runners: Map<string, JobRunner>,
    private readonly opts: WorkerOptions,
    private readonly onFinal: FinalHook = async () => undefined,
    private readonly clock: () => number = Date.now,
    id?: string,
  ) {
    this.id = id ?? `${hostname()}-${process.pid}-${randomUUID().slice(0, 6)}`;
  }

  metrics(): WorkerMetrics {
    return { slots: this.slots, inflight: this.inflight.size, ...this.counters, lastError: this.lastError };
  }

  start(slots: number): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.slots = Math.max(1, Math.min(8, Math.round(slots) || 1));
    for (let i = 0; i < this.slots; i++) this.loops.push(this.queue.consume(`${this.id}-${i}`, (id) => this.track(this.process(id)), () => this.stopping));
    const sweep = setInterval(() => void this.sweep().catch((e) => this.logger.warn(`sweep: ${(e as Error).message}`)), this.opts.sweepMs);
    sweep.unref();
    this.timers.add(sweep);
    this.logger.log(`routing worker ${this.id} started (${this.slots} slot(s))`);
  }

  private async track<T>(p: Promise<T>): Promise<void> {
    this.inflight.add(p);
    try {
      await p;
    } catch (e) {
      this.logger.error(`job run: ${(e as Error).message}`);
    } finally {
      this.inflight.delete(p);
    }
  }

  /**
   * Graceful stop (SIGTERM): no new claims, wait up to `graceMs` for running jobs. A job still running afterwards
   * keeps its lease until it expires and is then taken over by another worker.
   */
  async stop(graceMs = 30_000): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    this.timers.clear();
    if (this.inflight.size) await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => setTimeout(r, graceMs).unref())]);
    await Promise.race([Promise.allSettled(this.loops), new Promise((r) => setTimeout(r, 6_000).unref())]);
    this.loops = [];
    this.started = false;
  }

  /**
   * Test helper for the R4 chaos case inside one process: behaves like SIGKILL — heartbeats and loops stop at once and
   * nothing is written; the in-flight run is abandoned (its later writes fail the lease check).
   */
  kill(): void {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    this.timers.clear();
    this.killed = true;
  }
  private killed = false;

  /** Executes one job if this worker wins the claim. Safe to call any number of times for the same id. */
  async process(jobId: string): Promise<ProcessOutcome> {
    if (this.stopping) return 'skipped';
    const job = await this.store.claim(jobId, this.id, new Date(this.clock()), this.opts.leaseMs);
    if (!job) return 'skipped';
    this.counters.claimed++;
    if (job.attempts > 1 && job.error?.code === 'WORKER_LOST') this.counters.takenOver++;
    this.logger.log(`job ${job.id} (${job.kind}) claimed, attempt ${job.attempts}/${job.maxAttempts}`);
    const runner = this.runners.get(String(job.kind));
    const ac = new AbortController();
    this.aborters.add(ac);
    const abort = (reason: Error) => {
      if (!ac.signal.aborted) ac.abort(reason);
    };
    const timeout = setTimeout(() => abort(new JobError('TIMEOUT', `Job timed out after ${job.timeoutS} s`)), job.timeoutS * 1000);
    let beating = false;
    const heartbeat = setInterval(() => {
      if (beating || this.killed) return;
      beating = true;
      void (async () => {
        try {
          const kept = await this.store.renewLease(job.id, this.id, new Date(this.clock() + this.opts.leaseMs));
          if (!kept) return abort(new LeaseLost('lease lost'));
          if (await this.store.cancelRequested(job.id)) abort(new JobError('CANCELLED', 'Cancelled by the user'));
        } catch {
          // database blip: the lease has slack (heartbeat = lease / 4)
        } finally {
          beating = false;
        }
      })();
    }, this.opts.heartbeatMs);
    const aborted = new Promise<never>((_, reject) => ac.signal.addEventListener('abort', () => reject(ac.signal.reason as Error), { once: true }));
    aborted.catch(() => undefined);
    const guard = async (ok: boolean) => {
      if (!ok) throw new LeaseLost('lease lost');
    };
    const ctx: JobContext = {
      job,
      signal: ac.signal,
      phase: async (phase, progress) => guard(await this.store.progress(job.id, this.id, { phase, progress: Math.min(99, Math.round(progress)) })),
      progress: async (pct) => guard(await this.store.progress(job.id, this.id, { progress: Math.max(PROGRESS.claimed, Math.min(99, Math.round(pct))) })),
      checkpoint: async () => {
        if (ac.signal.aborted) throw ac.signal.reason as Error;
        if (await this.store.cancelRequested(job.id)) {
          abort(new JobError('CANCELLED', 'Cancelled by the user'));
          throw ac.signal.reason as Error;
        }
      },
    };
    try {
      if (!runner) throw new JobError('INVALID_INPUT', `Unknown job kind ${String(job.kind)}`);
      const out = await Promise.race([runner(ctx), aborted]);
      if (this.killed) return 'lease-lost';
      await ctx.checkpoint(); // a cancel that arrived during the last step wins over the result
      const done = await this.store.succeed(job.id, this.id, out.result, out.graphVersion, new Date(this.clock()), out.within);
      if (!done) {
        this.counters.leaseLost++;
        this.logger.warn(`job ${job.id}: lease lost before the result was stored; the run that took over owns it`);
        return 'lease-lost';
      }
      this.counters.succeeded++;
      this.logger.log(`job ${job.id} done`);
      return 'succeeded';
    } catch (e) {
      if (this.killed) return 'lease-lost';
      return await this.fail(job, e);
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      this.aborters.delete(ac);
    }
  }

  private async fail(job: JobRecord, e: unknown): Promise<ProcessOutcome> {
    if (e instanceof LeaseLost) {
      this.counters.leaseLost++;
      this.logger.warn(`job ${job.id}: lease lost; stopped without writing`);
      return 'lease-lost';
    }
    const err =
      e instanceof JobError
        ? { code: e.code, message: e.message }
        : // Never echo an unknown error's message to the user (it may hold internals); the log keeps the stack.
          { code: 'INTERNAL_ERROR' as const, message: 'Internal error while optimising; see the worker log' };
    if (!(e instanceof JobError)) this.logger.error(`job ${job.id}: ${(e as Error)?.stack ?? String(e)}`);
    const cancelRequested = err.code === 'CANCELLED' || (await this.store.cancelRequested(job.id).catch(() => false));
    const d = decideFailure(err, { attempts: job.attempts, maxAttempts: job.maxAttempts, cancelRequested }, this.clock());
    const ok = await this.store.settle(job.id, this.id, d, new Date(this.clock()));
    if (!ok) {
      this.counters.leaseLost++;
      return 'lease-lost';
    }
    this.lastError = d.to === 'CANCELLED' ? this.lastError : { code: err.code, at: new Date(this.clock()).toISOString() };
    if (d.to === 'QUEUED') {
      this.counters.retried++;
      this.logger.warn(`job ${job.id}: ${err.code}; retry ${job.attempts + 1}/${job.maxAttempts} in ${d.error.retry} s`);
      const t = setTimeout(() => void this.queue.publish(job.id).catch(() => undefined), Math.max(0, d.notBeforeMs - this.clock()) + 50);
      t.unref();
      this.timers.add(t);
      return 'retry';
    }
    const final = (await this.store.get(job.id)) ?? job;
    await this.onFinal(final).catch((x) => this.logger.warn(`job ${job.id} final hook: ${(x as Error).message}`));
    if (d.to === 'CANCELLED') {
      this.counters.cancelled++;
      this.logger.log(`job ${job.id} cancelled`);
      return 'cancelled';
    }
    this.counters.failed++;
    this.logger.warn(`job ${job.id} failed: ${err.code}`);
    return 'failed';
  }

  /**
   * Lease recovery and lost-delivery safety net (one worker at a time): expired leases → re-queued (or FAILED /
   * CANCELLED), due QUEUED jobs older than `republishAfterMs` → published again (the claim makes that safe).
   */
  async sweep(now = new Date(this.clock())): Promise<{ requeued: number; failed: number; republished: number }> {
    if (this.killed || !(await this.opts.sweepLock(this.id, Math.max(1_000, this.opts.sweepMs - 1_000)))) return { requeued: 0, failed: 0, republished: 0 };
    let requeued = 0;
    let failed = 0;
    for (const j of await this.store.expired(now, 100)) {
      const d = decideLeaseExpiry(j);
      if (!(await this.store.settleExpired(j.id, d, now))) continue;
      if (d.to === 'QUEUED') {
        requeued++;
        this.logger.warn(`job ${j.id}: worker lease expired (attempt ${j.attempts}/${j.maxAttempts}); re-queued`);
        await this.queue.publish(j.id).catch(() => undefined);
      } else {
        failed++;
        const final = (await this.store.get(j.id)) ?? j;
        await this.onFinal(final).catch(() => undefined);
      }
    }
    const due = await this.store.due(now, new Date(now.getTime() - this.opts.republishAfterMs), 200);
    for (const id of due) await this.queue.publish(id).catch(() => undefined);
    return { requeued, failed, republished: due.length };
  }
}
