-- ETMS E5 (doc 12 WP 5.0 / 5.1, doc 15 §10): driver operations and transport notifications. Additive only.
-- * TransportDriverDuty: a driver's duty (online-only start / end in the driver app). One open duty per driver
--   (partial unique index). R1 writes no DriverAssignment (owner decision P5).
-- * TransportNotification: the in-app notification inbox (D7 / L4: authoritative history; push is a generic wake-up).
-- * NotificationLog.refType / refId: what a pre-rendered message belongs to (05 §5.6), so the notifier can rebuild the
--   generic push data { kind, tripId, notificationId } without storing anything personal on the log.
-- * TransportTripEvent(receivedAt) index: the notification relay scans recent events.
-- * Backfill: untouched "Transport driver" role templates get etms_driver:edit (ETMS_E5_TEMPLATE_PERMISSIONS).
-- Not here: TransportIncident / TransportIncidentEvent (durable SOS, WP 5.4: separate migration with the legal-hold and
-- purge-survival rules of doc 15 §10, owner decisions L3 / L5).
--
-- ROLLBACK: switch ETMS off (ETMS=off) or redeploy the previous tag; the previous code never reads these tables or
-- columns. Do not drop them in a down-migration. Manual revert (owner decision only):
--   DROP TABLE "TransportNotification"; DROP TABLE "TransportDriverDuty"; DROP INDEX "TransportTripEvent_receivedAt_idx";
--   ALTER TABLE "NotificationLog" DROP COLUMN "refType", DROP COLUMN "refId";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261117090000_etms_driver_ops';
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "NotificationLog" ADD COLUMN     "refId" UUID,
ADD COLUMN     "refType" TEXT;

-- CreateTable
CREATE TABLE "TransportDriverDuty" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "objectId" UUID,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "endedAt" TIMESTAMPTZ(3),
    "source" TEXT NOT NULL DEFAULT 'DRIVER_APP',
    "startedByUserId" UUID,
    "startClientEventId" UUID NOT NULL,
    "endClientEventId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TransportDriverDuty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportNotification" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "audience" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tripId" UUID,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "pushQueued" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransportNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TransportDriverDuty_companyId_startedAt_idx" ON "TransportDriverDuty"("companyId", "startedAt");

-- CreateIndex
CREATE INDEX "TransportDriverDuty_driverId_startedAt_idx" ON "TransportDriverDuty"("driverId", "startedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "TransportDriverDuty_driverId_startClientEventId_key" ON "TransportDriverDuty"("driverId", "startClientEventId");

-- CreateIndex
CREATE UNIQUE INDEX "TransportNotification_dedupeKey_key" ON "TransportNotification"("dedupeKey");

-- CreateIndex
CREATE INDEX "TransportNotification_userId_createdAt_idx" ON "TransportNotification"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "TransportNotification_companyId_createdAt_idx" ON "TransportNotification"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "TransportTripEvent_receivedAt_idx" ON "TransportTripEvent"("receivedAt");

-- AddForeignKey
ALTER TABLE "TransportDriverDuty" ADD CONSTRAINT "TransportDriverDuty_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportDriverDuty" ADD CONSTRAINT "TransportDriverDuty_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportDriverDuty" ADD CONSTRAINT "TransportDriverDuty_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportNotification" ADD CONSTRAINT "TransportNotification_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportNotification" ADD CONSTRAINT "TransportNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportNotification" ADD CONSTRAINT "TransportNotification_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "TransportTrip"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ───────────── Raw SQL (Prisma cannot express these) ─────────────

-- TransportDriverDuty: one open duty per driver; end not before start; known sources.
CREATE UNIQUE INDEX "TransportDriverDuty_open_driver_key" ON "TransportDriverDuty" ("driverId") WHERE "endedAt" IS NULL;
ALTER TABLE "TransportDriverDuty" ADD CONSTRAINT "TransportDriverDuty_end_check" CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt");
ALTER TABLE "TransportDriverDuty" ADD CONSTRAINT "TransportDriverDuty_source_check" CHECK ("source" IN ('DRIVER_APP','WEB'));

-- TransportNotification: closed sets (TransportNotificationKind, audience). No personal data columns exist.
ALTER TABLE "TransportNotification" ADD CONSTRAINT "TransportNotification_audience_check" CHECK ("audience" IN ('DRIVER','PASSENGER'));
ALTER TABLE "TransportNotification" ADD CONSTRAINT "TransportNotification_kind_check"
  CHECK ("kind" IN ('TRIP_ASSIGNED','TRIP_CHANGED','TRIP_UNASSIGNED','TRIP_CANCELLED','TRIP_STARTING_SOON','VEHICLE_APPROACHING','TRIP_DELAYED'));

-- ETMS-E5-BACKFILL-BEGIN (idempotent; the DB test runs this block again)
-- The driver now sends events (etms_driver:edit). Roles that still ARE the seeded "Transport driver" template (same
-- name, seeded description and data scope, not a system role) and grant exactly etms_driver:view get view + edit.
-- Renamed / changed roles are left alone (same rule as the E2 / E3 backfills).
UPDATE "RolePermission" rp SET "actions" = ARRAY['view', 'edit']
FROM "Role" r
WHERE rp."roleId" = r."id" AND rp."menu" = 'etms_driver' AND rp."actions" = ARRAY['view']
  AND r."name" = 'Transport driver' AND r."description" = 'Employee transport: driver (own assigned trips only)'
  AND r."dataScope" = 'ASSIGNED' AND NOT r."isSystem";
-- ETMS-E5-BACKFILL-END
