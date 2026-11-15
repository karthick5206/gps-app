-- ETMS on-demand pooling and live dispatch (doc 20 §3, §8; owner defaults P1–P8). Additive only: no data rewrite except
-- the P3 backfill of the new ridePreference column, no status change. Rollback = feature switches off (live dispatch
-- is OFF by default per company and has the env kill switch ETMS_LIVE_DISPATCH=off); the columns stay.
--
-- * TransportBooking: ridePreference (P3 backfill: COMMUTE → SHARED, POINT_TO_POINT → PRIVATE), accepted sharing policy
--   + version, immutable limits snapshot (trigger below), dispatcher hold, assignedService; direction nullable for
--   POINT_TO_POINT (existing rows keep IN; the COMMUTE unique index already filters on journey).
-- * TransportTrip: routeTripIndex (an AREA plan route publishes several trips; unique (routeAssignmentId,
--   routeTripIndex) replaces the unique routeAssignmentId), liveRouteVersion / liveRouteAckVersion (P5 driver ack).
-- * RoutePlan.scope / windowStart / windowEnd, RoutePlanStop.tripIndex, TransportVehicleProfile.turnaroundS.
-- * New tables: TransportSharingPolicy, TransportVehicleAvailability, TransportDispatchRequest (logical companyId /
--   objectId / tripId without FK: the purge planner walks them).

-- CreateEnum
CREATE TYPE "RidePreference" AS ENUM ('SHARED', 'PRIVATE', 'FLEXIBLE');

-- CreateEnum
CREATE TYPE "RideService" AS ENUM ('SHARED', 'PRIVATE');

-- CreateEnum
CREATE TYPE "RoutePlanScope" AS ENUM ('SITE', 'AREA');

-- DropIndex
DROP INDEX "TransportTrip_routeAssignmentId_key";

-- AlterTable
ALTER TABLE "TransportVehicleProfile" ADD COLUMN     "turnaroundS" INTEGER;

-- AlterTable
ALTER TABLE "TransportBooking" ADD COLUMN     "assignedService" "RideService",
ADD COLUMN     "holdAt" TIMESTAMPTZ(3),
ADD COLUMN     "holdById" UUID,
ADD COLUMN     "holdFromPlanning" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "holdReason" TEXT,
ADD COLUMN     "limits" JSONB,
ADD COLUMN     "ridePreference" "RidePreference" NOT NULL DEFAULT 'FLEXIBLE',
ADD COLUMN     "sharingPolicyId" UUID,
ADD COLUMN     "sharingPolicyVersion" INTEGER,
ALTER COLUMN "direction" DROP NOT NULL;

-- AlterTable
ALTER TABLE "TransportTrip" ADD COLUMN     "liveRouteAckVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "liveRouteVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "routeTripIndex" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "RoutePlan" ADD COLUMN     "scope" "RoutePlanScope" NOT NULL DEFAULT 'SITE',
ADD COLUMN     "windowEnd" TIMESTAMPTZ(3),
ADD COLUMN     "windowStart" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "RoutePlanStop" ADD COLUMN     "tripIndex" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "TransportSharingPolicy" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMPTZ(3) NOT NULL,
    "text" TEXT NOT NULL,
    "allowFlexible" BOOLEAN NOT NULL DEFAULT true,
    "limits" JSONB NOT NULL,
    "priority" JSONB NOT NULL DEFAULT '{}',
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransportSharingPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportVehicleAvailability" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransportVehicleAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportDispatchRequest" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "bookingId" UUID,
    "tripId" UUID,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "idempotencyKey" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "chosenOptionId" TEXT,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "changeSetId" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMPTZ(3),
    "durationMs" INTEGER,

    CONSTRAINT "TransportDispatchRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TransportSharingPolicy_companyId_version_key" ON "TransportSharingPolicy"("companyId", "version");

-- CreateIndex
CREATE INDEX "TransportVehicleAvailability_objectId_startsAt_idx" ON "TransportVehicleAvailability"("objectId", "startsAt");

-- CreateIndex
CREATE INDEX "TransportVehicleAvailability_companyId_startsAt_idx" ON "TransportVehicleAvailability"("companyId", "startsAt");

-- CreateIndex
CREATE INDEX "TransportDispatchRequest_companyId_createdAt_idx" ON "TransportDispatchRequest"("companyId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "TransportDispatchRequest_status_createdAt_idx" ON "TransportDispatchRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "TransportDispatchRequest_bookingId_idx" ON "TransportDispatchRequest"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "TransportDispatchRequest_companyId_idempotencyKey_key" ON "TransportDispatchRequest"("companyId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "TransportTrip_routeAssignmentId_routeTripIndex_key" ON "TransportTrip"("routeAssignmentId", "routeTripIndex");

-- AddForeignKey
ALTER TABLE "TransportBooking" ADD CONSTRAINT "TransportBooking_sharingPolicyId_fkey" FOREIGN KEY ("sharingPolicyId") REFERENCES "TransportSharingPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportDispatchRequest" ADD CONSTRAINT "TransportDispatchRequest_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "TransportBooking"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ───────────────────────────── raw SQL (Prisma cannot express it) ─────────────────────────────

-- P3 backfill (owner decision): commute rides are pooled today → SHARED; point-to-point rides were dispatched alone →
-- PRIVATE (nobody who never accepted sharing is pooled silently). New rows get their preference from the API.
UPDATE "TransportBooking" SET "ridePreference" = 'SHARED' WHERE "journey" = 'COMMUTE';
UPDATE "TransportBooking" SET "ridePreference" = 'PRIVATE' WHERE "journey" = 'POINT_TO_POINT';

ALTER TABLE "TransportBooking" ADD CONSTRAINT "TransportBooking_policy_version_check" CHECK ("sharingPolicyVersion" IS NULL OR "sharingPolicyVersion" >= 0);
ALTER TABLE "TransportBooking" ADD CONSTRAINT "TransportBooking_direction_check" CHECK ("journey" = 'POINT_TO_POINT' OR "direction" IS NOT NULL);
ALTER TABLE "TransportBooking" ADD CONSTRAINT "TransportBooking_hold_check" CHECK (NOT "holdFromPlanning" OR "holdAt" IS NOT NULL);
ALTER TABLE "TransportTrip" ADD CONSTRAINT "TransportTrip_route_trip_index_check" CHECK ("routeTripIndex" >= 0);
ALTER TABLE "TransportTrip" ADD CONSTRAINT "TransportTrip_live_route_check" CHECK ("liveRouteVersion" >= 0 AND "liveRouteAckVersion" >= 0 AND "liveRouteAckVersion" <= "liveRouteVersion");
ALTER TABLE "RoutePlanStop" ADD CONSTRAINT "RoutePlanStop_trip_index_check" CHECK ("tripIndex" >= 0);
ALTER TABLE "RoutePlan" ADD CONSTRAINT "RoutePlan_window_check" CHECK ("windowStart" IS NULL OR "windowEnd" IS NULL OR "windowEnd" > "windowStart");
ALTER TABLE "TransportVehicleProfile" ADD CONSTRAINT "TransportVehicleProfile_turnaround_check" CHECK ("turnaroundS" IS NULL OR "turnaroundS" BETWEEN 0 AND 7200);
ALTER TABLE "TransportSharingPolicy" ADD CONSTRAINT "TransportSharingPolicy_version_check" CHECK ("version" >= 1);
ALTER TABLE "TransportVehicleAvailability" ADD CONSTRAINT "TransportVehicleAvailability_kind_check" CHECK ("kind" IN ('OPERATING', 'DOWNTIME', 'RESERVED'));
ALTER TABLE "TransportVehicleAvailability" ADD CONSTRAINT "TransportVehicleAvailability_range_check" CHECK ("endsAt" > "startsAt");
ALTER TABLE "TransportDispatchRequest" ADD CONSTRAINT "TransportDispatchRequest_trigger_check" CHECK ("trigger" IN ('NEW_BOOKING', 'CANCEL', 'DELAY', 'BREAKDOWN', 'MANUAL'));
ALTER TABLE "TransportDispatchRequest" ADD CONSTRAINT "TransportDispatchRequest_status_check" CHECK ("status" IN ('QUEUED', 'DECIDED', 'PROPOSED', 'APPLIED', 'REJECTED', 'FAILED'));
ALTER TABLE "TransportDispatchRequest" ADD CONSTRAINT "TransportDispatchRequest_attempts_check" CHECK ("attempts" >= 0);

-- Doc 20 §3.1: the limits snapshot taken at acceptance is immutable while the booking is active (the evidence-guard
-- pattern of the consent tables): once "limits" is set, neither it nor the ride preference nor the accepted policy
-- version may change until the booking reaches a final status. SQLSTATE 23514 (check_violation) so the API maps it to
-- 409 LIMITS_IMMUTABLE.
CREATE OR REPLACE FUNCTION "TransportBooking_limits_immutable"() RETURNS trigger AS $$
BEGIN
  IF OLD."limits" IS NOT NULL
     AND OLD."status" NOT IN ('CANCELLED', 'REJECTED', 'EXPIRED', 'FAILED')
     AND (NEW."limits" IS DISTINCT FROM OLD."limits"
          OR NEW."ridePreference" IS DISTINCT FROM OLD."ridePreference"
          OR NEW."sharingPolicyVersion" IS DISTINCT FROM OLD."sharingPolicyVersion") THEN
    RAISE EXCEPTION 'TransportBooking_limits_immutable: the accepted sharing limits of booking % cannot change', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TransportBooking_limits_immutable"
  BEFORE UPDATE OF "limits", "ridePreference", "sharingPolicyVersion" ON "TransportBooking"
  FOR EACH ROW EXECUTE FUNCTION "TransportBooking_limits_immutable"();

-- Live dispatch worker scan: queued requests by age.
CREATE INDEX "TransportDispatchRequest_queued_idx" ON "TransportDispatchRequest" ("createdAt") WHERE "status" IN ('QUEUED', 'FAILED');
