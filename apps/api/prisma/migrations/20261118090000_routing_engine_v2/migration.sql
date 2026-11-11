-- ETMS E4 WP 4.0 (doc 12 §7, doc 17 §7 P6, doc 15 §10): routing engine v2 tables, ported from feature/routing-engine
-- 19150e8 (doc 17 §1.3 / §1.4) and regenerated against the current schema. Additive only: six new tables, two new enums,
-- no change to any existing table. The branch's own migrations (20261110110000 / 20261110120000) are never applied.
-- Changes against the branch (doc 17 §2.1, §2.5):
-- * RouteStop → "RoutePlanStop" (v1.8 "RouteStop" is a master-route stop); all index / constraint names regenerated.
-- * S-1 RoutePlan.createdById: plain actor column, no FK to User (doc 15 §1.1).
-- * S-2 / R2 Q-c RouteAssignment.objectId → TrackedObject and .driverId → Driver are FKs ON DELETE SET NULL: a vehicle
--   or driver purge keeps the plan history (the FK also stops the purge planner's TrackedObject logical-key walk).
-- * S-3 / R2 Q-b no RouteAssignment.assigneeUserId: driver identity is Driver.userId (D5).
-- * S-4 RoutePlanStatus without COMPLETED (execution lives on PlannedTrip / TransportTrip, D2).
-- * S-5 RoutingJob(planId) index. RoutingJobStatus is created with CANCELLED directly (no ALTER TYPE … ADD VALUE).
-- * Engine-neutral: RoutePlan.profile (car | van | bus | foot, default car) instead of the branch's costing ('auto');
--   RouteAssignment.geometry is GeoJSON JSON ([lng, lat]) instead of a precision-6 polyline.
-- * Tenancy: RoutePlan.companyId = the operator (FK Restrict, walked by a company purge); children carry companyId with
--   composite FKs (planId, companyId) → RoutePlan (id, companyId), row id first (doc 15 §1.2 / §1.4), so a cross-company
--   child is rejected by PostgreSQL. No SetNull FK on a column named companyId.
-- * Retention (S-7): indexes for the trims (RoutePlan(companyId, planDate), RoutingJob(finishedAt), RoutingUsage(day)).
--   The trim steps themselves ship with the worker / retention code (WP 4.2) and follow owner decision L3; until then
--   nothing is trimmed automatically.
-- * Privacy: RoutingJob.input and RoutePlanVersion.snapshot never hold passenger coordinates or names (shared
--   RoutingJobInput / RoutePlanVersionSnapshot); personal points on plan stops come in etms_planning_links.
-- Flags: nothing reads these tables unless ETMS is on, ETMS_ROUTING=on and the company add-on etms is enabled.
--
-- ROLLBACK: switch ETMS_ROUTING off (default) or redeploy the previous tag; the previous code never reads these tables.
-- Do not drop them in a down-migration. Manual revert (owner decision only):
--   DROP TABLE "RoutePlanVersion", "RoutingUsage", "RoutingJob", "RoutePlanStop", "RouteAssignment", "RoutePlan";
--   DROP TYPE "RoutingJobStatus"; DROP TYPE "RoutePlanStatus";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261118090000_routing_engine_v2';
SET lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "RoutePlanStatus" AS ENUM ('DRAFT', 'OPTIMIZING', 'PLANNED', 'PUBLISHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RoutingJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "RoutePlan" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "branchId" UUID,
    "name" TEXT NOT NULL,
    "planDate" DATE NOT NULL,
    "planStartAt" TIMESTAMPTZ(3),
    "status" "RoutePlanStatus" NOT NULL DEFAULT 'DRAFT',
    "profile" TEXT NOT NULL DEFAULT 'car',
    "graphVersion" TEXT,
    "depot" JSONB,
    "options" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RoutePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteAssignment" (
    "id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "objectId" UUID,
    "driverId" UUID,
    "vehicleLabel" TEXT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "capacity" INTEGER,
    "distanceM" INTEGER,
    "durationS" INTEGER,
    "adjustedDurationS" INTEGER,
    "startS" INTEGER,
    "endS" INTEGER,
    "geometry" JSONB,
    "etaModel" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RouteAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutePlanStop" (
    "id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "assignmentId" UUID,
    "ref" TEXT NOT NULL,
    "name" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "demand" INTEGER NOT NULL DEFAULT 0,
    "serviceS" INTEGER NOT NULL DEFAULT 0,
    "timeWindows" JSONB,
    "sequence" INTEGER,
    "etaS" INTEGER,
    "unassignedReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RoutePlanStop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutingJob" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "planId" UUID,
    "userId" UUID,
    "kind" TEXT NOT NULL,
    "status" "RoutingJobStatus" NOT NULL DEFAULT 'QUEUED',
    "phase" TEXT,
    "input" JSONB,
    "result" JSONB,
    "error" JSONB,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "timeoutS" INTEGER NOT NULL DEFAULT 120,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "lockedBy" TEXT,
    "lockedUntil" TIMESTAMPTZ(3),
    "notBefore" TIMESTAMPTZ(3),
    "graphVersion" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "RoutingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutingUsage" (
    "companyId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "routes" INTEGER NOT NULL DEFAULT 0,
    "matrixCells" INTEGER NOT NULL DEFAULT 0,
    "optimizeJobs" INTEGER NOT NULL DEFAULT 0,
    "cacheHits" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RoutingUsage_pkey" PRIMARY KEY ("companyId","day")
);

-- CreateTable
CREATE TABLE "RoutePlanVersion" (
    "id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "changeType" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoutePlanVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoutePlan_companyId_planDate_idx" ON "RoutePlan"("companyId", "planDate");

-- CreateIndex
CREATE INDEX "RoutePlan_companyId_status_idx" ON "RoutePlan"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RoutePlan_id_companyId_key" ON "RoutePlan"("id", "companyId");

-- CreateIndex
CREATE INDEX "RouteAssignment_planId_idx" ON "RouteAssignment"("planId");

-- CreateIndex
CREATE INDEX "RouteAssignment_objectId_idx" ON "RouteAssignment"("objectId");

-- CreateIndex
CREATE INDEX "RouteAssignment_driverId_idx" ON "RouteAssignment"("driverId");

-- CreateIndex
CREATE INDEX "RoutePlanStop_assignmentId_idx" ON "RoutePlanStop"("assignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "RoutePlanStop_planId_ref_key" ON "RoutePlanStop"("planId", "ref");

-- CreateIndex
CREATE INDEX "RoutingJob_companyId_createdAt_idx" ON "RoutingJob"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "RoutingJob_status_lockedUntil_idx" ON "RoutingJob"("status", "lockedUntil");

-- CreateIndex
CREATE INDEX "RoutingJob_planId_idx" ON "RoutingJob"("planId");

-- CreateIndex
CREATE INDEX "RoutingJob_finishedAt_idx" ON "RoutingJob"("finishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RoutingJob_companyId_idempotencyKey_key" ON "RoutingJob"("companyId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "RoutingUsage_day_idx" ON "RoutingUsage"("day");

-- CreateIndex
CREATE INDEX "RoutePlanVersion_companyId_createdAt_idx" ON "RoutePlanVersion"("companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RoutePlanVersion_planId_version_key" ON "RoutePlanVersion"("planId", "version");

-- AddForeignKey
ALTER TABLE "RoutePlan" ADD CONSTRAINT "RoutePlan_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutePlan" ADD CONSTRAINT "RoutePlan_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteAssignment" ADD CONSTRAINT "RouteAssignment_planId_companyId_fkey" FOREIGN KEY ("planId", "companyId") REFERENCES "RoutePlan"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteAssignment" ADD CONSTRAINT "RouteAssignment_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteAssignment" ADD CONSTRAINT "RouteAssignment_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutePlanStop" ADD CONSTRAINT "RoutePlanStop_planId_companyId_fkey" FOREIGN KEY ("planId", "companyId") REFERENCES "RoutePlan"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutePlanStop" ADD CONSTRAINT "RoutePlanStop_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "RouteAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingJob" ADD CONSTRAINT "RoutingJob_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingJob" ADD CONSTRAINT "RoutingJob_planId_fkey" FOREIGN KEY ("planId") REFERENCES "RoutePlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingUsage" ADD CONSTRAINT "RoutingUsage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutePlanVersion" ADD CONSTRAINT "RoutePlanVersion_planId_companyId_fkey" FOREIGN KEY ("planId", "companyId") REFERENCES "RoutePlan"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;


-- Raw SQL (Prisma cannot express CHECK constraints; documented on the models). None involves a column that an FK sets
-- to NULL, so no purge cascade can violate them (doc 15 §1.3).
ALTER TABLE "RoutePlan" ADD CONSTRAINT "RoutePlan_version_check" CHECK ("version" >= 1);
ALTER TABLE "RoutePlan" ADD CONSTRAINT "RoutePlan_profile_check" CHECK ("profile" IN ('car', 'van', 'bus', 'foot'));
ALTER TABLE "RoutePlan" ADD CONSTRAINT "RoutePlan_published_check" CHECK ("status" <> 'PUBLISHED' OR "publishedAt" IS NOT NULL);
ALTER TABLE "RouteAssignment" ADD CONSTRAINT "RouteAssignment_numbers_check" CHECK (
  "seq" >= 0 AND ("capacity" IS NULL OR "capacity" >= 0) AND ("distanceM" IS NULL OR "distanceM" >= 0)
  AND ("durationS" IS NULL OR "durationS" >= 0) AND ("adjustedDurationS" IS NULL OR "adjustedDurationS" >= 0)
  AND ("startS" IS NULL OR "endS" IS NULL OR "startS" <= "endS"));
ALTER TABLE "RoutePlanStop" ADD CONSTRAINT "RoutePlanStop_point_check" CHECK ("lat" BETWEEN -90 AND 90 AND "lng" BETWEEN -180 AND 180);
ALTER TABLE "RoutePlanStop" ADD CONSTRAINT "RoutePlanStop_numbers_check" CHECK (
  "demand" >= 0 AND "serviceS" >= 0 AND ("sequence" IS NULL OR "sequence" >= 0) AND ("etaS" IS NULL OR "etaS" >= 0));
ALTER TABLE "RoutingJob" ADD CONSTRAINT "RoutingJob_kind_check" CHECK ("kind" IN ('optimize', 'matrix'));
ALTER TABLE "RoutingJob" ADD CONSTRAINT "RoutingJob_phase_check" CHECK ("phase" IS NULL OR "phase" IN ('matrix', 'assign_stops', 'solve', 'route_legs', 'done'));
ALTER TABLE "RoutingJob" ADD CONSTRAINT "RoutingJob_counters_check" CHECK (
  "progress" BETWEEN 0 AND 100 AND "attempts" >= 0 AND "maxAttempts" >= 1 AND "timeoutS" >= 1);
ALTER TABLE "RoutingJob" ADD CONSTRAINT "RoutingJob_finished_check" CHECK ("status" IN ('QUEUED', 'RUNNING') OR "finishedAt" IS NOT NULL);
ALTER TABLE "RoutingUsage" ADD CONSTRAINT "RoutingUsage_counters_check" CHECK ("routes" >= 0 AND "matrixCells" >= 0 AND "optimizeJobs" >= 0 AND "cacheHits" >= 0);
ALTER TABLE "RoutePlanVersion" ADD CONSTRAINT "RoutePlanVersion_version_check" CHECK ("version" >= 1);
