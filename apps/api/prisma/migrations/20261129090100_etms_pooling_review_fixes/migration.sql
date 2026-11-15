-- ETMS pooling review fix 4 (backfill guard). 20261129090000 set every existing POINT_TO_POINT booking PRIVATE (P3).
-- Under E3 a dispatcher could already seat several P2P passengers on one trip; those legacy rows are pooled in fact,
-- so they become FLEXIBLE (served either way, doc 20 §3.1) — PRIVATE stays only for P2P rows that are unseated or seated
-- alone (their party alone) on their trip. Only legacy rows are touched: no limits snapshot (pooling-era bookings always
-- have one, and the TransportBooking_limits_immutable trigger only guards rows with a snapshot). The API additionally
-- treats a PRIVATE row without a snapshot as FLEXIBLE for the P1 exclusivity check (publish-checks.ts effectivePreference),
-- so a trip carrying legacy rows stays editable whatever this statement found. Idempotent.
UPDATE "TransportBooking" b SET "ridePreference" = 'FLEXIBLE'
WHERE b."journey" = 'POINT_TO_POINT' AND b."ridePreference" = 'PRIVATE' AND b."limits" IS NULL
  AND EXISTS (
    SELECT 1 FROM "TransportTripPassenger" mine
    JOIN "TransportTripPassenger" other ON other."tripId" = mine."tripId" AND other."status" <> 'CANCELLED' AND other."bookingId" <> mine."bookingId"
    JOIN "TransportBooking" ob ON ob.id = other."bookingId"
    WHERE mine."bookingId" = b.id AND mine."status" <> 'CANCELLED'
      AND (b."groupId" IS NULL OR ob."groupId" IS DISTINCT FROM b."groupId")
  );
