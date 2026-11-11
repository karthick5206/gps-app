-- D6 G2 + G3 (v1.8.3): durable alert notifications and truthful delivery status.
-- Additive only: new nullable / defaulted columns, two partial indexes, one bounded data update.
--
-- ROLLBACK: redeploy the previous tag (REF=v1.8.2 bash release.sh). Leave these columns and indexes in place: the
-- previous code never reads or writes them, and the partial unique index only covers rows with a "dedupeKey", which old
-- code never sets. Do NOT drop the columns in a down-migration (no data rollback is needed). If the schema must be
-- reverted anyway (owner decision), the manual statements are:
--   DROP INDEX IF EXISTS "NotificationLog_dedupeKey_key"; DROP INDEX IF EXISTS "NotificationLog_queued_createdAt_idx";
--   DROP INDEX IF EXISTS "Alert_notify_pending_idx";
--   ALTER TABLE "NotificationLog" DROP COLUMN "dedupeKey", DROP COLUMN "providerMessageId", DROP COLUMN "nextAttemptAt", DROP COLUMN "attempts";
--   ALTER TABLE "Alert" DROP COLUMN "notifyError", DROP COLUMN "notifiedAt";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261114070000_notifier_durability';

-- Alert: set by the notifier when the job finished (notifiedAt) or was declared DEAD (notifyError).
ALTER TABLE "Alert" ADD COLUMN "notifiedAt" TIMESTAMPTZ(3),
                    ADD COLUMN "notifyError" TEXT;

-- NotificationLog: per-recipient idempotency (dedupeKey), lease (nextAttemptAt), attempt count, provider id.
ALTER TABLE "NotificationLog" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
                              ADD COLUMN "nextAttemptAt" TIMESTAMPTZ(3),
                              ADD COLUMN "providerMessageId" TEXT,
                              ADD COLUMN "dedupeKey" TEXT;

-- At most one record per alert + channel + recipient (old rows have no key and are not affected).
CREATE UNIQUE INDEX "NotificationLog_dedupeKey_key" ON "NotificationLog" ("dedupeKey") WHERE "dedupeKey" IS NOT NULL;

-- Sweeper lookup for pre-rendered (test / reminder) messages that never left QUEUED. Small: QUEUED rows are transient.
CREATE INDEX "NotificationLog_queued_createdAt_idx" ON "NotificationLog" ("createdAt") WHERE "status" = 'QUEUED';

-- Sweeper lookup for alerts without a finished notification job. The constant lower bound keeps the index small
-- (historical alerts are outside the 24 h sweep window anyway); the sweeper query repeats the same constant so the
-- planner can use the partial index. Keep the literal in sync with NOTIFY_SWEEP_FLOOR in notify-sweeper.ts.
CREATE INDEX "Alert_notify_pending_idx" ON "Alert" ("createdAt")
  WHERE "notifiedAt" IS NULL AND "notifyError" IS NULL AND "createdAt" >= TIMESTAMP '2026-11-01 00:00:00';

-- Alerts of the last 25 h were handled by the previous notifier: mark them so the first sweep does not re-queue them.
-- "createdAt" is a timestamp without time zone holding UTC (Prisma convention), hence AT TIME ZONE 'UTC'.
UPDATE "Alert" SET "notifiedAt" = "createdAt" AT TIME ZONE 'UTC'
 WHERE "createdAt" > (now() AT TIME ZONE 'UTC') - interval '25 hours';
