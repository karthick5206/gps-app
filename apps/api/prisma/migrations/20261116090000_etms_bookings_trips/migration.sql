-- ETMS E3 WP 3.0: schedules, bookings, trips (docs/employee-transport/15 §5, §6, §8; 12 §5; 02 §5). Additive only.
-- * Seven enums and eight tables: TransportShift, TransportSchedule, TransportScheduleException (customer-owned),
--   TransportBooking, TransportTrip, TransportTripPassenger, TransportTripEvent (dual-keyed customer / provider; in R1
--   provider = customer, corporate-managed), TransportChangeSet (operator-owned idempotency ledger + drafts).
-- * Raw SQL below the Prisma part: CHECKs (each checked against the purge matrix, doc 15 §1.3: none involves a column
--   an FK sets to NULL), the partial unique indexes against double booking / double seating, and the CHECK that makes
--   vehicle GPS unable to prove boarding (outcomeSource limited to WEB / DRIVER_APP for BOARDED, NO_SHOW, DROPPED).
-- * Composite FKs list the row-id column first (doc 15 §1.2: the purge planner reads only the first column).
-- * No data, no backfill. All tables are new and empty: FKs take only a brief SHARE ROW EXCLUSIVE on Company, Poi,
--   EmployeeTransportProfile, TransportServiceAgreement, PlannedTrip, PlannedTripStop.
-- * PlannedTrip itself is changed by the next migration (planned_trip_origin), shipped in the same PR as the
--   routeId-null tolerance code (doc 15 §7.1, §12 C-1).
--
-- Rollback (forward-only repo, doc 15 §9.4): switch off (ETMS=off, company add-on `etms`, ETMS_BOOKING_JOB=off): no
-- bookings are generated and nothing is published. Forward-fix: add an index, adjust a CHECK set. A full revert needs
-- owner authorisation (destructive once rows exist): drop the eight tables, then the seven enums.
--
-- Purge (doc 15 §6): company purge → shifts, bookings, trips, passengers, events, change sets via their Restrict FKs to
-- Company (walked, children first); schedules / exceptions via composite FKs and the companyId logical key (no FK on
-- that column). Provider purge (E1b) → booking.providerCompanyId / agreementId SET NULL (booking survives). Customer
-- purge (E1b) → TransportTrip.customerCompanyId SET NULL (header kept anonymised, L5 default), passenger rows deleted
-- through the booking walk, trip-level events kept with customerCompanyId NULL. Vehicle purge → PlannedTrip and its
-- stops deleted (logical key objectId) → TransportTrip.plannedTripId and passenger stop FKs SET NULL, seqs kept.

-- CreateEnum
CREATE TYPE "TransportDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "TransportPickupMode" AS ENUM ('HOME', 'STOP');

-- CreateEnum
CREATE TYPE "TransportExceptionKind" AS ENUM ('SKIP', 'OVERRIDE');

-- CreateEnum
CREATE TYPE "TransportBookingSource" AS ENUM ('ADHOC', 'SCHEDULE');

-- CreateEnum
CREATE TYPE "TransportBookingStatus" AS ENUM ('REQUESTED', 'PENDING_ASSIGNMENT', 'ASSIGNED', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'WAITLISTED', 'FAILED');

-- CreateEnum
CREATE TYPE "TransportPassengerStatus" AS ENUM ('PENDING', 'BOARDED', 'NO_SHOW', 'DROPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TransportChangeSetStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'REJECTED');

-- CreateTable
CREATE TABLE "TransportShift" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "sitePoiId" UUID,
    "name" TEXT NOT NULL,
    "startMin" INTEGER NOT NULL,
    "endMin" INTEGER NOT NULL,
    "overnight" BOOLEAN NOT NULL,
    "days" INTEGER[],
    "timeZone" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TransportShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportSchedule" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "shiftId" UUID NOT NULL,
    "direction" "TransportDirection" NOT NULL,
    "days" INTEGER[],
    "pickupMode" "TransportPickupMode" NOT NULL,
    "stopPoiId" UUID,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TransportSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportScheduleException" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "scheduleId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "kind" "TransportExceptionKind" NOT NULL,
    "override" JSONB,
    "reason" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransportScheduleException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportBooking" (
    "id" UUID NOT NULL,
    "customerCompanyId" UUID NOT NULL,
    "providerCompanyId" UUID,
    "agreementId" UUID,
    "profileId" UUID NOT NULL,
    "scheduleId" UUID,
    "shiftId" UUID,
    "source" "TransportBookingSource" NOT NULL,
    "serviceDate" DATE NOT NULL,
    "direction" "TransportDirection" NOT NULL,
    "timeZone" TEXT NOT NULL,
    "pickupLabel" TEXT,
    "dropLabel" TEXT,
    "pickupLat" DOUBLE PRECISION,
    "pickupLng" DOUBLE PRECISION,
    "dropLat" DOUBLE PRECISION,
    "dropLng" DOUBLE PRECISION,
    "pickupPoiId" UUID,
    "dropPoiId" UUID,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "windowEnd" TIMESTAMPTZ(3) NOT NULL,
    "passengerCount" INTEGER NOT NULL DEFAULT 1,
    "status" "TransportBookingStatus" NOT NULL DEFAULT 'REQUESTED',
    "statusReason" TEXT,
    "cutoffAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT,
    "idempotencyHash" TEXT,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TransportBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportTrip" (
    "id" UUID NOT NULL,
    "plannedTripId" UUID,
    "providerCompanyId" UUID NOT NULL,
    "customerCompanyId" UUID,
    "agreementId" UUID,
    "serviceDate" DATE NOT NULL,
    "direction" "TransportDirection" NOT NULL,
    "shiftId" UUID,
    "sitePoiId" UUID,
    "seatCapacity" INTEGER NOT NULL,
    "occupiedSeats" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" TIMESTAMPTZ(3),
    "acknowledgedAt" TIMESTAMPTZ(3),
    "acknowledgedByUserId" UUID,
    "acknowledgedSource" TEXT,
    "interruptedAt" TIMESTAMPTZ(3),
    "interruptReason" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TransportTrip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportTripPassenger" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "customerCompanyId" UUID NOT NULL,
    "providerCompanyId" UUID NOT NULL,
    "pickupStopId" UUID,
    "dropStopId" UUID,
    "pickupSeq" INTEGER NOT NULL,
    "dropSeq" INTEGER NOT NULL,
    "seats" INTEGER NOT NULL DEFAULT 1,
    "status" "TransportPassengerStatus" NOT NULL DEFAULT 'PENDING',
    "boardedAt" TIMESTAMPTZ(3),
    "droppedAt" TIMESTAMPTZ(3),
    "noShowAt" TIMESTAMPTZ(3),
    "noShowReason" TEXT,
    "cancelReason" TEXT,
    "outcomeSource" TEXT,
    "outcomeByUserId" UUID,
    "outcomeAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TransportTripPassenger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportTripEvent" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "providerCompanyId" UUID NOT NULL,
    "customerCompanyId" UUID,
    "passengerTripId" UUID,
    "kind" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorUserId" UUID,
    "actorDriverId" UUID,
    "source" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'ACCEPTED',
    "clientEventId" UUID,
    "clientSeq" INTEGER,
    "stopSeq" INTEGER,
    "reasonCode" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "data" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "TransportTripEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportChangeSet" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "status" "TransportChangeSetStatus" NOT NULL,
    "serviceDate" DATE NOT NULL,
    "direction" "TransportDirection" NOT NULL,
    "draft" JSONB,
    "result" JSONB,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "TransportChangeSet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TransportShift_companyId_isActive_idx" ON "TransportShift"("companyId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "TransportShift_companyId_name_key" ON "TransportShift"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TransportShift_id_companyId_key" ON "TransportShift"("id", "companyId");

-- CreateIndex
CREATE INDEX "TransportSchedule_companyId_isActive_idx" ON "TransportSchedule"("companyId", "isActive");

-- CreateIndex
CREATE INDEX "TransportSchedule_profileId_idx" ON "TransportSchedule"("profileId");

-- CreateIndex
CREATE INDEX "TransportSchedule_shiftId_idx" ON "TransportSchedule"("shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "TransportSchedule_id_companyId_key" ON "TransportSchedule"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "TransportScheduleException_scheduleId_date_key" ON "TransportScheduleException"("scheduleId", "date");

-- CreateIndex
CREATE INDEX "TransportBooking_customerCompanyId_serviceDate_status_idx" ON "TransportBooking"("customerCompanyId", "serviceDate", "status");

-- CreateIndex
CREATE INDEX "TransportBooking_providerCompanyId_serviceDate_idx" ON "TransportBooking"("providerCompanyId", "serviceDate");

-- CreateIndex
CREATE INDEX "TransportBooking_profileId_serviceDate_idx" ON "TransportBooking"("profileId", "serviceDate");

-- CreateIndex
CREATE INDEX "TransportBooking_agreementId_idx" ON "TransportBooking"("agreementId");

-- CreateIndex
CREATE UNIQUE INDEX "TransportBooking_customerCompanyId_idempotencyKey_key" ON "TransportBooking"("customerCompanyId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "TransportBooking_scheduleId_serviceDate_direction_key" ON "TransportBooking"("scheduleId", "serviceDate", "direction");

-- CreateIndex
CREATE UNIQUE INDEX "TransportBooking_id_customerCompanyId_key" ON "TransportBooking"("id", "customerCompanyId");

-- CreateIndex
CREATE UNIQUE INDEX "TransportTrip_plannedTripId_key" ON "TransportTrip"("plannedTripId");

-- CreateIndex
CREATE INDEX "TransportTrip_providerCompanyId_serviceDate_idx" ON "TransportTrip"("providerCompanyId", "serviceDate");

-- CreateIndex
CREATE INDEX "TransportTrip_customerCompanyId_serviceDate_idx" ON "TransportTrip"("customerCompanyId", "serviceDate");

-- CreateIndex
CREATE INDEX "TransportTrip_agreementId_idx" ON "TransportTrip"("agreementId");

-- CreateIndex
CREATE UNIQUE INDEX "TransportTrip_id_providerCompanyId_key" ON "TransportTrip"("id", "providerCompanyId");

-- CreateIndex
CREATE INDEX "TransportTripPassenger_tripId_status_idx" ON "TransportTripPassenger"("tripId", "status");

-- CreateIndex
CREATE INDEX "TransportTripPassenger_bookingId_idx" ON "TransportTripPassenger"("bookingId");

-- CreateIndex
CREATE INDEX "TransportTripPassenger_customerCompanyId_createdAt_idx" ON "TransportTripPassenger"("customerCompanyId", "createdAt");

-- CreateIndex
CREATE INDEX "TransportTripEvent_tripId_occurredAt_idx" ON "TransportTripEvent"("tripId", "occurredAt");

-- CreateIndex
CREATE INDEX "TransportTripEvent_providerCompanyId_receivedAt_idx" ON "TransportTripEvent"("providerCompanyId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TransportTripEvent_tripId_clientEventId_key" ON "TransportTripEvent"("tripId", "clientEventId");

-- CreateIndex
CREATE INDEX "TransportChangeSet_companyId_serviceDate_status_idx" ON "TransportChangeSet"("companyId", "serviceDate", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TransportChangeSet_companyId_idempotencyKey_key" ON "TransportChangeSet"("companyId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "TransportShift" ADD CONSTRAINT "TransportShift_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportShift" ADD CONSTRAINT "TransportShift_sitePoiId_fkey" FOREIGN KEY ("sitePoiId") REFERENCES "Poi"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportSchedule" ADD CONSTRAINT "TransportSchedule_profileId_companyId_fkey" FOREIGN KEY ("profileId", "companyId") REFERENCES "EmployeeTransportProfile"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportSchedule" ADD CONSTRAINT "TransportSchedule_shiftId_companyId_fkey" FOREIGN KEY ("shiftId", "companyId") REFERENCES "TransportShift"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportSchedule" ADD CONSTRAINT "TransportSchedule_stopPoiId_fkey" FOREIGN KEY ("stopPoiId") REFERENCES "Poi"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportScheduleException" ADD CONSTRAINT "TransportScheduleException_scheduleId_companyId_fkey" FOREIGN KEY ("scheduleId", "companyId") REFERENCES "TransportSchedule"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportBooking" ADD CONSTRAINT "TransportBooking_customerCompanyId_fkey" FOREIGN KEY ("customerCompanyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportBooking" ADD CONSTRAINT "TransportBooking_providerCompanyId_fkey" FOREIGN KEY ("providerCompanyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportBooking" ADD CONSTRAINT "TransportBooking_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "TransportServiceAgreement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportBooking" ADD CONSTRAINT "TransportBooking_profileId_customerCompanyId_fkey" FOREIGN KEY ("profileId", "customerCompanyId") REFERENCES "EmployeeTransportProfile"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportBooking" ADD CONSTRAINT "TransportBooking_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "TransportSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportBooking" ADD CONSTRAINT "TransportBooking_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "TransportShift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportBooking" ADD CONSTRAINT "TransportBooking_pickupPoiId_fkey" FOREIGN KEY ("pickupPoiId") REFERENCES "Poi"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportBooking" ADD CONSTRAINT "TransportBooking_dropPoiId_fkey" FOREIGN KEY ("dropPoiId") REFERENCES "Poi"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportTrip" ADD CONSTRAINT "TransportTrip_plannedTripId_fkey" FOREIGN KEY ("plannedTripId") REFERENCES "PlannedTrip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportTrip" ADD CONSTRAINT "TransportTrip_providerCompanyId_fkey" FOREIGN KEY ("providerCompanyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportTrip" ADD CONSTRAINT "TransportTrip_customerCompanyId_fkey" FOREIGN KEY ("customerCompanyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportTrip" ADD CONSTRAINT "TransportTrip_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "TransportServiceAgreement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportTrip" ADD CONSTRAINT "TransportTrip_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "TransportShift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportTrip" ADD CONSTRAINT "TransportTrip_sitePoiId_fkey" FOREIGN KEY ("sitePoiId") REFERENCES "Poi"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportTripPassenger" ADD CONSTRAINT "TransportTripPassenger_tripId_providerCompanyId_fkey" FOREIGN KEY ("tripId", "providerCompanyId") REFERENCES "TransportTrip"("id", "providerCompanyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportTripPassenger" ADD CONSTRAINT "TransportTripPassenger_bookingId_customerCompanyId_fkey" FOREIGN KEY ("bookingId", "customerCompanyId") REFERENCES "TransportBooking"("id", "customerCompanyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportTripPassenger" ADD CONSTRAINT "TransportTripPassenger_customerCompanyId_fkey" FOREIGN KEY ("customerCompanyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportTripPassenger" ADD CONSTRAINT "TransportTripPassenger_providerCompanyId_fkey" FOREIGN KEY ("providerCompanyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportTripPassenger" ADD CONSTRAINT "TransportTripPassenger_pickupStopId_fkey" FOREIGN KEY ("pickupStopId") REFERENCES "PlannedTripStop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportTripPassenger" ADD CONSTRAINT "TransportTripPassenger_dropStopId_fkey" FOREIGN KEY ("dropStopId") REFERENCES "PlannedTripStop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportTripEvent" ADD CONSTRAINT "TransportTripEvent_tripId_providerCompanyId_fkey" FOREIGN KEY ("tripId", "providerCompanyId") REFERENCES "TransportTrip"("id", "providerCompanyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportTripEvent" ADD CONSTRAINT "TransportTripEvent_providerCompanyId_fkey" FOREIGN KEY ("providerCompanyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportTripEvent" ADD CONSTRAINT "TransportTripEvent_customerCompanyId_fkey" FOREIGN KEY ("customerCompanyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportTripEvent" ADD CONSTRAINT "TransportTripEvent_passengerTripId_fkey" FOREIGN KEY ("passengerTripId") REFERENCES "TransportTripPassenger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportChangeSet" ADD CONSTRAINT "TransportChangeSet_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────────────────────────── Raw SQL (doc 15 §5, §8.1) ─────────────────────────────

-- TransportShift (§5.1). Prisma creates scalar lists (days) as nullable columns: the days CHECKs refuse NULL explicitly.
ALTER TABLE "TransportShift" ADD CONSTRAINT "TransportShift_minutes_check"
  CHECK ("startMin" BETWEEN 0 AND 1439 AND "endMin" BETWEEN 0 AND 1439 AND "startMin" <> "endMin");
ALTER TABLE "TransportShift" ADD CONSTRAINT "TransportShift_overnight_check" CHECK ("overnight" = ("endMin" < "startMin"));
ALTER TABLE "TransportShift" ADD CONSTRAINT "TransportShift_days_check"
  CHECK ("days" IS NOT NULL AND cardinality("days") > 0 AND "days" <@ ARRAY[0,1,2,3,4,5,6]);

-- TransportSchedule (§5.2). STOP ⇒ stopPoiId is a service rule, not a CHECK (SetNull FK, §1.3).
ALTER TABLE "TransportSchedule" ADD CONSTRAINT "TransportSchedule_validity_check" CHECK ("validTo" IS NULL OR "validTo" >= "validFrom");
ALTER TABLE "TransportSchedule" ADD CONSTRAINT "TransportSchedule_days_check"
  CHECK ("days" IS NOT NULL AND cardinality("days") > 0 AND "days" <@ ARRAY[0,1,2,3,4,5,6]);
ALTER TABLE "TransportSchedule" ADD CONSTRAINT "TransportSchedule_version_check" CHECK ("version" >= 1);

-- TransportScheduleException (§5.3)
ALTER TABLE "TransportScheduleException" ADD CONSTRAINT "TransportScheduleException_override_check"
  CHECK (("kind" = 'OVERRIDE') = ("override" IS NOT NULL));

-- TransportBooking (§5.4). Not CHECKs (would abort purges, §1.3): "assigned ⇒ provider set", "SCHEDULE ⇒ scheduleId set".
ALTER TABLE "TransportBooking" ADD CONSTRAINT "TransportBooking_window_check" CHECK ("windowEnd" > "windowStart");
ALTER TABLE "TransportBooking" ADD CONSTRAINT "TransportBooking_passenger_count_check" CHECK ("passengerCount" >= 1);
ALTER TABLE "TransportBooking" ADD CONSTRAINT "TransportBooking_version_check" CHECK ("version" >= 1);
ALTER TABLE "TransportBooking" ADD CONSTRAINT "TransportBooking_point_pairs_check"
  CHECK (("pickupLat" IS NULL) = ("pickupLng" IS NULL) AND ("dropLat" IS NULL) = ("dropLng" IS NULL));
ALTER TABLE "TransportBooking" ADD CONSTRAINT "TransportBooking_assigned_points_check"
  CHECK ("status" NOT IN ('ASSIGNED','CONFIRMED') OR ("pickupLat" IS NOT NULL AND "dropLat" IS NOT NULL));
ALTER TABLE "TransportBooking" ADD CONSTRAINT "TransportBooking_source_check" CHECK ("source" = 'SCHEDULE' OR "scheduleId" IS NULL);
-- No double booking: one active booking per passenger, service date and direction (→ 409 BOOKING_DUPLICATE).
CREATE UNIQUE INDEX "TransportBooking_active_passenger_day_key" ON "TransportBooking" ("profileId", "serviceDate", "direction")
  WHERE "status" NOT IN ('CANCELLED','REJECTED','EXPIRED','FAILED');

-- TransportTrip (§5.5, §8.3 capacity backstop). Not a CHECK: "no agreement ⇒ provider = customer" (§1.3).
ALTER TABLE "TransportTrip" ADD CONSTRAINT "TransportTrip_seat_capacity_check" CHECK ("seatCapacity" >= 1);
ALTER TABLE "TransportTrip" ADD CONSTRAINT "TransportTrip_occupied_seats_check" CHECK ("occupiedSeats" >= 0 AND "occupiedSeats" <= "seatCapacity");
ALTER TABLE "TransportTrip" ADD CONSTRAINT "TransportTrip_version_check" CHECK ("version" >= 1);
ALTER TABLE "TransportTrip" ADD CONSTRAINT "TransportTrip_acknowledged_check" CHECK ("acknowledgedAt" IS NULL OR "publishedAt" IS NOT NULL);

-- TransportTripPassenger (§5.6)
ALTER TABLE "TransportTripPassenger" ADD CONSTRAINT "TransportTripPassenger_seats_check" CHECK ("seats" >= 1);
ALTER TABLE "TransportTripPassenger" ADD CONSTRAINT "TransportTripPassenger_seq_check" CHECK ("pickupSeq" >= 0 AND "dropSeq" > "pickupSeq");
ALTER TABLE "TransportTripPassenger" ADD CONSTRAINT "TransportTripPassenger_boarded_check" CHECK ("status" <> 'BOARDED' OR "boardedAt" IS NOT NULL);
ALTER TABLE "TransportTripPassenger" ADD CONSTRAINT "TransportTripPassenger_dropped_check" CHECK ("status" <> 'DROPPED' OR "droppedAt" IS NOT NULL);
ALTER TABLE "TransportTripPassenger" ADD CONSTRAINT "TransportTripPassenger_no_show_check" CHECK ("status" <> 'NO_SHOW' OR "noShowAt" IS NOT NULL);
-- Vehicle GPS is never proof of boarding (02 §5.3, condition A): only the dispatcher (WEB) or the driver app (E5) may
-- record an outcome. The processor has no write path to this table; this CHECK makes a GPS / SYSTEM outcome impossible.
-- COALESCE: doc 15 §5.6 writes `"outcomeSource" IN (…)`, which a NULL source would pass (a CHECK accepts NULL); an
-- outcome without a source must be refused too (found by the E3 DB test).
ALTER TABLE "TransportTripPassenger" ADD CONSTRAINT "TransportTripPassenger_outcome_source_check"
  CHECK ("status" NOT IN ('BOARDED','DROPPED','NO_SHOW') OR COALESCE("outcomeSource", '') IN ('WEB','DRIVER_APP'));
-- One active seat per booking (moving a passenger = cancel the old row + insert a new one in one transaction).
CREATE UNIQUE INDEX "TransportTripPassenger_active_booking_key" ON "TransportTripPassenger" ("bookingId") WHERE "status" <> 'CANCELLED';

-- TransportTripEvent (§5.7)
ALTER TABLE "TransportTripEvent" ADD CONSTRAINT "TransportTripEvent_source_check" CHECK ("source" IN ('WEB','DRIVER_APP','PASSENGER_APP','SYSTEM'));
ALTER TABLE "TransportTripEvent" ADD CONSTRAINT "TransportTripEvent_outcome_check" CHECK ("outcome" IN ('ACCEPTED','DUPLICATE','REJECTED','LATE'));
ALTER TABLE "TransportTripEvent" ADD CONSTRAINT "TransportTripEvent_actor_check" CHECK ("actorType" IN ('DISPATCHER','DRIVER','PASSENGER','SYSTEM'));
ALTER TABLE "TransportTripEvent" ADD CONSTRAINT "TransportTripEvent_point_check" CHECK (("lat" IS NULL) = ("lng" IS NULL));

-- TransportChangeSet (§5.8)
ALTER TABLE "TransportChangeSet" ADD CONSTRAINT "TransportChangeSet_published_check"
  CHECK ("status" <> 'PUBLISHED' OR ("idempotencyKey" IS NOT NULL AND "publishedAt" IS NOT NULL));
