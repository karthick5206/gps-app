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
