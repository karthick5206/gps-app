-- Customer pricing & billing core (doc 19 §3, §5, §7). Additive only: new tables, raw-SQL constraints and triggers; no
-- change to existing tables. Rollback = the 'pricing' company feature off (nothing reads these tables then).
-- btree_gist is already installed by 20261116090100_planned_trip_origin (IF NOT EXISTS needs no superuser then).
SET lock_timeout = '5s';
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateTable
CREATE TABLE "PricingContract" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "customerCompanyId" UUID,
    "customerName" TEXT NOT NULL,
    "agreementId" UUID,
    "name" TEXT NOT NULL,
    "reference" TEXT,
    "currency" CHAR(3) NOT NULL,
    "billingFrequency" TEXT NOT NULL DEFAULT 'MONTHLY',
    "paymentTermsDays" INTEGER NOT NULL DEFAULT 30,
    "taxProfileId" UUID,
    "branchIds" UUID[],
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "defaultCovers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowVehicleOverrides" BOOLEAN NOT NULL DEFAULT false,
    "allowTripOverrides" BOOLEAN NOT NULL DEFAULT false,
    "distanceSource" TEXT NOT NULL DEFAULT 'GPS',
    "onMissingGps" TEXT NOT NULL DEFAULT 'REVIEW',
    "roundingMode" TEXT NOT NULL DEFAULT 'HALF_UP',
    "version" INTEGER NOT NULL DEFAULT 1,
    "submittedById" UUID,
    "submittedAt" TIMESTAMPTZ(3),
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "suspendedAt" TIMESTAMPTZ(3),
    "suspendedReason" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PricingContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingContractVersion" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "contractId" UUID NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "policies" JSONB NOT NULL DEFAULT '{}',
    "submittedById" UUID,
    "submittedAt" TIMESTAMPTZ(3),
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "rejectReason" TEXT,
    "supersedesId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PricingContractVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingComponent" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT,
    "scope" JSONB NOT NULL DEFAULT '{}',
    "params" JSONB NOT NULL DEFAULT '{}',
    "covers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "taxCode" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PricingComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingVehicleRate" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "contractId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "objectName" TEXT NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "componentOverrides" JSONB NOT NULL DEFAULT '[]',
    "category" TEXT,
    "seats" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "reason" TEXT,
    "submittedById" UUID,
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PricingVehicleRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingVehicleAssignment" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "contractId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "objectName" TEXT NOT NULL,
    "driverId" UUID,
    "fleetAllocationId" UUID,
    "branchId" UUID,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "operatingHours" JSONB NOT NULL DEFAULT '{}',
    "replacesAssignmentId" UUID,
    "replacementBilling" TEXT NOT NULL DEFAULT 'SEPARATE',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PricingVehicleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingDowntime" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "billable" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricingDowntime_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingCalendar" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "holidays" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nonOperatingWeekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PricingCalendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TripPriceSnapshot" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "transportTripId" UUID NOT NULL,
    "bookingId" UUID,
    "passengerId" UUID,
    "contractId" UUID,
    "contractVersionId" UUID,
    "vehicleRateId" UUID,
    "customerCompanyId" UUID,
    "branchId" UUID,
    "objectId" UUID,
    "serviceDate" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "pricingModel" TEXT,
    "ridePreference" TEXT,
    "plannedDistanceM" INTEGER,
    "gpsDistanceM" INTEGER,
    "agreedDistanceM" INTEGER,
    "manualDistanceM" INTEGER,
    "billableDistanceM" INTEGER,
    "distanceSource" TEXT,
    "gpsQuality" TEXT NOT NULL DEFAULT 'UNAVAILABLE',
    "plannedDurationS" INTEGER,
    "actualDurationS" INTEGER,
    "waitingS" INTEGER,
    "extraStops" INTEGER NOT NULL DEFAULT 0,
    "lines" JSONB NOT NULL DEFAULT '[]',
    "subtotalMinor" BIGINT NOT NULL DEFAULT 0,
    "discountMinor" BIGINT NOT NULL DEFAULT 0,
    "taxLines" JSONB NOT NULL DEFAULT '[]',
    "taxMinor" BIGINT NOT NULL DEFAULT 0,
    "totalMinor" BIGINT NOT NULL DEFAULT 0,
    "issues" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "supersedesId" UUID,
    "reason" TEXT,
    "overrideById" UUID,
    "overrideAt" TIMESTAMPTZ(3),
    "overrideReason" TEXT,
    "overrideApprovedById" UUID,
    "calculatedById" UUID,
    "calculatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "engineVersion" TEXT NOT NULL,

    CONSTRAINT "TripPriceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvailabilityBillingPeriod" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "contractId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "branchId" UUID,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "frequency" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "attachedDays" INTEGER NOT NULL,
    "billableDays" INTEGER NOT NULL,
    "downtimeDays" INTEGER NOT NULL,
    "suspensionDays" INTEGER NOT NULL DEFAULT 0,
    "usedDistanceM" INTEGER NOT NULL DEFAULT 0,
    "usedSeconds" INTEGER NOT NULL DEFAULT 0,
    "tripCount" INTEGER NOT NULL DEFAULT 0,
    "lines" JSONB NOT NULL DEFAULT '[]',
    "subtotalMinor" BIGINT NOT NULL DEFAULT 0,
    "discountMinor" BIGINT NOT NULL DEFAULT 0,
    "taxLines" JSONB NOT NULL DEFAULT '[]',
    "taxMinor" BIGINT NOT NULL DEFAULT 0,
    "totalMinor" BIGINT NOT NULL DEFAULT 0,
    "issues" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "calculatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AvailabilityBillingPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingRun" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "contractId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CLAIMED',
    "claimedBy" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "stats" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,

    CONSTRAINT "BillingRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingCounter" (
    "key" TEXT NOT NULL,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BillingCounter_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "BillingSupplierProfile" (
    "companyId" UUID NOT NULL,
    "legalName" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL DEFAULT '',
    "stateCode" TEXT,
    "country" TEXT NOT NULL DEFAULT 'IN',
    "taxRegime" TEXT NOT NULL DEFAULT 'IN_GST',
    "taxRegistration" TEXT,
    "invoicePrefix" TEXT NOT NULL DEFAULT 'INV',
    "creditNotePrefix" TEXT NOT NULL DEFAULT 'CN',
    "fiscalYearStartMonth" INTEGER NOT NULL DEFAULT 4,
    "email" TEXT,
    "phone" TEXT,
    "bankDetails" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BillingSupplierProfile_pkey" PRIMARY KEY ("companyId")
);

-- CreateTable
CREATE TABLE "PricingTaxProfile" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "regime" TEXT NOT NULL,
    "jurisdiction" TEXT,
    "defaultTaxCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PricingTaxProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingTaxRate" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "taxCode" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "ratePpm" INTEGER NOT NULL,
    "sac" TEXT,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricingTaxRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerInvoice" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "number" TEXT,
    "fy" TEXT,
    "seq" INTEGER,
    "contractId" UUID,
    "customerCompanyId" UUID,
    "branchId" UUID,
    "consolidated" BOOLEAN NOT NULL DEFAULT true,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "supplier" JSONB NOT NULL DEFAULT '{}',
    "buyer" JSONB NOT NULL DEFAULT '{}',
    "taxKind" TEXT,
    "subtotalMinor" BIGINT NOT NULL DEFAULT 0,
    "discountMinor" BIGINT NOT NULL DEFAULT 0,
    "taxLines" JSONB NOT NULL DEFAULT '[]',
    "taxMinor" BIGINT NOT NULL DEFAULT 0,
    "totalMinor" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "issuedAt" TIMESTAMPTZ(3),
    "issuedById" UUID,
    "invoiceDate" DATE,
    "dueDate" DATE,
    "pdfFile" TEXT,
    "emailedAt" TIMESTAMPTZ(3),
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "billingRunId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CustomerInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerInvoiceLine" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" UUID,
    "sourceKey" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "unit" TEXT NOT NULL,
    "rate" DECIMAL(20,6),
    "amountMinor" BIGINT NOT NULL,
    "discountMinor" BIGINT NOT NULL DEFAULT 0,
    "taxCode" TEXT,
    "taxMinor" BIGINT NOT NULL DEFAULT 0,
    "totalMinor" BIGINT NOT NULL,
    "taxLines" JSONB NOT NULL DEFAULT '[]',
    "branchId" UUID,
    "serviceDate" DATE,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CustomerInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingAdjustment" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "contractId" UUID NOT NULL,
    "invoiceId" UUID,
    "transportTripId" UUID,
    "kind" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requestedById" UUID NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,
    "appliedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "BillingAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerCreditNote" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "fy" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "lines" JSONB NOT NULL DEFAULT '[]',
    "subtotalMinor" BIGINT NOT NULL,
    "taxMinor" BIGINT NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "taxLines" JSONB NOT NULL DEFAULT '[]',
    "reason" TEXT NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" UUID NOT NULL,
    "pdfFile" TEXT,

    CONSTRAINT "CustomerCreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPayment" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "recordedById" UUID NOT NULL,
    "reversalOf" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatingCostRecord" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "objectId" UUID,
    "driverId" UUID,
    "transportTripId" UUID,
    "branchId" UUID,
    "date" DATE NOT NULL,
    "category" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "sourceRef" TEXT,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperatingCostRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PricingContract_companyId_status_idx" ON "PricingContract"("companyId", "status");

-- CreateIndex
CREATE INDEX "PricingContract_companyId_customerCompanyId_idx" ON "PricingContract"("companyId", "customerCompanyId");

-- CreateIndex
CREATE INDEX "PricingContractVersion_companyId_status_idx" ON "PricingContractVersion"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PricingContractVersion_contractId_versionNo_key" ON "PricingContractVersion"("contractId", "versionNo");

-- CreateIndex
CREATE INDEX "PricingComponent_versionId_idx" ON "PricingComponent"("versionId");

-- CreateIndex
CREATE INDEX "PricingVehicleRate_companyId_contractId_idx" ON "PricingVehicleRate"("companyId", "contractId");

-- CreateIndex
CREATE INDEX "PricingVehicleRate_objectId_idx" ON "PricingVehicleRate"("objectId");

-- CreateIndex
CREATE INDEX "PricingVehicleAssignment_companyId_contractId_idx" ON "PricingVehicleAssignment"("companyId", "contractId");

-- CreateIndex
CREATE INDEX "PricingVehicleAssignment_objectId_idx" ON "PricingVehicleAssignment"("objectId");

-- CreateIndex
CREATE INDEX "PricingDowntime_assignmentId_idx" ON "PricingDowntime"("assignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PricingCalendar_companyId_name_key" ON "PricingCalendar"("companyId", "name");

-- CreateIndex
CREATE INDEX "TripPriceSnapshot_companyId_serviceDate_idx" ON "TripPriceSnapshot"("companyId", "serviceDate");

-- CreateIndex
CREATE INDEX "TripPriceSnapshot_transportTripId_idx" ON "TripPriceSnapshot"("transportTripId");

-- CreateIndex
CREATE INDEX "TripPriceSnapshot_companyId_status_idx" ON "TripPriceSnapshot"("companyId", "status");

-- CreateIndex
CREATE INDEX "AvailabilityBillingPeriod_companyId_contractId_periodStart_idx" ON "AvailabilityBillingPeriod"("companyId", "contractId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "AvailabilityBillingPeriod_assignmentId_periodStart_frequenc_key" ON "AvailabilityBillingPeriod"("assignmentId", "periodStart", "frequency");

-- CreateIndex
CREATE INDEX "BillingRun_companyId_status_idx" ON "BillingRun"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BillingRun_companyId_contractId_kind_periodStart_key" ON "BillingRun"("companyId", "contractId", "kind", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "PricingTaxProfile_companyId_name_key" ON "PricingTaxProfile"("companyId", "name");

-- CreateIndex
CREATE INDEX "PricingTaxRate_profileId_taxCode_idx" ON "PricingTaxRate"("profileId", "taxCode");

-- CreateIndex
CREATE INDEX "CustomerInvoice_companyId_status_periodStart_idx" ON "CustomerInvoice"("companyId", "status", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerInvoice_companyId_fy_seq_key" ON "CustomerInvoice"("companyId", "fy", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerInvoice_companyId_number_key" ON "CustomerInvoice"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerInvoice_companyId_idempotencyKey_key" ON "CustomerInvoice"("companyId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "CustomerInvoiceLine_invoiceId_idx" ON "CustomerInvoiceLine"("invoiceId");

-- CreateIndex
CREATE INDEX "BillingAdjustment_companyId_status_idx" ON "BillingAdjustment"("companyId", "status");

-- CreateIndex
CREATE INDEX "BillingAdjustment_contractId_idx" ON "BillingAdjustment"("contractId");

-- CreateIndex
CREATE INDEX "CustomerCreditNote_invoiceId_idx" ON "CustomerCreditNote"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerCreditNote_companyId_fy_seq_key" ON "CustomerCreditNote"("companyId", "fy", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerCreditNote_companyId_number_key" ON "CustomerCreditNote"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPayment_reversalOf_key" ON "BillingPayment"("reversalOf");

-- CreateIndex
CREATE INDEX "BillingPayment_invoiceId_idx" ON "BillingPayment"("invoiceId");

-- CreateIndex
CREATE INDEX "BillingPayment_companyId_receivedAt_idx" ON "BillingPayment"("companyId", "receivedAt");

-- CreateIndex
CREATE INDEX "OperatingCostRecord_companyId_date_idx" ON "OperatingCostRecord"("companyId", "date");

-- AddForeignKey
ALTER TABLE "PricingContract" ADD CONSTRAINT "PricingContract_taxProfileId_fkey" FOREIGN KEY ("taxProfileId") REFERENCES "PricingTaxProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingContractVersion" ADD CONSTRAINT "PricingContractVersion_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "PricingContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingComponent" ADD CONSTRAINT "PricingComponent_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "PricingContractVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingVehicleRate" ADD CONSTRAINT "PricingVehicleRate_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "PricingContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingVehicleAssignment" ADD CONSTRAINT "PricingVehicleAssignment_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "PricingContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingDowntime" ADD CONSTRAINT "PricingDowntime_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "PricingVehicleAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingTaxRate" ADD CONSTRAINT "PricingTaxRate_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "PricingTaxProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerInvoiceLine" ADD CONSTRAINT "CustomerInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "CustomerInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCreditNote" ADD CONSTRAINT "CustomerCreditNote_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "CustomerInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "CustomerInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────────────────────────── Raw SQL (Prisma cannot express it) ─────────────────────────────

-- CHECK constraints (closed value sets, money invariants).
ALTER TABLE "PricingContract"
  ADD CONSTRAINT "PricingContract_status_check" CHECK ("status" IN ('DRAFT','PENDING_APPROVAL','ACTIVE','SUSPENDED','EXPIRED')),
  ADD CONSTRAINT "PricingContract_frequency_check" CHECK ("billingFrequency" IN ('TRIP','DAILY','WEEKLY','MONTHLY')),
  ADD CONSTRAINT "PricingContract_distance_source_check" CHECK ("distanceSource" IN ('GPS','PLANNED','AGREED','MANUAL_APPROVED')),
  ADD CONSTRAINT "PricingContract_missing_gps_check" CHECK ("onMissingGps" IN ('REVIEW','USE_PLANNED','USE_AGREED')),
  ADD CONSTRAINT "PricingContract_rounding_check" CHECK ("roundingMode" IN ('HALF_UP','HALF_EVEN')),
  ADD CONSTRAINT "PricingContract_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "PricingContract_terms_check" CHECK ("paymentTermsDays" BETWEEN 0 AND 365),
  ADD CONSTRAINT "PricingContract_default_check" CHECK (NOT "isDefault" OR "customerCompanyId" IS NULL),
  ADD CONSTRAINT "PricingContract_default_covers_check" CHECK ("defaultCovers" <@ ARRAY['INTERNAL','EXTERNAL']::TEXT[]);
-- One live default contract per company (precedence 4).
CREATE UNIQUE INDEX "PricingContract_one_default_key" ON "PricingContract"("companyId") WHERE "isDefault" AND "status" <> 'EXPIRED';

ALTER TABLE "PricingContractVersion"
  ADD CONSTRAINT "PricingContractVersion_status_check" CHECK ("status" IN ('DRAFT','PENDING_APPROVAL','ACTIVE','SUPERSEDED','REJECTED')),
  ADD CONSTRAINT "PricingContractVersion_validity_check" CHECK ("validTo" IS NULL OR "validTo" > "validFrom"),
  -- Effective-dated, never overlapping (validTo exclusive, NULL = open-ended) among the versions that price trips.
  ADD CONSTRAINT "PricingContractVersion_no_overlap_excl" EXCLUDE USING gist ("contractId" WITH =, daterange("validFrom", "validTo", '[)') WITH &&) WHERE ("status" IN ('ACTIVE','SUPERSEDED'));

ALTER TABLE "PricingComponent"
  ADD CONSTRAINT "PricingComponent_kind_check" CHECK ("kind" IN ('BASE_FARE','PER_KM','SLAB_KM','MIN_TRIP_CHARGE','MIN_BILLABLE_KM','WAITING','EXTRA_STOP','TOLL_PARKING_PASSTHROUGH','NIGHT_SURCHARGE','PEAK_SURCHARGE','FIXED_TRIP','HOURLY','MIN_HOURS','AVAILABILITY_FEE','INCLUDED_KM','INCLUDED_HOURS','EXCESS_KM','EXCESS_HOUR','OVERTIME','HOLIDAY','CANCELLATION','SEAT','MIN_GUARANTEE','DISCOUNT')),
  ADD CONSTRAINT "PricingComponent_covers_check" CHECK ("covers" <@ ARRAY['VEHICLE_TIME','KM_INCLUDED','HOURS_INCLUDED','TRIPS']::TEXT[]);

ALTER TABLE "PricingVehicleRate"
  ADD CONSTRAINT "PricingVehicleRate_status_check" CHECK ("status" IN ('DRAFT','PENDING_APPROVAL','ACTIVE','SUPERSEDED','REJECTED')),
  ADD CONSTRAINT "PricingVehicleRate_validity_check" CHECK ("validTo" IS NULL OR "validTo" > "validFrom"),
  ADD CONSTRAINT "PricingVehicleRate_no_overlap_excl" EXCLUDE USING gist ("contractId" WITH =, "objectId" WITH =, daterange("validFrom", "validTo", '[)') WITH &&) WHERE ("status" IN ('ACTIVE','SUPERSEDED'));

ALTER TABLE "PricingVehicleAssignment"
  ADD CONSTRAINT "PricingVehicleAssignment_status_check" CHECK ("status" IN ('ACTIVE','ENDED')),
  ADD CONSTRAINT "PricingVehicleAssignment_replacement_check" CHECK ("replacementBilling" IN ('ORIGINAL','SEPARATE')),
  ADD CONSTRAINT "PricingVehicleAssignment_validity_check" CHECK ("validTo" IS NULL OR "validTo" > "validFrom");

ALTER TABLE "PricingDowntime"
  ADD CONSTRAINT "PricingDowntime_kind_check" CHECK ("kind" IN ('BREAKDOWN','MAINTENANCE','SUSPENSION','HOLIDAY','NON_OPERATING')),
  ADD CONSTRAINT "PricingDowntime_range_check" CHECK ("toDate" >= "fromDate");

ALTER TABLE "TripPriceSnapshot"
  ADD CONSTRAINT "TripPriceSnapshot_status_check" CHECK ("status" IN ('ESTIMATE','PRICED','NEEDS_REVIEW','COVERED','NO_APPLICABLE_PRICING','ERROR','VOID')),
  ADD CONSTRAINT "TripPriceSnapshot_gps_check" CHECK ("gpsQuality" IN ('OK','MISSING','LOW_COVERAGE','UNAVAILABLE')),
  ADD CONSTRAINT "TripPriceSnapshot_total_check" CHECK ("totalMinor" = "subtotalMinor" - "discountMinor" + "taxMinor");
-- One current price per trip (and per passenger of a shared trip).
CREATE UNIQUE INDEX "TripPriceSnapshot_current_key" ON "TripPriceSnapshot"("transportTripId", COALESCE("passengerId"::TEXT, '')) WHERE "isCurrent";

ALTER TABLE "AvailabilityBillingPeriod"
  ADD CONSTRAINT "AvailabilityBillingPeriod_status_check" CHECK ("status" IN ('OPEN','CLOSED','NEEDS_REVIEW','INVOICED','VOID')),
  ADD CONSTRAINT "AvailabilityBillingPeriod_frequency_check" CHECK ("frequency" IN ('DAILY','WEEKLY','MONTHLY')),
  ADD CONSTRAINT "AvailabilityBillingPeriod_range_check" CHECK ("periodEnd" >= "periodStart"),
  ADD CONSTRAINT "AvailabilityBillingPeriod_total_check" CHECK ("totalMinor" = "subtotalMinor" - "discountMinor" + "taxMinor");

ALTER TABLE "BillingRun"
  ADD CONSTRAINT "BillingRun_kind_check" CHECK ("kind" IN ('TRIP_PRICING','AVAILABILITY_CLOSE','INVOICE')),
  ADD CONSTRAINT "BillingRun_status_check" CHECK ("status" IN ('CLAIMED','RUNNING','DONE','FAILED'));

ALTER TABLE "BillingSupplierProfile"
  ADD CONSTRAINT "BillingSupplierProfile_regime_check" CHECK ("taxRegime" IN ('IN_GST','SIMPLE','NONE')),
  ADD CONSTRAINT "BillingSupplierProfile_fy_check" CHECK ("fiscalYearStartMonth" BETWEEN 1 AND 12);

ALTER TABLE "PricingTaxProfile" ADD CONSTRAINT "PricingTaxProfile_regime_check" CHECK ("regime" IN ('IN_GST','SIMPLE','NONE'));
ALTER TABLE "PricingTaxRate"
  ADD CONSTRAINT "PricingTaxRate_rate_check" CHECK ("ratePpm" BETWEEN 0 AND 1000000),
  ADD CONSTRAINT "PricingTaxRate_validity_check" CHECK ("validTo" IS NULL OR "validTo" > "validFrom");

ALTER TABLE "CustomerInvoice"
  ADD CONSTRAINT "CustomerInvoice_status_check" CHECK ("status" IN ('DRAFT','ISSUED')),
  ADD CONSTRAINT "CustomerInvoice_total_check" CHECK ("totalMinor" = "subtotalMinor" - "discountMinor" + "taxMinor"),
  ADD CONSTRAINT "CustomerInvoice_issued_check" CHECK ("status" <> 'ISSUED' OR ("number" IS NOT NULL AND "fy" IS NOT NULL AND "seq" IS NOT NULL AND "issuedAt" IS NOT NULL));

ALTER TABLE "CustomerInvoiceLine"
  ADD CONSTRAINT "CustomerInvoiceLine_source_check" CHECK ("sourceType" IN ('TRIP_SNAPSHOT','AVAILABILITY_PERIOD','ADJUSTMENT','MANUAL')),
  ADD CONSTRAINT "CustomerInvoiceLine_total_check" CHECK ("totalMinor" = "amountMinor" - "discountMinor" + "taxMinor");
-- Last guard against double billing: a trip (+ passenger), a period or an adjustment is on one invoice line only.
CREATE UNIQUE INDEX "CustomerInvoiceLine_source_key" ON "CustomerInvoiceLine"("sourceKey") WHERE "sourceKey" IS NOT NULL;

ALTER TABLE "BillingAdjustment"
  ADD CONSTRAINT "BillingAdjustment_kind_check" CHECK ("kind" IN ('CREDIT','DEBIT','DISTANCE_CORRECTION','PRICE_OVERRIDE','WAIVER')),
  ADD CONSTRAINT "BillingAdjustment_status_check" CHECK ("status" IN ('PENDING_APPROVAL','APPROVED','REJECTED','APPLIED')),
  ADD CONSTRAINT "BillingAdjustment_maker_checker_check" CHECK ("decidedById" IS NULL OR "decidedById" <> "requestedById");

ALTER TABLE "CustomerCreditNote" ADD CONSTRAINT "CustomerCreditNote_amount_check" CHECK ("totalMinor" > 0 AND "totalMinor" = "subtotalMinor" + "taxMinor");

ALTER TABLE "BillingPayment"
  ADD CONSTRAINT "BillingPayment_amount_check" CHECK ("amountMinor" <> 0),
  ADD CONSTRAINT "BillingPayment_reversal_check" CHECK (("reversalOf" IS NULL AND "amountMinor" > 0) OR ("reversalOf" IS NOT NULL AND "amountMinor" < 0));

ALTER TABLE "OperatingCostRecord"
  ADD CONSTRAINT "OperatingCostRecord_category_check" CHECK ("category" IN ('DRIVER','FUEL','ENERGY','MAINTENANCE','TOLL','PARKING','VEHICLE','OTHER')),
  ADD CONSTRAINT "OperatingCostRecord_source_check" CHECK ("source" IN ('VENDOR_STATEMENT','EXPENSE','MANUAL','IMPORT')),
  ADD CONSTRAINT "OperatingCostRecord_amount_check" CHECK ("amountMinor" >= 0);

-- ───────────────────────────── Immutability triggers ─────────────────────────────
-- Messages start with the API error code so the service layer can map them (INVOICE_ISSUED_IMMUTABLE …).

-- An ACTIVE / SUPERSEDED version is frozen: only status ACTIVE → SUPERSEDED and an earlier (never later / open) validTo.
CREATE OR REPLACE FUNCTION pricing_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" NOT IN ('ACTIVE','SUPERSEDED') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CONTRACT_VERSION_IMMUTABLE: an approved contract version cannot be deleted';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'validTo' - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'validTo' - 'updatedAt')
     OR NOT (NEW."status" = OLD."status" OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'SUPERSEDED'))
     OR (NEW."validTo" IS DISTINCT FROM OLD."validTo" AND (NEW."validTo" IS NULL OR (OLD."validTo" IS NOT NULL AND NEW."validTo" > OLD."validTo"))) THEN
    RAISE EXCEPTION 'CONTRACT_VERSION_IMMUTABLE: an approved contract version cannot be changed; create a new version';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PricingContractVersion_immutable" BEFORE UPDATE OR DELETE ON "PricingContractVersion" FOR EACH ROW EXECUTE FUNCTION pricing_version_guard();

CREATE OR REPLACE FUNCTION pricing_component_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st TEXT;
BEGIN
  SELECT "status" INTO st FROM "PricingContractVersion" WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."versionId" ELSE NEW."versionId" END;
  IF st IN ('ACTIVE','SUPERSEDED') OR (TG_OP = 'UPDATE' AND OLD."versionId" IS DISTINCT FROM NEW."versionId") THEN
    RAISE EXCEPTION 'CONTRACT_VERSION_IMMUTABLE: components of an approved contract version cannot be changed';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER "PricingComponent_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "PricingComponent" FOR EACH ROW EXECUTE FUNCTION pricing_component_guard();

-- Trip price snapshots are append-only: the only change is isCurrent true → false when a newer snapshot supersedes it.
CREATE OR REPLACE FUNCTION trip_price_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'TRIP_PRICE_IMMUTABLE: trip price snapshots are never deleted';
  END IF;
  IF NOT (OLD."isCurrent" AND NOT NEW."isCurrent") OR (to_jsonb(NEW) - 'isCurrent') IS DISTINCT FROM (to_jsonb(OLD) - 'isCurrent') THEN
    RAISE EXCEPTION 'TRIP_PRICE_IMMUTABLE: a trip price snapshot cannot be changed; recalculate to create a new one';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "TripPriceSnapshot_immutable" BEFORE UPDATE OR DELETE ON "TripPriceSnapshot" FOR EACH ROW EXECUTE FUNCTION trip_price_snapshot_guard();

-- A CLOSED / INVOICED availability period keeps its numbers; only CLOSED → INVOICED, never deleted.
CREATE OR REPLACE FUNCTION availability_period_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" NOT IN ('CLOSED','INVOICED') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PERIOD_CLOSED_IMMUTABLE: a closed availability period cannot be deleted';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updatedAt')
     OR NOT (NEW."status" = OLD."status" OR (OLD."status" = 'CLOSED' AND NEW."status" = 'INVOICED')) THEN
    RAISE EXCEPTION 'PERIOD_CLOSED_IMMUTABLE: a closed availability period cannot be changed; use an adjustment';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AvailabilityBillingPeriod_immutable" BEFORE UPDATE OR DELETE ON "AvailabilityBillingPeriod" FOR EACH ROW EXECUTE FUNCTION availability_period_guard();

-- An ISSUED invoice is frozen: only pdfFile / emailedAt (and updatedAt) stay writable; never deleted.
CREATE OR REPLACE FUNCTION customer_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'ISSUED' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'INVOICE_ISSUED_IMMUTABLE: an issued invoice cannot be deleted; issue a credit note';
  END IF;
  IF (to_jsonb(NEW) - 'pdfFile' - 'emailedAt' - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'pdfFile' - 'emailedAt' - 'updatedAt') THEN
    RAISE EXCEPTION 'INVOICE_ISSUED_IMMUTABLE: an issued invoice cannot be changed; issue a credit note';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "CustomerInvoice_immutable" BEFORE UPDATE OR DELETE ON "CustomerInvoice" FOR EACH ROW EXECUTE FUNCTION customer_invoice_guard();

CREATE OR REPLACE FUNCTION customer_invoice_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st TEXT;
BEGIN
  SELECT "status" INTO st FROM "CustomerInvoice" WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."invoiceId" ELSE NEW."invoiceId" END;
  IF st = 'ISSUED' OR (TG_OP = 'UPDATE' AND OLD."invoiceId" IS DISTINCT FROM NEW."invoiceId") THEN
    RAISE EXCEPTION 'INVOICE_ISSUED_IMMUTABLE: lines of an issued invoice cannot be changed';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER "CustomerInvoiceLine_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "CustomerInvoiceLine" FOR EACH ROW EXECUTE FUNCTION customer_invoice_line_guard();

-- Credit notes: append-only (pdfFile may be filled in later).
CREATE OR REPLACE FUNCTION customer_credit_note_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - 'pdfFile') IS DISTINCT FROM (to_jsonb(OLD) - 'pdfFile') THEN
    RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE: credit notes cannot be changed or deleted';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "CustomerCreditNote_immutable" BEFORE UPDATE OR DELETE ON "CustomerCreditNote" FOR EACH ROW EXECUTE FUNCTION customer_credit_note_guard();

-- Payment ledger: append-only (a reversal is a new row).
CREATE OR REPLACE FUNCTION billing_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PAYMENT_LEDGER_IMMUTABLE: payments cannot be changed or deleted; record a reversal';
END $$;
CREATE TRIGGER "BillingPayment_immutable" BEFORE UPDATE OR DELETE ON "BillingPayment" FOR EACH ROW EXECUTE FUNCTION billing_payment_guard();
