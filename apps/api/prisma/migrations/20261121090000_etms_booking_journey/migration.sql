-- ETMS E3 WP 3.9 (ad-hoc booking, owner decisions D-A1 / D-A2, 2026-11-12). Additive only.
-- * TransportBookingJourney: COMMUTE (one office end, as before; default for every existing row) or POINT_TO_POINT
--   (any pickup to any destination, no office end).
-- * TransportBooking.lateReason: a dispatcher's reason for a booking created / edited after its cut-off (D-A1).
-- * The "one active booking per passenger, date and direction" index now covers COMMUTE only; POINT_TO_POINT rows may
--   not overlap in time for the same passenger (GiST exclusion backstop; the service also checks overlap with COMMUTE).
-- * btree_gist: required and installed since 20261116090100_planned_trip_origin (no-op where it exists).
SET lock_timeout = '5s';

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE "TransportBookingJourney" AS ENUM ('COMMUTE', 'POINT_TO_POINT');

ALTER TABLE "TransportBooking"
  ADD COLUMN "journey" "TransportBookingJourney" NOT NULL DEFAULT 'COMMUTE',
  ADD COLUMN "lateReason" TEXT;

DROP INDEX "TransportBooking_active_passenger_day_key";
CREATE UNIQUE INDEX "TransportBooking_active_passenger_day_key" ON "TransportBooking" ("profileId", "serviceDate", "direction")
  WHERE "status" NOT IN ('CANCELLED','REJECTED','EXPIRED','FAILED') AND "journey" = 'COMMUTE';

ALTER TABLE "TransportBooking" ADD CONSTRAINT "TransportBooking_p2p_overlap_excl"
  EXCLUDE USING gist ("profileId" WITH =, tstzrange("windowStart", "windowEnd", '[)') WITH &&)
  WHERE ("journey" = 'POINT_TO_POINT' AND "status" NOT IN ('CANCELLED','REJECTED','EXPIRED','FAILED'));

-- WP 3.9 (D-A4, added by the adhoc-api agent): a BOOKING_CREATED inbox row points at its booking (push data
-- { kind, bookingId, notificationId }); the booking id is not personal data. SET NULL when the booking row goes.
ALTER TABLE "TransportNotification" ADD COLUMN "bookingId" UUID;
ALTER TABLE "TransportNotification" ADD CONSTRAINT "TransportNotification_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "TransportBooking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- The closed kind set gains BOOKING_CREATED (the service sets bookingId on BOOKING_CREATED rows only).
ALTER TABLE "TransportNotification" DROP CONSTRAINT "TransportNotification_kind_check";
ALTER TABLE "TransportNotification" ADD CONSTRAINT "TransportNotification_kind_check"
  CHECK ("kind" IN ('TRIP_ASSIGNED','TRIP_CHANGED','TRIP_UNASSIGNED','TRIP_CANCELLED','TRIP_STARTING_SOON','VEHICLE_APPROACHING','TRIP_DELAYED','BOOKING_CREATED'));
