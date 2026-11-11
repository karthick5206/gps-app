import { Prisma, PrismaClient, RoutingJob } from '@prisma/client';
import type { RoutingJobPhase } from '@veetracer/shared';
import { FailureDecision, JobErrorBody } from './job-state';
import { ActiveLimitExceeded, CancelOutcome, DuplicateIdempotencyKey, JobListFilter, JobRecord, NewJob, RoutingJobStore, StoreTx, PlanNotFound } from './job-store';

type Db = Pick<PrismaClient, 'routingJob' | '$transaction'>;

const json = (v: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull => (v === null || v === undefined ? Prisma.DbNull : (v as Prisma.InputJsonValue));

export function fromRow(r: RoutingJob): JobRecord {
  return { ...r, error: (r.error as JobErrorBody | null) ?? null, phase: r.phase as RoutingJobPhase | null };
}

/**
 * `RoutingJob` (migration routing_engine_v2) as the job store. Every state change is a conditional `updateMany`
 * (compare-and-set), so concurrent workers, re-deliveries and the sweeper never double-run or double-finish a job.
 */
export class PrismaJobStore implements RoutingJobStore {
  constructor(private readonly db: Db) {}

  async create(job: NewJob, onCreate?: (tx: StoreTx, job: JobRecord) => Promise<{ input?: unknown } | void>): Promise<JobRecord> {
    try {
      return await this.db.$transaction(async (tx) => {
        if (job.maxActive !== undefined) {
          // Informational finding (quota TOCTOU): one inserter per company at a time (transaction-scoped advisory lock,
          // released at commit) and the count taken under it, so concurrent requests cannot all pass the limit. A
          // same-key duplicate that waited here is still answered as a replay, not as a quota error.
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`routing-active:${job.companyId}`}, 0))::text`;
          if (job.idempotencyKey && (await tx.routingJob.count({ where: { companyId: job.companyId, idempotencyKey: job.idempotencyKey } }))) throw new DuplicateIdempotencyKey();
          const now = new Date();
          const active = await tx.routingJob.count({ where: { companyId: job.companyId, OR: [{ status: 'QUEUED' }, { status: 'RUNNING', lockedUntil: { gt: now } }] } });
          if (active >= job.maxActive) throw new ActiveLimitExceeded();
        }
        let row = await tx.routingJob.create({
          data: {
            companyId: job.companyId,
            userId: job.userId,
            planId: job.planId,
            kind: job.kind,
            input: json(job.input),
            idempotencyKey: job.idempotencyKey,
            requestHash: job.requestHash,
            timeoutS: job.timeoutS,
            maxAttempts: job.maxAttempts,
          },
        });
        if (onCreate) {
          const patch = await onCreate(tx, fromRow(row));
          if (patch && patch.input !== undefined) row = await tx.routingJob.update({ where: { id: row.id }, data: { input: json(patch.input) } });
        }
        return fromRow(row);
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && job.idempotencyKey) throw new DuplicateIdempotencyKey();
      // T1-D6: a plan id that is not this company's (unknown, or another company's: the e4_security_hardening trigger)
      // fails the insert with 23503 before the plan reservation could answer 404.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003' && job.planId) throw new PlanNotFound();
      throw e;
    }
  }

  async findByKey(companyId: string, key: string) {
    const r = await this.db.routingJob.findFirst({ where: { companyId, idempotencyKey: key } });
    return r ? fromRow(r) : null;
  }

  async get(id: string) {
    const r = await this.db.routingJob.findUnique({ where: { id } });
    return r ? fromRow(r) : null;
  }

  async getScoped(companyId: string, id: string) {
    const r = await this.db.routingJob.findFirst({ where: { id, companyId } });
    return r ? fromRow(r) : null;
  }

  async list(companyId: string, f: JobListFilter) {
    const rows = await this.db.routingJob.findMany({
      where: { companyId, ...(f.planId ? { planId: f.planId } : {}), ...(f.status?.length ? { status: { in: f.status } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: f.limit,
    });
    return rows.map(fromRow);
  }

  async claim(id: string, worker: string, now: Date, leaseMs: number) {
    const n = await this.db.routingJob.updateMany({
      where: { id, status: 'QUEUED', cancelRequested: false, OR: [{ notBefore: null }, { notBefore: { lte: now } }] },
      data: { status: 'RUNNING', phase: 'matrix', lockedBy: worker, lockedUntil: new Date(now.getTime() + leaseMs), attempts: { increment: 1 }, startedAt: now, progress: 1, notBefore: null },
    });
    if (!n.count) return null;
    return this.get(id);
  }

  private mine(id: string, worker: string): Prisma.RoutingJobWhereInput {
    return { id, status: 'RUNNING', lockedBy: worker };
  }

  async renewLease(id: string, worker: string, until: Date) {
    return (await this.db.routingJob.updateMany({ where: this.mine(id, worker), data: { lockedUntil: until } })).count === 1;
  }

  async progress(id: string, worker: string, patch: { phase?: RoutingJobPhase; progress?: number; graphVersion?: string | null }) {
    const data: Prisma.RoutingJobUpdateManyMutationInput = {};
    if (patch.phase !== undefined) data.phase = patch.phase;
    if (patch.progress !== undefined) data.progress = patch.progress;
    if (patch.graphVersion !== undefined) data.graphVersion = patch.graphVersion;
    return (await this.db.routingJob.updateMany({ where: this.mine(id, worker), data })).count === 1;
  }

  async cancelRequested(id: string) {
    return (await this.db.routingJob.findUnique({ where: { id }, select: { cancelRequested: true } }))?.cancelRequested ?? false;
  }

  async succeed(id: string, worker: string, result: unknown, graphVersion: string | null, now: Date, within?: (tx: StoreTx) => Promise<void>) {
    class Lost extends Error {}
    try {
      await this.db.$transaction(async (tx) => {
        // The job row first: it takes the row lock, so a sweeper cannot re-queue the job while the plan is written.
        const n = await tx.routingJob.updateMany({
          where: this.mine(id, worker),
          data: { status: 'SUCCEEDED', phase: 'done', progress: 100, finishedAt: now, lockedUntil: null, result: json(result), graphVersion, error: Prisma.DbNull },
        });
        if (n.count !== 1) throw new Lost();
        if (within) await within(tx);
      });
      return true;
    } catch (e) {
      if (e instanceof Lost) return false;
      throw e;
    }
  }

  private data(d: FailureDecision, now: Date): Prisma.RoutingJobUpdateManyMutationInput {
    if (d.to === 'QUEUED') return { status: 'QUEUED', phase: null, lockedBy: null, lockedUntil: null, notBefore: d.notBeforeMs ? new Date(d.notBeforeMs) : null, error: d.error as unknown as Prisma.InputJsonValue };
    if (d.to === 'FAILED') return { status: 'FAILED', phase: null, lockedUntil: null, finishedAt: now, error: d.error as unknown as Prisma.InputJsonValue };
    return { status: 'CANCELLED', phase: null, lockedUntil: null, finishedAt: now };
  }

  async settle(id: string, worker: string, d: FailureDecision, now: Date) {
    return (await this.db.routingJob.updateMany({ where: this.mine(id, worker), data: this.data(d, now) })).count === 1;
  }

  async requestCancel(companyId: string, id: string, now: Date): Promise<CancelOutcome> {
    const queued = await this.db.routingJob.updateMany({ where: { id, companyId, status: 'QUEUED' }, data: { status: 'CANCELLED', phase: null, cancelRequested: true, finishedAt: now } });
    if (queued.count) return { outcome: 'cancelled', job: (await this.get(id))! };
    const running = await this.db.routingJob.updateMany({ where: { id, companyId, status: 'RUNNING' }, data: { cancelRequested: true } });
    const row = await this.getScoped(companyId, id);
    if (!row) return null;
    return { outcome: running.count ? 'requested' : 'final', job: row };
  }

  async expired(now: Date, limit: number) {
    return (await this.db.routingJob.findMany({ where: { status: 'RUNNING', lockedUntil: { lt: now } }, take: limit })).map(fromRow);
  }

  async settleExpired(id: string, d: FailureDecision, now: Date) {
    return (await this.db.routingJob.updateMany({ where: { id, status: 'RUNNING', lockedUntil: { lt: now } }, data: this.data(d, now) })).count === 1;
  }

  async due(now: Date, createdBefore: Date, limit: number) {
    const rows = await this.db.routingJob.findMany({
      where: { status: 'QUEUED', cancelRequested: false, OR: [{ notBefore: null }, { notBefore: { lte: now } }], createdAt: { lt: createdBefore } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map((r) => r.id);
  }

  activeCount(companyId: string, now: Date) {
    return this.db.routingJob.count({ where: { companyId, OR: [{ status: 'QUEUED' }, { status: 'RUNNING', lockedUntil: { gt: now } }] } });
  }

  createdSince(companyId: string, since: Date) {
    return this.db.routingJob.count({ where: { companyId, createdAt: { gte: since } } });
  }

  async stats(now: Date) {
    const [queued, running, failed24h, oldest] = await Promise.all([
      this.db.routingJob.count({ where: { status: 'QUEUED' } }),
      this.db.routingJob.count({ where: { status: 'RUNNING' } }),
      this.db.routingJob.count({ where: { status: 'FAILED', finishedAt: { gt: new Date(now.getTime() - 86_400_000) } } }),
      this.db.routingJob.findFirst({ where: { status: 'QUEUED' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    ]);
    return { queued, running, failed24h, oldestQueuedAt: oldest?.createdAt ?? null };
  }
}
