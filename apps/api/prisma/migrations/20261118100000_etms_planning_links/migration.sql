-- ETMS E4 WP 4.0 (doc 12 §7, doc 15 §8.4 / §10, doc 17 §2.6 / §7 P6): link routing plans to ETMS. Additive only: new
-- nullable columns on the E4 tables, and two nullable FK columns on "TransportTrip" (the only existing table touched).
-- * RoutePlan: direction, shiftId (TransportShift, SetNull), sitePoiId (Poi, SetNull): the scope a plan was built for.
-- * RoutePlanStop: stopKind (PICKUP | DROP), customerCompanyId (Company, CASCADE), bookingId (TransportBooking, SetNull),
--   profileId (EmployeeTransportProfile, CASCADE), poiId (Poi, SetNull), snapped point (snappedLat / snappedLng /
--   snapDistanceM / snapGraphVersion; doc 02 §7.2 original and snapped stored separately). Unique (planId, bookingId,
--   stopKind): one pickup and one drop per booking per plan.
-- * TransportTrip: routePlanId (RoutePlan, SetNull) and routeAssignmentId (RouteAssignment, SetNull, UNIQUE: one
--   assignment → one trip, idempotent re-publish). A plan purge leaves executed trip headers intact.
-- * No FK from PlannedTrip to any plan table (v1.8 untouched); the link lives on TransportTrip. Publish (doc 15 §8.4)
--   creates per assignment one PlannedTrip (origin ETMS) + PlannedTripStop rows (with profileId / poiId as E3 does) +
--   one TransportTrip, inside the existing publish transaction; TransportTripPassenger keeps its bookingId.
--
-- R2 ownership decisions (doc 17 §2.6), the doc's recommended defaults, adopted here (owner review at the P6 merge gate):
-- * Q-a passenger data on plan stops (D1): the plan is operator-owned (companyId = operator); a passenger stop carries
--   customerCompanyId (FK Company CASCADE: a customer purge removes its passengers from operator plans) and bookingId?
--   (FK TransportBooking SET NULL).
-- * Q-b driver identity (D5): RouteAssignment.driverId FK Driver; no assigneeUserId (routing_engine_v2).
-- * Q-c vehicle purge vs plan history: RouteAssignment.objectId / driverId FK SET NULL, history kept (routing_engine_v2).
-- * Q-d menu key: an ETMS planning key ('etms_planning', shared ETMS_PLANNING_MENU) under company feature etms; no
--   route_plans key, no Manager preset in SYSTEM_ROLES (no schema object; recorded here for completeness).
--
-- Personal points (doc 02 §7, doc 10 §4; snapshot policy):
-- * A plan stop is a passenger's personal point iff profileId IS NOT NULL (then poiId IS NULL, CHECK). Its lat / lng are
--   a snapshot copied at plan build from the booking's pickup / drop point, which exists only with the passenger's
--   routing consent (the generator creates no personal point without it). Never copied from
--   EmployeeTransportProfile.homeLat / homeLng directly, never stored in RoutingJob.input or RoutePlanVersion.snapshot.
-- * Erasure / consent withdrawal (apps/api/src/etms/dispatch/routing-plan-privacy.ts) coarsen or remove those stops,
--   clear their names, snapped points and the road geometry of their assignments, and scrub finished job results.
-- * Snapped coordinates on EmployeeTransportProfile / TransportBooking (doc 15 §10 E4 line) are NOT added here: they
--   would be non-FK columns on existing tables (outside this migration's brief); plan stops carry the snapped point.
--
-- ROLLBACK: switch ETMS_ROUTING off (default) or redeploy the previous tag; the previous code never reads these
-- columns. Manual revert (owner decision only):
--   ALTER TABLE "TransportTrip" DROP COLUMN "routeAssignmentId", DROP COLUMN "routePlanId";
--   ALTER TABLE "RoutePlanStop" DROP COLUMN "stopKind", DROP COLUMN "customerCompanyId", DROP COLUMN "bookingId",
--     DROP COLUMN "profileId", DROP COLUMN "poiId", DROP COLUMN "snappedLat", DROP COLUMN "snappedLng",
--     DROP COLUMN "snapDistanceM", DROP COLUMN "snapGraphVersion";
--   ALTER TABLE "RoutePlan" DROP COLUMN "direction", DROP COLUMN "shiftId", DROP COLUMN "sitePoiId";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261118100000_etms_planning_links';
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "RoutePlan" ADD COLUMN     "direction" "TransportDirection",
ADD COLUMN     "shiftId" UUID,
ADD COLUMN     "sitePoiId" UUID;

-- AlterTable
ALTER TABLE "RoutePlanStop" ADD COLUMN     "bookingId" UUID,
ADD COLUMN     "customerCompanyId" UUID,
ADD COLUMN     "poiId" UUID,
ADD COLUMN     "profileId" UUID,
ADD COLUMN     "snapDistanceM" INTEGER,
ADD COLUMN     "snapGraphVersion" TEXT,
ADD COLUMN     "snappedLat" DOUBLE PRECISION,
ADD COLUMN     "snappedLng" DOUBLE PRECISION,
ADD COLUMN     "stopKind" TEXT;

-- AlterTable
ALTER TABLE "TransportTrip" ADD COLUMN     "routeAssignmentId" UUID,
ADD COLUMN     "routePlanId" UUID;

-- CreateIndex
CREATE INDEX "RoutePlanStop_bookingId_idx" ON "RoutePlanStop"("bookingId");

-- CreateIndex
CREATE INDEX "RoutePlanStop_profileId_idx" ON "RoutePlanStop"("profileId");

-- CreateIndex
CREATE INDEX "RoutePlanStop_customerCompanyId_idx" ON "RoutePlanStop"("customerCompanyId");

-- CreateIndex
CREATE INDEX "RoutePlanStop_poiId_idx" ON "RoutePlanStop"("poiId");

-- CreateIndex
CREATE UNIQUE INDEX "RoutePlanStop_planId_bookingId_stopKind_key" ON "RoutePlanStop"("planId", "bookingId", "stopKind");

-- CreateIndex
CREATE UNIQUE INDEX "TransportTrip_routeAssignmentId_key" ON "TransportTrip"("routeAssignmentId");

-- CreateIndex
CREATE INDEX "TransportTrip_routePlanId_idx" ON "TransportTrip"("routePlanId");

-- AddForeignKey
ALTER TABLE "TransportTrip" ADD CONSTRAINT "TransportTrip_routePlanId_fkey" FOREIGN KEY ("routePlanId") REFERENCES "RoutePlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportTrip" ADD CONSTRAINT "TransportTrip_routeAssignmentId_fkey" FOREIGN KEY ("routeAssignmentId") REFERENCES "RouteAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutePlan" ADD CONSTRAINT "RoutePlan_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "TransportShift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutePlan" ADD CONSTRAINT "RoutePlan_sitePoiId_fkey" FOREIGN KEY ("sitePoiId") REFERENCES "Poi"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutePlanStop" ADD CONSTRAINT "RoutePlanStop_customerCompanyId_fkey" FOREIGN KEY ("customerCompanyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutePlanStop" ADD CONSTRAINT "RoutePlanStop_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "TransportBooking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutePlanStop" ADD CONSTRAINT "RoutePlanStop_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "EmployeeTransportProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutePlanStop" ADD CONSTRAINT "RoutePlanStop_poiId_fkey" FOREIGN KEY ("poiId") REFERENCES "Poi"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Raw SQL (documented on the models). Every CHECK only gets weaker when an FK sets a column to NULL (bookingId, poiId),
-- and customerCompanyId / profileId are CASCADE (the row goes, it is never nulled), so no purge can violate them
-- (doc 15 §1.3). Deliberately not a CHECK: "routeAssignmentId ⇒ routePlanId" on TransportTrip (a plan purge nulls
-- routePlanId before the assignment cascade nulls routeAssignmentId).
ALTER TABLE "RoutePlanStop" ADD CONSTRAINT "RoutePlanStop_kind_check" CHECK ("stopKind" IS NULL OR "stopKind" IN ('PICKUP', 'DROP'));
ALTER TABLE "RoutePlanStop" ADD CONSTRAINT "RoutePlanStop_personal_check" CHECK ("profileId" IS NULL OR "poiId" IS NULL);
ALTER TABLE "RoutePlanStop" ADD CONSTRAINT "RoutePlanStop_customer_check" CHECK (("bookingId" IS NULL AND "profileId" IS NULL) OR "customerCompanyId" IS NOT NULL);
ALTER TABLE "RoutePlanStop" ADD CONSTRAINT "RoutePlanStop_booking_kind_check" CHECK ("bookingId" IS NULL OR "stopKind" IS NOT NULL);
ALTER TABLE "RoutePlanStop" ADD CONSTRAINT "RoutePlanStop_snapped_check" CHECK (
  ("snappedLat" IS NULL) = ("snappedLng" IS NULL) AND ("snapDistanceM" IS NULL OR "snapDistanceM" >= 0)
  AND ("snappedLat" IS NULL OR ("snappedLat" BETWEEN -90 AND 90 AND "snappedLng" BETWEEN -180 AND 180)));
