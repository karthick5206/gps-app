-- ETMS E2: people, capacity, driver login (docs/employee-transport/15 §4, §7.2, §7.3; 12 WP 2.0). Additive only.
-- * EmployeeTransportProfile (customer-owned passenger, PD H), EmployeeTransportConsent (append-only evidence, PD M),
--   TransportVehicleProfile (operator-owned seat-capacity side table, PD L), Driver.userId (nullable, unique, SET NULL).
-- * Poi categories OFFICE / SHUTTLE_STOP need no DDL (Poi.category is a string).
-- * No data: no backfill, no RolePermission rows (role templates are seeded by code when `etms` is switched on).
-- * Locks: Driver gets a nullable column (metadata only) and a unique index on a small table; the three new tables are
--   empty, so their FKs take only a brief SHARE ROW EXCLUSIVE on Company / Branch / User / Poi / TrackedObject.
--
-- Rollback (forward-only repo, doc 15 §9.4): switch off (ETMS=off or company add-on `etms` off) — profiles, consents and
-- vehicle profiles are then unread and Driver.userId is ignored by fleet code. A defect is fixed by a new forward
-- migration (relax a CHECK, add a column). A full revert needs owner authorisation (destructive once rows exist):
--   DROP TABLE "EmployeeTransportConsent"; DROP TABLE "EmployeeTransportProfile"; DROP TABLE "TransportVehicleProfile";
--   ALTER TABLE "Driver" DROP COLUMN "userId";
--
-- Purge (doc 15 §6): company purge → profile via its companyId FK (RESTRICT, walked) and consents via the composite
-- profile FK (row id first, so the planner sees profileId → id) and the companyId logical key (no FK on that column);
-- vehicle profiles via the companyId logical key. Vehicle purge → TransportVehicleProfile CASCADE. User purge →
-- EmployeeTransportProfile.userId and Driver.userId SET NULL (rows and their personal data survive: erasure routine,
-- WP 2.6 / L5). No CHECK involves a column that a purge sets to NULL (doc 15 §1.3).

-- AlterTable
ALTER TABLE "Driver" ADD COLUMN     "userId" UUID;

-- CreateTable
CREATE TABLE "EmployeeTransportProfile" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "branchId" UUID,
    "userId" UUID,
    "employeeCode" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "mobile" TEXT,
    "email" TEXT,
    "homeAddress" TEXT,
    "homeLat" DOUBLE PRECISION,
    "homeLng" DOUBLE PRECISION,
    "homeGeocodeSource" TEXT,
    "homeGeocodeConfidence" DOUBLE PRECISION,
    "officePoiId" UUID,
    "defaultStopPoiId" UUID,
    "accessibility" JSONB NOT NULL DEFAULT '{}',
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "emergencyContacts" JSONB NOT NULL DEFAULT '[]',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "anonymisedAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EmployeeTransportProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeTransportConsent" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "subjectUserId" UUID,
    "actorUserId" UUID,
    "purpose" TEXT NOT NULL,
    "noticeVersion" TEXT NOT NULL,
    "locale" TEXT,
    "granted" BOOLEAN NOT NULL,
    "channel" TEXT NOT NULL,
    "appVersion" TEXT,
    "ip" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeTransportConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportVehicleProfile" (
    "objectId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "seats" INTEGER NOT NULL,
    "wheelchairSpaces" INTEGER NOT NULL DEFAULT 0,
    "hasAc" BOOLEAN,
    "category" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TransportVehicleProfile_pkey" PRIMARY KEY ("objectId")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeTransportProfile_userId_key" ON "EmployeeTransportProfile"("userId");

-- CreateIndex
CREATE INDEX "EmployeeTransportProfile_companyId_isActive_idx" ON "EmployeeTransportProfile"("companyId", "isActive");

-- CreateIndex
CREATE INDEX "EmployeeTransportProfile_companyId_officePoiId_idx" ON "EmployeeTransportProfile"("companyId", "officePoiId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeTransportProfile_companyId_employeeCode_key" ON "EmployeeTransportProfile"("companyId", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeTransportProfile_id_companyId_key" ON "EmployeeTransportProfile"("id", "companyId");

-- CreateIndex
CREATE INDEX "EmployeeTransportConsent_profileId_purpose_occurredAt_idx" ON "EmployeeTransportConsent"("profileId", "purpose", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "TransportVehicleProfile_companyId_idx" ON "TransportVehicleProfile"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_userId_key" ON "Driver"("userId");

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeTransportProfile" ADD CONSTRAINT "EmployeeTransportProfile_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeTransportProfile" ADD CONSTRAINT "EmployeeTransportProfile_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeTransportProfile" ADD CONSTRAINT "EmployeeTransportProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeTransportProfile" ADD CONSTRAINT "EmployeeTransportProfile_officePoiId_fkey" FOREIGN KEY ("officePoiId") REFERENCES "Poi"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeTransportProfile" ADD CONSTRAINT "EmployeeTransportProfile_defaultStopPoiId_fkey" FOREIGN KEY ("defaultStopPoiId") REFERENCES "Poi"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeTransportConsent" ADD CONSTRAINT "EmployeeTransportConsent_profileId_companyId_fkey" FOREIGN KEY ("profileId", "companyId") REFERENCES "EmployeeTransportProfile"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportVehicleProfile" ADD CONSTRAINT "TransportVehicleProfile_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- Raw SQL (Prisma cannot express these; documented on the models).
-- Original home point: both or neither, in range, finite, never the (0,0) placeholder (doc 02 §7.2).
ALTER TABLE "EmployeeTransportProfile" ADD CONSTRAINT "EmployeeTransportProfile_home_pair_check"
  CHECK (("homeLat" IS NULL) = ("homeLng" IS NULL));
ALTER TABLE "EmployeeTransportProfile" ADD CONSTRAINT "EmployeeTransportProfile_home_range_check"
  CHECK ("homeLat" IS NULL OR ("homeLat" BETWEEN -90 AND 90 AND "homeLng" BETWEEN -180 AND 180 AND NOT ("homeLat" = 0 AND "homeLng" = 0)));
-- At most three emergency contacts, always a JSON array.
ALTER TABLE "EmployeeTransportProfile" ADD CONSTRAINT "EmployeeTransportProfile_emergency_contacts_check"
  CHECK (CASE WHEN jsonb_typeof("emergencyContacts") = 'array' THEN jsonb_array_length("emergencyContacts") <= 3 ELSE false END);
-- Passenger seats exclude the driver; wheelchair spaces never negative.
ALTER TABLE "TransportVehicleProfile" ADD CONSTRAINT "TransportVehicleProfile_seats_check" CHECK ("seats" BETWEEN 1 AND 100);
ALTER TABLE "TransportVehicleProfile" ADD CONSTRAINT "TransportVehicleProfile_wheelchair_check" CHECK ("wheelchairSpaces" >= 0);
