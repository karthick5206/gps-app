-- History archiving (owner decision 2026-11-15). Additive only: one enum and one NEW table; no existing table or column
-- is changed. The setting itself lives in Company.settings.historyArchive (JSON key, absent = off), so companies without
-- the switch behave exactly as before.
-- * ArchivedDay: one row per (vehicle, local day) whose raw points were moved to a compressed file on the server's disk;
--   also the archive job's claim row (claimToken / claimedAt) and the restore state. Logical keys (companyId, objectId)
--   without foreign keys like the other history tables, so the purge plan clears it with the company / vehicle.
-- * Backfill: the seeded "Admin" system role gets history:command (= restore archived history).
--
-- ROLLBACK: set HISTORY_ARCHIVE=off (stops archive and restore jobs) or redeploy the previous tag; the previous code never
-- reads this table. Archived points stay in the files; restore them first (or keep the files) before dropping anything.
-- Manual revert (owner decision only, AFTER every archived day was restored):
--   UPDATE "RolePermission" SET "actions" = array_remove("actions", 'command') WHERE "menu" = 'history';
--   DROP TABLE "ArchivedDay"; DROP TYPE "ArchivedDayStatus";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261201110000_history_archive';
SET lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "ArchivedDayStatus" AS ENUM ('CLAIMED', 'ARCHIVED', 'RESTORING', 'RESTORED', 'FAILED');

-- CreateTable
CREATE TABLE "ArchivedDay" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "status" "ArchivedDayStatus" NOT NULL DEFAULT 'CLAIMED',
    "filePath" TEXT,
    "pointCount" INTEGER NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMPTZ(3),
    "restoreRequestedAt" TIMESTAMPTZ(3),
    "restoreRequestedBy" UUID,
    "restoreKeepDays" INTEGER,
    "restoredAt" TIMESTAMPTZ(3),
    "keepUntil" TIMESTAMPTZ(3),
    "claimToken" TEXT,
    "claimedAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ArchivedDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ArchivedDay_objectId_day_key" ON "ArchivedDay"("objectId", "day");

-- CreateIndex
CREATE INDEX "ArchivedDay_companyId_day_idx" ON "ArchivedDay"("companyId", "day");

-- CreateIndex
CREATE INDEX "ArchivedDay_status_keepUntil_idx" ON "ArchivedDay"("status", "keepUntil");

-- Backfill: the built-in Admin role of every company may restore archived history (history:command). Only the seeded
-- system role; custom roles are granted by the company's admins as usual.
UPDATE "RolePermission" rp SET "actions" = array_append(rp."actions", 'command')
FROM "Role" r
WHERE r."id" = rp."roleId" AND r."isSystem" AND r."name" = 'Admin' AND rp."menu" = 'history'
  AND NOT ('command' = ANY(rp."actions"));
