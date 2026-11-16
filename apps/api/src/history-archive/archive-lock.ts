import { Prisma } from '@prisma/client';

/**
 * Per-vehicle transaction lock shared by the archive job and the summarizer (PostgreSQL advisory xact lock on
 * hashtextextended('vt:archive:<objectId>')). The archive job holds it while it re-checks the summarizer state and
 * deletes a day's points; the summarizer holds it while it re-reads the archive horizon and writes its results, so a
 * recomputation never uses a day whose points left meanwhile, and a day is never archived while it is being recomputed.
 * Ids are locked in sorted order (no deadlock between two multi-vehicle holders).
 */
export async function lockArchiveObjects(tx: Prisma.TransactionClient, objectIds: string[]): Promise<void> {
  if (!objectIds.length) return;
  const ids = [...new Set(objectIds)].sort();
  await tx.$queryRaw`
    SELECT count(l.r)::int AS n FROM (
      SELECT pg_advisory_xact_lock(hashtextextended('vt:archive:' || x, 0))::text AS r
      FROM (SELECT x FROM unnest(${ids}::text[]) AS x ORDER BY x) s
    ) l`;
}
