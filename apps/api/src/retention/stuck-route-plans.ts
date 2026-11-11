import { Prisma, PrismaClient } from '@prisma/client';

/**
 * E4 security review L6: a plan left in OPTIMIZING (ETMS_ROUTING switched off while jobs were QUEUED — the documented
 * rollback — or a job that ended without releasing the plan) would otherwise outlive retention with the passengers'
 * consented points on it. Retention purges such a plan once it is past the company's cutoff and either
 *   - ETMS_ROUTING is off (no worker will ever run its job), or
 *   - none of its jobs is still active (QUEUED / RUNNING): the job is terminal or missing.
 *
 * Lock order (re-check R4): the job result write locks the job row, then the plan row. Retention therefore works in two
 * transactions and never holds a plan lock while it waits for a job row:
 *   1. routing off only: the candidates' still-active jobs are CANCELLED in a job-only transaction (finishedAt set;
 *      error code CANCELLED, ids only). A worker that still owns one finishes first (this waits on its job row
 *      without holding any plan lock), and then its plan is no longer OPTIMIZING, so step 2 leaves it alone.
 *   2. the plans are locked in id order with SKIP LOCKED (a plan being written is skipped until the next run), the
 *      condition is checked again under the lock (OPTIMIZING, past the cutoff, no active job), and they are deleted:
 *      stops, assignments and versions cascade, the jobs' planId is set NULL, published trips keep their headers.
 * Returns the number of plans deleted.
 */
export async function purgeStuckRoutePlans(db: Pick<PrismaClient, '$transaction' | '$queryRaw'>, companyId: string, cutoff: Date, routingOn: boolean, limit: number, now = new Date()): Promise<number> {
  const candidates = (
    await db.$queryRaw<{ id: string }[]>`
      SELECT p.id FROM "RoutePlan" p
      WHERE p."companyId" = ${companyId}::uuid AND p."planDate" < ${cutoff} AND p."status" = 'OPTIMIZING'
        AND (${!routingOn} OR NOT EXISTS (
          SELECT 1 FROM "RoutingJob" j WHERE j."planId" = p.id AND j."status" IN ('QUEUED', 'RUNNING')))
      ORDER BY p.id LIMIT ${limit}`
  ).map((r) => r.id);
  if (!candidates.length) return 0;
  if (!routingOn) {
    await db.$transaction((tx) =>
      tx.routingJob.updateMany({
        where: { planId: { in: candidates }, status: { in: ['QUEUED', 'RUNNING'] } },
        data: {
          status: 'CANCELLED',
          phase: null,
          cancelRequested: true,
          lockedUntil: null,
          finishedAt: now,
          error: { code: 'CANCELLED', message: 'Cancelled by retention: the plan date is past the retention period and routing is off' } as Prisma.InputJsonValue,
        },
      }),
    );
  }
  return db.$transaction(async (tx) => {
    const ids = (
      await tx.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM "RoutePlan" p
        WHERE p.id = ANY(${candidates}::uuid[]) AND p."companyId" = ${companyId}::uuid AND p."planDate" < ${cutoff} AND p."status" = 'OPTIMIZING'
          AND NOT EXISTS (SELECT 1 FROM "RoutingJob" j WHERE j."planId" = p.id AND j."status" IN ('QUEUED', 'RUNNING'))
        ORDER BY p.id FOR UPDATE OF p SKIP LOCKED`
    ).map((r) => r.id);
    if (!ids.length) return 0;
    return (await tx.routePlan.deleteMany({ where: { id: { in: ids }, companyId } })).count;
  });
}
