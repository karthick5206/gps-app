import type { RoutingJobKind, RoutingJobPhase, RoutingJobStatus } from '@veetracer/shared';
import { assertTransition, FailureDecision, JobErrorBody, logicalState } from './job-state';

/**
 * Persistence port of the optimisation jobs. The `RoutingJob` row is the source of truth (doc 17 §1.6); the Valkey
 * stream only says "look at job X". Every write that moves a job is **conditional** (compare-and-set on status /
 * lease owner), so a job id delivered twice, a sweeper re-publish or a slow worker whose lease was taken over can
 * never execute or finish a job twice.
 *
 * Two implementations: `PrismaJobStore` (production, `RoutingJob` from migration routing_engine_v2) and
 * `MemoryJobStore` (unit and worker-lifecycle tests, same semantics; the DB test checks the Prisma store against the
 * same contract).
 */
export interface JobRecord {
  id: string;
  companyId: string;
  planId: string | null;
  userId: string | null;
  kind: RoutingJobKind | string;
  status: RoutingJobStatus;
  phase: RoutingJobPhase | string | null;
  input: unknown;
  result: unknown;
  error: JobErrorBody | null;
  progress: number;
  attempts: number;
  maxAttempts: number;
  timeoutS: number;
  cancelRequested: boolean;
  idempotencyKey: string | null;
  requestHash: string | null;
  lockedBy: string | null;
  lockedUntil: Date | null;
  notBefore: Date | null;
  graphVersion: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface NewJob {
  companyId: string;
  userId: string | null;
  planId: string | null;
  kind: RoutingJobKind;
  input: unknown;
  idempotencyKey: string | null;
  requestHash: string | null;
  timeoutS: number;
  maxAttempts: number;
  /**
   * Per-company limit of active jobs (QUEUED + RUNNING with a live lease), checked atomically with the insert (under a
   * per-company lock in the Prisma store), so concurrent requests cannot all pass a separate count. Absent = no limit.
   */
  maxActive?: number;
}

/** Thrown by `create` when (companyId, idempotencyKey) already exists (a concurrent duplicate request). */
export class DuplicateIdempotencyKey extends Error {}

/** Thrown by `create` when the company already has `maxActive` active jobs. */
export class ActiveLimitExceeded extends Error {}

/** Opaque transaction handle handed to `succeed(…, within)` (a Prisma TransactionClient in production). */
export type StoreTx = unknown;

export interface JobListFilter {
  planId?: string;
  status?: RoutingJobStatus[];
  limit: number;
}

export type CancelOutcome = { outcome: 'cancelled' | 'requested' | 'final'; job: JobRecord } | null;

export interface RoutingJobStore {
  /** Inserts a QUEUED job. With `onCreate`, runs it in the same transaction (e.g. plan → OPTIMIZING); its returned `input` is stored. */
  create(job: NewJob, onCreate?: (tx: StoreTx, job: JobRecord) => Promise<{ input?: unknown } | void>): Promise<JobRecord>;
  findByKey(companyId: string, key: string): Promise<JobRecord | null>;
  get(id: string): Promise<JobRecord | null>;
  getScoped(companyId: string, id: string): Promise<JobRecord | null>;
  list(companyId: string, filter: JobListFilter): Promise<JobRecord[]>;

  /** QUEUED (not cancelled, notBefore due) → RUNNING/matrix owned by `worker` until now + leaseMs; attempts + 1. */
  claim(id: string, worker: string, now: Date, leaseMs: number): Promise<JobRecord | null>;
  /** Extends the lease while `worker` still owns the RUNNING job. false = the lease was lost. */
  renewLease(id: string, worker: string, until: Date): Promise<boolean>;
  /** Phase / progress / graph version while `worker` owns the job. false = the lease was lost. */
  progress(id: string, worker: string, patch: { phase?: RoutingJobPhase; progress?: number; graphVersion?: string | null }): Promise<boolean>;
  cancelRequested(id: string): Promise<boolean>;
  /**
   * RUNNING → SUCCEEDED while `worker` owns the job, and `within(tx)` in the same transaction (the DRAFT plan write).
   * Returns false (and rolls `within` back) when the lease was lost: the run that took over owns the result.
   */
  succeed(id: string, worker: string, result: unknown, graphVersion: string | null, now: Date, within?: (tx: StoreTx) => Promise<void>): Promise<boolean>;
  /** Applies a failure decision (QUEUED retry / FAILED / CANCELLED) while `worker` owns the job. */
  settle(id: string, worker: string, d: FailureDecision, now: Date): Promise<boolean>;

  /** API cancel: QUEUED → CANCELLED at once; RUNNING → cancelRequested (the worker stops at its next checkpoint). */
  requestCancel(companyId: string, id: string, now: Date): Promise<CancelOutcome>;

  /** RUNNING jobs whose lease expired before `now`. */
  expired(now: Date, limit: number): Promise<JobRecord[]>;
  /** Applies a lease-expiry decision, only if the lease is still expired (no race with a late heartbeat). */
  settleExpired(id: string, d: FailureDecision, now: Date): Promise<boolean>;
  /** QUEUED, not cancelled, due, created before `createdBefore` (for the sweeper's re-publish). */
  due(now: Date, createdBefore: Date, limit: number): Promise<string[]>;

  /** QUEUED + RUNNING with a live lease (the per-company concurrency limit). */
  activeCount(companyId: string, now: Date): Promise<number>;
  /** Jobs created since `since` (the per-company daily limit). */
  createdSince(companyId: string, since: Date): Promise<number>;
  /** Counts for System Health: queued, running, failed in the last 24 h, oldest due queued job age. */
  stats(now: Date): Promise<{ queued: number; running: number; failed24h: number; oldestQueuedAt: Date | null }>;
}

// ───────────────────────────── in-memory implementation ─────────────────────────────

let seq = 0;
const nextId = () => `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, '0')}`;

/**
 * Same semantics as the Prisma store, in memory. Every method is synchronous inside, so each one is atomic like a
 * conditional UPDATE. Used by the state-machine and worker-lifecycle tests (several workers on one store).
 */
export class MemoryJobStore implements RoutingJobStore {
  readonly rows = new Map<string, JobRecord>();
  /** Writes made by `succeed(…, within)` (tests read them). */
  readonly committed: { jobId: string; worker: string }[] = [];

  private copy(r: JobRecord | undefined | null): JobRecord | null {
    return r ? { ...r } : null;
  }

  private move(r: JobRecord, status: RoutingJobStatus, phase: string | null) {
    assertTransition(logicalState(r.status, r.phase), logicalState(status, phase));
    r.status = status;
    r.phase = phase;
  }

  async create(newJob: NewJob, onCreate?: (tx: StoreTx, job: JobRecord) => Promise<{ input?: unknown } | void>): Promise<JobRecord> {
    const { maxActive, ...job } = newJob;
    if (job.idempotencyKey && [...this.rows.values()].some((r) => r.companyId === job.companyId && r.idempotencyKey === job.idempotencyKey)) {
      throw new DuplicateIdempotencyKey();
    }
    if (maxActive !== undefined && this.active(job.companyId, new Date()) >= maxActive) throw new ActiveLimitExceeded();
    const row: JobRecord = {
      id: nextId(),
      ...job,
      status: 'QUEUED',
      phase: null,
      result: null,
      error: null,
      progress: 0,
      attempts: 0,
      cancelRequested: false,
      lockedBy: null,
      lockedUntil: null,
      notBefore: null,
      graphVersion: null,
      createdAt: new Date(),
      startedAt: null,
      finishedAt: null,
    };
    // Inserted before onCreate (which awaits), so the key / limit checks above stay atomic for concurrent creates; an
    // onCreate failure removes it again (the Prisma store rolls the transaction back).
    this.rows.set(row.id, row);
    if (onCreate) {
      try {
        const patch = await onCreate(undefined, { ...row });
        if (patch && patch.input !== undefined) row.input = patch.input;
      } catch (e) {
        this.rows.delete(row.id);
        throw e;
      }
    }
    return { ...row };
  }

  async findByKey(companyId: string, key: string) {
    return this.copy([...this.rows.values()].find((r) => r.companyId === companyId && r.idempotencyKey === key));
  }

  async get(id: string) {
    return this.copy(this.rows.get(id));
  }

  async getScoped(companyId: string, id: string) {
    const r = this.rows.get(id);
    return r && r.companyId === companyId ? { ...r } : null;
  }

  async list(companyId: string, f: JobListFilter) {
    return [...this.rows.values()]
      .filter((r) => r.companyId === companyId && (!f.planId || r.planId === f.planId) && (!f.status || f.status.includes(r.status)))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, f.limit)
      .map((r) => ({ ...r }));
  }

  async claim(id: string, worker: string, now: Date, leaseMs: number) {
    const r = this.rows.get(id);
    if (!r || r.status !== 'QUEUED' || r.cancelRequested || (r.notBefore && r.notBefore > now)) return null;
    this.move(r, 'RUNNING', 'matrix');
    Object.assign(r, { lockedBy: worker, lockedUntil: new Date(now.getTime() + leaseMs), attempts: r.attempts + 1, startedAt: now, progress: 1, notBefore: null });
    return { ...r };
  }

  private mine(id: string, worker: string) {
    const r = this.rows.get(id);
    return r && r.status === 'RUNNING' && r.lockedBy === worker ? r : null;
  }

  async renewLease(id: string, worker: string, until: Date) {
    const r = this.mine(id, worker);
    if (!r) return false;
    r.lockedUntil = until;
    return true;
  }

  async progress(id: string, worker: string, patch: { phase?: RoutingJobPhase; progress?: number; graphVersion?: string | null }) {
    const r = this.mine(id, worker);
    if (!r) return false;
    if (patch.phase !== undefined) {
      const from = logicalState(r.status, r.phase);
      const to = logicalState('RUNNING', patch.phase);
      if (from !== to) assertTransition(from, to);
      r.phase = patch.phase;
    }
    if (patch.progress !== undefined) r.progress = patch.progress;
    if (patch.graphVersion !== undefined) r.graphVersion = patch.graphVersion;
    return true;
  }

  async cancelRequested(id: string) {
    return this.rows.get(id)?.cancelRequested ?? false;
  }

  async succeed(id: string, worker: string, result: unknown, graphVersion: string | null, now: Date, within?: (tx: StoreTx) => Promise<void>) {
    const r = this.mine(id, worker);
    if (!r) return false;
    if (within) await within(undefined); // throws → nothing changed (as a rolled-back transaction)
    if (!this.mine(id, worker)) return false;
    this.move(r, 'SUCCEEDED', 'done');
    Object.assign(r, { result, graphVersion, progress: 100, finishedAt: now, lockedUntil: null, error: null });
    this.committed.push({ jobId: id, worker });
    return true;
  }

  private apply(r: JobRecord, d: FailureDecision, now: Date) {
    if (d.to === 'QUEUED') {
      this.move(r, 'QUEUED', null);
      Object.assign(r, { lockedBy: null, lockedUntil: null, notBefore: d.notBeforeMs ? new Date(d.notBeforeMs) : null, error: d.error });
    } else if (d.to === 'FAILED') {
      this.move(r, 'FAILED', null);
      Object.assign(r, { lockedUntil: null, finishedAt: now, error: d.error });
    } else {
      this.move(r, 'CANCELLED', null);
      Object.assign(r, { lockedUntil: null, finishedAt: now });
    }
  }

  async settle(id: string, worker: string, d: FailureDecision, now: Date) {
    const r = this.mine(id, worker);
    if (!r) return false;
    this.apply(r, d, now);
    return true;
  }

  async requestCancel(companyId: string, id: string, now: Date): Promise<CancelOutcome> {
    const r = this.rows.get(id);
    if (!r || r.companyId !== companyId) return null;
    if (r.status === 'QUEUED') {
      this.move(r, 'CANCELLED', null);
      Object.assign(r, { cancelRequested: true, finishedAt: now });
      return { outcome: 'cancelled', job: { ...r } };
    }
    if (r.status === 'RUNNING') {
      r.cancelRequested = true;
      return { outcome: 'requested', job: { ...r } };
    }
    return { outcome: 'final', job: { ...r } };
  }

  async expired(now: Date, limit: number) {
    return [...this.rows.values()]
      .filter((r) => r.status === 'RUNNING' && r.lockedUntil && r.lockedUntil < now)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async settleExpired(id: string, d: FailureDecision, now: Date) {
    const r = this.rows.get(id);
    if (!r || r.status !== 'RUNNING' || !r.lockedUntil || r.lockedUntil >= now) return false;
    this.apply(r, d, now);
    return true;
  }

  async due(now: Date, createdBefore: Date, limit: number) {
    return [...this.rows.values()]
      .filter((r) => r.status === 'QUEUED' && !r.cancelRequested && (!r.notBefore || r.notBefore <= now) && r.createdAt < createdBefore)
      .slice(0, limit)
      .map((r) => r.id);
  }

  private active(companyId: string, now: Date): number {
    return [...this.rows.values()].filter((r) => r.companyId === companyId && (r.status === 'QUEUED' || (r.status === 'RUNNING' && r.lockedUntil && r.lockedUntil > now))).length;
  }

  async activeCount(companyId: string, now: Date) {
    return this.active(companyId, now);
  }

  async createdSince(companyId: string, since: Date) {
    return [...this.rows.values()].filter((r) => r.companyId === companyId && r.createdAt >= since).length;
  }

  async stats(now: Date) {
    const all = [...this.rows.values()];
    const queued = all.filter((r) => r.status === 'QUEUED');
    return {
      queued: queued.length,
      running: all.filter((r) => r.status === 'RUNNING').length,
      failed24h: all.filter((r) => r.status === 'FAILED' && r.finishedAt && r.finishedAt.getTime() > now.getTime() - 86_400_000).length,
      oldestQueuedAt: queued.reduce<Date | null>((m, r) => (!m || r.createdAt < m ? r.createdAt : m), null),
    };
  }
}
