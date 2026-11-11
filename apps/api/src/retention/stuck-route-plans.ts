import { Prisma, PrismaClient } from '@prisma/client';

/**
 * E4 security review L6: a plan left in OPTIMIZING (ETMS_ROUTING switched off while jobs were QUEUED — the documented
 * rollback — or a job that ended without releasing the plan) would otherwise outlive retention with the passengers'
 * consented points on it. Retention purges such a plan once it is past the company's cutoff and either
 *   - ETMS_ROUTING is off (no worker will ever run its job), or
 *   - none of its jobs is still active (QUEUED / RUNNING): the job is terminal or missing.
 * Its still-active jobs (routing off only) are CANCELLED first (finishedAt set; error RETENTION, ids only), then the
 * plan is deleted (stops, assignments and versions cascade; job planId SetNull; published trips keep their headers).
 * One transaction per batch, plan rows locked in id order (the same lock order as every other plan writer).
 * Returns the number of plans deleted.
 */
export async function purgeStuckRoutePlans(db: Pick<PrismaClient, '$transaction'>, companyId: string, cutoff: Date, routingOn: boolean, limit: number, now = new Date()): Promise<number> {
  return db.$transaction(async (tx) => {
    const ids = (
      await tx.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM "RoutePlan" p
        WHERE p."companyId" = ${companyId}::uuid AND p."planDate" < ${cutoff} AND p."status" = 'OPTIMIZING'
          AND (${!routingOn} OR NOT EXISTS (
            SELECT 1 FROM "RoutingJob" j WHERE j."planId" = p.id AND j."status" IN ('QUEUED', 'RUNNING')))
        ORDER BY p.id LIMIT ${limit} FOR UPDATE OF p SKIP LOCKED`
    ).map((r) => r.id);
    if (!ids.length) return 0;
    await tx.routingJob.updateMany({
      where: { planId: { in: ids }, status: { in: ['QUEUED', 'RUNNING'] } },
      data: {
        status: 'CANCELLED',
        phase: null,
        cancelRequested: true,
        lockedUntil: null,
        finishedAt: now,
        error: { code: 'CANCELLED', message: 'Cancelled by retention: the plan date is past the retention period and routing is off' } as Prisma.InputJsonValue,
      },
    });
    return (await tx.routePlan.deleteMany({ where: { id: { in: ids }, companyId } })).count;
  });
}
