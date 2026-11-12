-- ETMS E1b WP 1b.0: TransportFleetAllocation (docs/employee-transport/15 §10, 12 §6 E1b). Additive only: one new table,
-- no change to an existing table or row, no data. Merge-gated for Lead review.
-- * A provider vehicle (TrackedObject) and / or driver set aside for one customer under a TransportServiceAgreement.
-- * Decisions taken in this x.0 (15 §10 "key points"):
--   - CHECK at least one of vehicle / driver (_target_check); validity (_validity_check).
--   - Overlap exclusion is per AGREEMENT, not per vehicle: the same vehicle may serve customer A in the morning and
--     customer B in the afternoon (11 §3.2 case 2 presumes exactly that), but it cannot be allocated twice to the same
--     agreement for overlapping periods (_vehicle_overlap_excl / _driver_overlap_excl, GiST with btree_gist).
--   - btree_gist: already required and installed by 20261116090100_planned_trip_origin (O16). The statement below is a
--     no-op where it exists; production has it since v1.11.0.
--   - L5 not decided: TransportTrip.customerCompanyId stays SetNull (no flip to Restrict here).
--   - Super Admin reason header: AuditAction.ACCESS (exists since etms_accounts); no separate SensitiveAccessLog table
--     (L7 default: none unless the owner asks).
-- * Purge (15 §1.2): no column named companyId. providerCompanyId FK RESTRICT (walked: a provider purge deletes its
--   allocations); customerCompanyId FK SET NULL (skipped by the planner; the agreement FK CASCADE removes the row when
--   the agreement is purged with either party). objectId has an FK (CASCADE), so the TrackedObject logical key does not
--   apply; driverId FK CASCADE. No CHECK involves the SET NULL column (15 §1.3).
-- * Locks / duration: CREATE TABLE + indexes on an empty table; FKs take SHARE ROW EXCLUSIVE on Company /
--   TrackedObject / Driver / TransportServiceAgreement for milliseconds (no validation scan: the new table is empty).
--
-- Rollback (forward-only repo, 15 §9.4): switch off (ETMS / company add-ons); the table stays unused. A full revert needs
-- owner authorisation and is a forward migration: DROP TABLE "TransportFleetAllocation";

-- CreateTable
CREATE TABLE "TransportFleetAllocation" (
    "id" UUID NOT NULL,
    "agreementId" UUID NOT NULL,
    "providerCompanyId" UUID NOT NULL,
    "customerCompanyId" UUID,
    "objectId" UUID,
    "driverId" UUID,
    "validFrom" TIMESTAMPTZ(3) NOT NULL,
    "validTo" TIMESTAMPTZ(3),
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TransportFleetAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TransportFleetAllocation_agreementId_validFrom_idx" ON "TransportFleetAllocation"("agreementId", "validFrom");

-- CreateIndex
CREATE INDEX "TransportFleetAllocation_providerCompanyId_validFrom_idx" ON "TransportFleetAllocation"("providerCompanyId", "validFrom");

-- CreateIndex
CREATE INDEX "TransportFleetAllocation_customerCompanyId_idx" ON "TransportFleetAllocation"("customerCompanyId");

-- CreateIndex
CREATE INDEX "TransportFleetAllocation_objectId_idx" ON "TransportFleetAllocation"("objectId");

-- CreateIndex
CREATE INDEX "TransportFleetAllocation_driverId_idx" ON "TransportFleetAllocation"("driverId");

-- AddForeignKey
ALTER TABLE "TransportFleetAllocation" ADD CONSTRAINT "TransportFleetAllocation_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "TransportServiceAgreement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportFleetAllocation" ADD CONSTRAINT "TransportFleetAllocation_providerCompanyId_fkey" FOREIGN KEY ("providerCompanyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportFleetAllocation" ADD CONSTRAINT "TransportFleetAllocation_customerCompanyId_fkey" FOREIGN KEY ("customerCompanyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportFleetAllocation" ADD CONSTRAINT "TransportFleetAllocation_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportFleetAllocation" ADD CONSTRAINT "TransportFleetAllocation_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ───────────────────────────── Raw SQL (documented on the model) ─────────────────────────────

-- An allocation names a vehicle, a driver, or both.
ALTER TABLE "TransportFleetAllocation" ADD CONSTRAINT "TransportFleetAllocation_target_check" CHECK ("objectId" IS NOT NULL OR "driverId" IS NOT NULL);
ALTER TABLE "TransportFleetAllocation" ADD CONSTRAINT "TransportFleetAllocation_validity_check" CHECK ("validTo" IS NULL OR "validTo" > "validFrom");

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- No double allocation of one vehicle / driver under the same agreement for overlapping periods (→ 409 from the service
-- before this fires). NULL objectId / driverId never conflict (NULL = NULL is not true).
ALTER TABLE "TransportFleetAllocation" ADD CONSTRAINT "TransportFleetAllocation_vehicle_overlap_excl"
  EXCLUDE USING gist ("agreementId" WITH =, "objectId" WITH =, tstzrange("validFrom", COALESCE("validTo", 'infinity'::timestamptz), '[)') WITH &&)
  WHERE ("objectId" IS NOT NULL);
ALTER TABLE "TransportFleetAllocation" ADD CONSTRAINT "TransportFleetAllocation_driver_overlap_excl"
  EXCLUDE USING gist ("agreementId" WITH =, "driverId" WITH =, tstzrange("validFrom", COALESCE("validTo", 'infinity'::timestamptz), '[)') WITH &&)
  WHERE ("driverId" IS NOT NULL);
