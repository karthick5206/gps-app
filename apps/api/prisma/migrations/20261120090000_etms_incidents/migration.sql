-- ETMS E5 WP 5.4 (doc 12 §8, doc 15 §3.2 / §10, doc 10 §6): durable SOS. Additive only: one enum and three NEW tables;
-- no existing table or column is changed. The only existing-table effect is the role-template backfill at the end
-- (RolePermission rows added to untouched seeded templates, ON CONFLICT DO NOTHING).
-- * OutboxEvent + OutboxClass: the general transactional outbox exactly as doc 15 §3.2 (logical keys without FK,
--   partial pending index for the relay's SKIP LOCKED poll). E5 writes / relays only class SAFETY.
-- * TransportIncident: SOS raised by a passenger or a driver. Survives ordinary purge and retention (doc 15 §10): no
--   companyId / objectId / deviceId columns, provider / customer / trip FKs ON DELETE SET NULL (README §7 L5 default:
--   SetNull + anonymise in place), legalHold, last-known fix snapshot. One OPEN SOS per raiser login (repeat presses
--   merge, partial unique). Retention / legal-hold behaviour beyond these schema defaults is an owner decision (L3 / L5).
-- * TransportIncidentEvent: append-only incident history (created, repeated, notify, acknowledged, resolved).
-- * Backfill: untouched "Transport admin" / "Transport dispatcher" templates get the new menu etms_incidents (P6).
--
-- ROLLBACK: switch ETMS off (ETMS=off) or redeploy the previous tag; the previous code never reads these tables. Do not
-- drop them in a down-migration (incidents are safety records). Manual revert (owner decision only):
--   DELETE FROM "RolePermission" WHERE "menu" = 'etms_incidents';
--   DROP TABLE "TransportIncidentEvent"; DROP TABLE "TransportIncident"; DROP TABLE "OutboxEvent"; DROP TYPE "OutboxClass";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261120090000_etms_incidents';
SET lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "OutboxClass" AS ENUM ('SAFETY', 'OPERATIONAL', 'INFO');

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "customerCompanyId" UUID,
    "providerCompanyId" UUID,
    "type" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" UUID NOT NULL,
    "aggregateVersion" INTEGER,
    "class" "OutboxClass" NOT NULL,
    "payload" JSONB NOT NULL,
    "correlationId" TEXT,
    "causationId" UUID,
    "idempotencyKey" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "publishedAt" TIMESTAMPTZ(3),
    "deadAt" TIMESTAMPTZ(3),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportIncident" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'SOS',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "severity" TEXT NOT NULL DEFAULT 'CRITICAL',
    "raiserType" TEXT NOT NULL,
    "raiserUserId" UUID,
    "raiserDriverId" UUID,
    "raiserProfileId" UUID,
    "providerCompanyId" UUID,
    "customerCompanyId" UUID,
    "tripId" UUID,
    "vehicleLabel" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "raisedAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "fixLat" DOUBLE PRECISION,
    "fixLng" DOUBLE PRECISION,
    "fixAccuracyM" DOUBLE PRECISION,
    "fixAt" TIMESTAMPTZ(3),
    "repeatCount" INTEGER NOT NULL DEFAULT 0,
    "lastRepeatAt" TIMESTAMPTZ(3),
    "acknowledgedAt" TIMESTAMPTZ(3),
    "acknowledgedByUserId" UUID,
    "ackNote" TEXT,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedByUserId" UUID,
    "resolution" TEXT,
    "resolveNote" TEXT,
    "legalHold" BOOLEAN NOT NULL DEFAULT false,
    "anonymisedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TransportIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportIncidentEvent" (
    "id" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorUserId" UUID,
    "clientKey" TEXT,
    "requestHash" TEXT,
    "note" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransportIncidentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutboxEvent_aggregateType_aggregateId_createdAt_idx" ON "OutboxEvent"("aggregateType", "aggregateId", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_createdAt_idx" ON "OutboxEvent"("createdAt");

-- CreateIndex
CREATE INDEX "TransportIncident_providerCompanyId_status_receivedAt_idx" ON "TransportIncident"("providerCompanyId", "status", "receivedAt");

-- CreateIndex
CREATE INDEX "TransportIncident_customerCompanyId_status_receivedAt_idx" ON "TransportIncident"("customerCompanyId", "status", "receivedAt");

-- CreateIndex
CREATE INDEX "TransportIncident_tripId_idx" ON "TransportIncident"("tripId");

-- CreateIndex
CREATE INDEX "TransportIncident_status_receivedAt_idx" ON "TransportIncident"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TransportIncident_raiserUserId_idempotencyKey_key" ON "TransportIncident"("raiserUserId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "TransportIncidentEvent_incidentId_at_idx" ON "TransportIncidentEvent"("incidentId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "TransportIncidentEvent_actorUserId_clientKey_key" ON "TransportIncidentEvent"("actorUserId", "clientKey");

-- AddForeignKey
ALTER TABLE "TransportIncident" ADD CONSTRAINT "TransportIncident_providerCompanyId_fkey" FOREIGN KEY ("providerCompanyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportIncident" ADD CONSTRAINT "TransportIncident_customerCompanyId_fkey" FOREIGN KEY ("customerCompanyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportIncident" ADD CONSTRAINT "TransportIncident_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "TransportTrip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportIncidentEvent" ADD CONSTRAINT "TransportIncidentEvent_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "TransportIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ───────────── Raw SQL (Prisma cannot express these) ─────────────

-- OutboxEvent (doc 15 §3.2): relay poll index over pending rows only; attempts never negative; never both published and dead.
CREATE INDEX "OutboxEvent_pending_idx" ON "OutboxEvent" ("class", "availableAt") WHERE "publishedAt" IS NULL AND "deadAt" IS NULL;
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_attempts_check" CHECK ("attempts" >= 0);
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_published_dead_check" CHECK (NOT ("publishedAt" IS NOT NULL AND "deadAt" IS NOT NULL));

-- TransportIncident: one OPEN SOS per raiser login (a second press, or a second device, merges into it; after an
-- acknowledgement a new SOS is a new incident). Closed sets and status timestamps.
CREATE UNIQUE INDEX "TransportIncident_open_sos_raiser_key" ON "TransportIncident" ("raiserUserId")
  WHERE "status" = 'OPEN' AND "kind" = 'SOS' AND "raiserUserId" IS NOT NULL;
ALTER TABLE "TransportIncident" ADD CONSTRAINT "TransportIncident_kind_check" CHECK ("kind" IN ('SOS'));
ALTER TABLE "TransportIncident" ADD CONSTRAINT "TransportIncident_status_check" CHECK ("status" IN ('OPEN','ACKNOWLEDGED','RESOLVED'));
ALTER TABLE "TransportIncident" ADD CONSTRAINT "TransportIncident_raiserType_check" CHECK ("raiserType" IN ('PASSENGER','DRIVER','DISPATCHER'));
ALTER TABLE "TransportIncident" ADD CONSTRAINT "TransportIncident_resolution_check"
  CHECK ("resolution" IS NULL OR "resolution" IN ('ASSISTED','FALSE_ALARM','TEST','DUPLICATE','OTHER'));
ALTER TABLE "TransportIncident" ADD CONSTRAINT "TransportIncident_ack_check" CHECK ("status" = 'OPEN' OR "acknowledgedAt" IS NOT NULL);
ALTER TABLE "TransportIncident" ADD CONSTRAINT "TransportIncident_resolved_check"
  CHECK (("status" = 'RESOLVED') = ("resolvedAt" IS NOT NULL) AND ("status" <> 'RESOLVED' OR "resolution" IS NOT NULL));
ALTER TABLE "TransportIncident" ADD CONSTRAINT "TransportIncident_repeat_check" CHECK ("repeatCount" >= 0);

-- TransportIncidentEvent: closed sets.
ALTER TABLE "TransportIncidentEvent" ADD CONSTRAINT "TransportIncidentEvent_kind_check"
  CHECK ("kind" IN ('CREATED','REPEATED','NOTIFY_PUBLISHED','NOTIFY_DIRECT','ACKNOWLEDGED','RESOLVED'));
ALTER TABLE "TransportIncidentEvent" ADD CONSTRAINT "TransportIncidentEvent_actorType_check"
  CHECK ("actorType" IN ('PASSENGER','DRIVER','DISPATCHER','SYSTEM'));

-- ETMS-E5-SOS-BACKFILL-BEGIN (idempotent; the DB test runs this block again)
-- Companies that switched `etms` on before WP 5.4 hold the role templates without the Incidents & SOS menu, and
-- ensureEtmsRoleTemplates never changes an existing role. Add etms_incidents (ETMS_E5_SOS_TEMPLATE_PERMISSIONS) to roles
-- that still ARE the seeded templates: same name, seeded description and data scope, not a system role (same rule as the
-- E2 / E3 backfills). Renamed / changed roles are left alone; an existing row wins.
INSERT INTO "RolePermission" ("roleId", "menu", "actions")
SELECT r."id", 'etms_incidents', ARRAY['view', 'edit', 'export', 'command']
FROM "Role" r
WHERE r."name" = 'Transport admin' AND r."description" = 'Employee transport: corporate admin (agreements, settings, trips)'
  AND r."dataScope" = 'COMPANY' AND NOT r."isSystem"
ON CONFLICT ("roleId", "menu") DO NOTHING;
INSERT INTO "RolePermission" ("roleId", "menu", "actions")
SELECT r."id", 'etms_incidents', ARRAY['view', 'edit']
FROM "Role" r
WHERE r."name" = 'Transport dispatcher' AND r."description" = 'Employee transport: dispatcher for assigned branches / sites'
  AND r."dataScope" = 'ASSIGNED' AND NOT r."isSystem"
ON CONFLICT ("roleId", "menu") DO NOTHING;
-- ETMS-E5-SOS-BACKFILL-END
