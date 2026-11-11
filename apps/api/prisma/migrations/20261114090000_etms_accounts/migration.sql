-- ETMS E1a: accounts foundation (docs/employee-transport/15 §3, 12 WP 1a.0). Additive only.
-- * TransportServiceAgreement + enums TransportAgreementStatus / TransportGrant / TransportDataProfile (D1, P1)
-- * AuditAction += ACCESS (not used in this migration; no backfill)
-- * NOT included: OutboxEvent / OutboxClass (delivered with D6 G2, ETMS-IMPLEMENTATION-STATUS decision log)
-- * No data: no agreements (R1 is corporate-managed), no RolePermission rows, no role templates (seeded by code when the
--   company add-on `etms` is switched on, WP 1a.2).
--
-- Rollback (forward-only repo, doc 15 §9.4): switch off (company add-on `etms` off; menus hidden, API refuses). A defect
-- is fixed by a new forward migration. A full revert needs owner authorisation and is a forward migration:
--   DROP TABLE "TransportServiceAgreement"; DROP TYPE "TransportAgreementStatus", "TransportGrant", "TransportDataProfile";
-- "AuditAction".ACCESS stays (PostgreSQL cannot drop an enum value; harmless while unused).
--
-- Purge: no "companyId" column (logical key not used); both company FKs are RESTRICT, so the purge planner walks them and
-- deletes the agreement when either party is purged, while ordinary application deletes of a party company are blocked.

-- CreateEnum
CREATE TYPE "TransportAgreementStatus" AS ENUM ('DRAFT', 'PROPOSED', 'ACTIVE', 'SUSPENDED', 'ENDED');

-- CreateEnum
CREATE TYPE "TransportGrant" AS ENUM ('VIEW_BOOKINGS', 'MANAGE_DISPATCH', 'VIEW_PASSENGER_MINIMAL', 'VIEW_PASSENGER_CONTACT', 'MANAGE_SCHEDULES', 'RECEIVE_INCIDENTS', 'MANAGE_INCIDENTS', 'VIEW_REPORTS', 'OVERRIDE_SAFETY_WARN');

-- CreateEnum
CREATE TYPE "TransportDataProfile" AS ENUM ('MINIMAL', 'STANDARD');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'ACCESS';

-- CreateTable
CREATE TABLE "TransportServiceAgreement" (
    "id" UUID NOT NULL,
    "providerCompanyId" UUID NOT NULL,
    "customerCompanyId" UUID NOT NULL,
    "status" "TransportAgreementStatus" NOT NULL DEFAULT 'DRAFT',
    "validFrom" TIMESTAMPTZ(3) NOT NULL,
    "validTo" TIMESTAMPTZ(3),
    "grants" "TransportGrant"[] DEFAULT ARRAY[]::"TransportGrant"[],
    "siteIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "dataProfile" "TransportDataProfile" NOT NULL DEFAULT 'MINIMAL',
    "approvedByCustomerAt" TIMESTAMPTZ(3),
    "approvedByCustomerUserId" UUID,
    "approvedByProviderAt" TIMESTAMPTZ(3),
    "approvedByProviderUserId" UUID,
    "suspendedAt" TIMESTAMPTZ(3),
    "endedAt" TIMESTAMPTZ(3),
    "statusReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TransportServiceAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TransportServiceAgreement_providerCompanyId_status_idx" ON "TransportServiceAgreement"("providerCompanyId", "status");

-- CreateIndex
CREATE INDEX "TransportServiceAgreement_customerCompanyId_status_idx" ON "TransportServiceAgreement"("customerCompanyId", "status");

-- AddForeignKey
ALTER TABLE "TransportServiceAgreement" ADD CONSTRAINT "TransportServiceAgreement_providerCompanyId_fkey" FOREIGN KEY ("providerCompanyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportServiceAgreement" ADD CONSTRAINT "TransportServiceAgreement_customerCompanyId_fkey" FOREIGN KEY ("customerCompanyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Raw SQL (Prisma cannot express these; documented on the model).
-- One live agreement per provider + customer pair (P1).
CREATE UNIQUE INDEX "TransportServiceAgreement_live_pair_key" ON "TransportServiceAgreement" ("providerCompanyId", "customerCompanyId")
  WHERE "status" IN ('DRAFT', 'PROPOSED', 'ACTIVE', 'SUSPENDED');

-- Corporate-managed mode has no row: provider and customer must differ (D1).
ALTER TABLE "TransportServiceAgreement" ADD CONSTRAINT "TransportServiceAgreement_parties_check" CHECK ("providerCompanyId" <> "customerCompanyId");
ALTER TABLE "TransportServiceAgreement" ADD CONSTRAINT "TransportServiceAgreement_validity_check" CHECK ("validTo" IS NULL OR "validTo" > "validFrom");
ALTER TABLE "TransportServiceAgreement" ADD CONSTRAINT "TransportServiceAgreement_version_check" CHECK ("version" >= 1);
-- Prisma scalar lists are nullable columns; the closed grant list and site list are never NULL and hold no NULL element.
ALTER TABLE "TransportServiceAgreement" ADD CONSTRAINT "TransportServiceAgreement_lists_check"
  CHECK ("grants" IS NOT NULL AND "siteIds" IS NOT NULL AND array_position("grants", NULL) IS NULL AND array_position("siteIds", NULL) IS NULL);
-- P1 adopted (both sides approve in-app): ACTIVE / SUSPENDED only after both approvals. The approval columns have no FK,
-- so no purge SET NULL can violate this (doc 15 §1.3).
ALTER TABLE "TransportServiceAgreement" ADD CONSTRAINT "TransportServiceAgreement_active_approved_check"
  CHECK ("status" NOT IN ('ACTIVE', 'SUSPENDED') OR ("approvedByCustomerAt" IS NOT NULL AND "approvedByProviderAt" IS NOT NULL));
ALTER TABLE "TransportServiceAgreement" ADD CONSTRAINT "TransportServiceAgreement_ended_check" CHECK ("status" <> 'ENDED' OR "endedAt" IS NOT NULL);
