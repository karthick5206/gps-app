-- ETMS E3 WP 3.1: PlannedTrip.routeId nullable + origin (docs/employee-transport/15 §7.1, §8.2; 02 §5.1; D2). Additive.
-- Ships in the same PR as the routeId-null tolerance code (12 WP 3.1, 15 §12 C-1): after `prisma generate` routeId is
-- `string | null`, so the code that reads it must merge with this migration.
-- * routeId DROP NOT NULL: metadata only. origin TEXT NOT NULL DEFAULT 'ROUTE': constant default, no table rewrite
--   (PG >= 11); every existing row reads origin = 'ROUTE' and keeps its routeId. The two CHECKs scan PlannedTrip once.
-- * Index (driverId, plannedStart) for the driver overlap check of the publish transaction (15 §8.4).
-- * ETMS-scoped EXCLUDE constraints against vehicle / driver double assignment among ACTIVE ETMS trips (15 §8.2). They
--   match zero existing rows (no ETMS trip exists yet), so adding them is instant and changes no v1.8 behaviour; ROUTE
--   vs ETMS overlaps are caught by the publish transaction (advisory lock + overlap query across all origins).
--
-- btree_gist (15 §8.2, owner decision O16): needed for `uuid WITH =` inside a GiST exclusion constraint. It is a
-- trusted contrib extension (PG >= 13): a database owner with CREATE may install it, which is the case for the test
-- databases. On PRODUCTION (PostgreSQL 18.6) it is available (1.8) but NOT installed, and the migration role cannot
-- create it: the Lead installs it once as superuser BEFORE `prisma migrate deploy`, e.g.
--   sudo -u postgres psql -d veetracer -c 'CREATE EXTENSION IF NOT EXISTS btree_gist;'
-- after which the statement below is a no-op. Without that step this migration fails (and is rolled back) on
-- production: it is deliberately not wrapped in a conditional block (15 §8.2: no environment-dependent integrity rules).
--
-- Rollback (15 §9.4): switching ETMS off leaves ROUTE behaviour unchanged. The EXCLUDE constraints can be dropped by a
-- forward migration if they misbehave (non-destructive). SET NOT NULL on routeId is only possible after every
-- origin = 'ETMS' row is deleted (destructive, owner approval); once an ETMS trip exists, application code older than
-- WP 3.1 must not run against the database (it assumes a non-null routeId).
--
-- E3 security fix (amended before shipping; security review M1 / M2 / M5, H1): PlannedTripStop.profileId (the passenger
-- whose personal point the stop is) and PlannedTripStop.poiId (the company place of a site stop), both nullable UUIDs
-- with no FK (the v1.8 table stays independent of ETMS; checked by the app). Adding nullable columns without a default
-- is metadata only. The profileId index (consent withdrawal and erasure look stops up by passenger) is built over the
-- existing rows (all NULL) under a SHARE lock on PlannedTripStop: writes to stops wait for the build (seconds at the
-- production row count); deploy in the same quiet window as the PlannedTrip changes above.
--
-- Failure mode (E3 security review L10): a failed run (e.g. btree_gist missing) is rolled back as one implicit
-- transaction, but Prisma records it as failed in _prisma_migrations and blocks later deploys until
--   npx prisma migrate resolve --rolled-back 20261116090100_planned_trip_origin
-- is run; then install btree_gist and deploy again.

-- AlterTable
ALTER TABLE "PlannedTrip" ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'ROUTE',
ALTER COLUMN "routeId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "PlannedTripStop" ADD COLUMN     "poiId" UUID,
ADD COLUMN     "profileId" UUID;

-- CreateIndex
CREATE INDEX "PlannedTrip_driverId_plannedStart_idx" ON "PlannedTrip"("driverId", "plannedStart");

-- CreateIndex
CREATE INDEX "PlannedTripStop_profileId_idx" ON "PlannedTripStop"("profileId");

-- ───────────────────────────── Raw SQL ─────────────────────────────

ALTER TABLE "PlannedTrip" ADD CONSTRAINT "PlannedTrip_origin_check" CHECK ("origin" IN ('ROUTE','ETMS'));
-- Every ROUTE trip keeps its route; only ETMS runs (door-to-door, no master Route) may have none.
ALTER TABLE "PlannedTrip" ADD CONSTRAINT "PlannedTrip_route_origin_check" CHECK ("origin" = 'ETMS' OR "routeId" IS NOT NULL);

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- No vehicle double assignment among active ETMS trips (→ 409 VEHICLE_BUSY from the service before this fires).
ALTER TABLE "PlannedTrip" ADD CONSTRAINT "PlannedTrip_etms_vehicle_overlap_excl"
  EXCLUDE USING gist ("objectId" WITH =, tstzrange("plannedStart", "plannedEnd", '[)') WITH &&)
  WHERE ("origin" = 'ETMS' AND "status" IN ('SCHEDULED','STARTED','IN_PROGRESS'));

-- No driver double assignment among active ETMS trips (→ 409 DRIVER_BUSY).
ALTER TABLE "PlannedTrip" ADD CONSTRAINT "PlannedTrip_etms_driver_overlap_excl"
  EXCLUDE USING gist ("driverId" WITH =, tstzrange("plannedStart", "plannedEnd", '[)') WITH &&)
  WHERE ("origin" = 'ETMS' AND "driverId" IS NOT NULL AND "status" IN ('SCHEDULED','STARTED','IN_PROGRESS'));
