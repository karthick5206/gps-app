-- SIM management (Phase C1). ADDITIVE ONLY: six new tables with their indexes, foreign keys, two partial unique
-- indexes and CHECKs. No existing table or column is altered: Device.iccid / simNumber / simOperator are only read
-- (reconciliation). SimAssignment / SimEvent links to Device are SET NULL so history survives a device purge.
-- Rollback (manual, owner-approved; loses SIM data only):
--   DROP TABLE "SimUsage", "SimEvent", "SimAssignment", "SimCard", "SimPlan", "SimProvider";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261110090000_sim_management';

-- CreateTable
CREATE TABLE "SimProvider" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'MNO',
    "supportContact" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SimProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimPlan" (
    "id" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "dataMbPerMonth" INTEGER,
    "smsPerMonth" INTEGER,
    "validityDays" INTEGER NOT NULL,
    "costPaise" INTEGER NOT NULL,
    "pricePaise" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SimPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimCard" (
    "id" UUID NOT NULL,
    "iccid" TEXT NOT NULL,
    "msisdn" TEXT,
    "imsi" TEXT,
    "providerId" UUID NOT NULL,
    "planId" UUID,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "ownership" TEXT NOT NULL DEFAULT 'PLATFORM',
    "locationId" UUID,
    "activatedAt" TIMESTAMPTZ(3),
    "renewalDueAt" DATE,
    "statusChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SimCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimAssignment" (
    "id" UUID NOT NULL,
    "simId" UUID NOT NULL,
    "deviceId" UUID,
    "deviceRef" TEXT NOT NULL,
    "fromTime" TIMESTAMPTZ(3) NOT NULL,
    "toTime" TIMESTAMPTZ(3),
    "createdById" UUID,

    CONSTRAINT "SimAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimEvent" (
    "id" UUID NOT NULL,
    "simId" UUID,
    "iccidRef" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "deviceId" UUID,
    "deviceRef" TEXT,
    "reason" TEXT,
    "note" TEXT,
    "changes" JSONB,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SimEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimUsage" (
    "id" UUID NOT NULL,
    "simId" UUID NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "dataMb" INTEGER,
    "smsCount" INTEGER,
    "costPaise" INTEGER,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SimProvider_name_key" ON "SimProvider"("name");

-- CreateIndex
CREATE UNIQUE INDEX "SimPlan_providerId_name_key" ON "SimPlan"("providerId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SimCard_iccid_key" ON "SimCard"("iccid");

-- CreateIndex
CREATE UNIQUE INDEX "SimCard_msisdn_key" ON "SimCard"("msisdn");

-- CreateIndex
CREATE INDEX "SimCard_status_renewalDueAt_idx" ON "SimCard"("status", "renewalDueAt");

-- CreateIndex
CREATE INDEX "SimCard_providerId_idx" ON "SimCard"("providerId");

-- CreateIndex
CREATE INDEX "SimAssignment_simId_fromTime_idx" ON "SimAssignment"("simId", "fromTime" DESC);

-- CreateIndex
CREATE INDEX "SimAssignment_deviceId_fromTime_idx" ON "SimAssignment"("deviceId", "fromTime" DESC);

-- CreateIndex
CREATE INDEX "SimEvent_simId_at_idx" ON "SimEvent"("simId", "at" DESC);

-- CreateIndex
CREATE INDEX "SimEvent_deviceId_at_idx" ON "SimEvent"("deviceId", "at" DESC);

-- CreateIndex
CREATE INDEX "SimEvent_at_idx" ON "SimEvent"("at" DESC);

-- CreateIndex
CREATE INDEX "SimUsage_simId_periodStart_idx" ON "SimUsage"("simId", "periodStart" DESC);

-- AddForeignKey
ALTER TABLE "SimPlan" ADD CONSTRAINT "SimPlan_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "SimProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimCard" ADD CONSTRAINT "SimCard_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "SimProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimCard" ADD CONSTRAINT "SimCard_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SimPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimCard" ADD CONSTRAINT "SimCard_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimAssignment" ADD CONSTRAINT "SimAssignment_simId_fkey" FOREIGN KEY ("simId") REFERENCES "SimCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimAssignment" ADD CONSTRAINT "SimAssignment_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimEvent" ADD CONSTRAINT "SimEvent_simId_fkey" FOREIGN KEY ("simId") REFERENCES "SimCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimEvent" ADD CONSTRAINT "SimEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimUsage" ADD CONSTRAINT "SimUsage_simId_fkey" FOREIGN KEY ("simId") REFERENCES "SimCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One open assignment per SIM and per device (mirrors DeviceAssignment).
CREATE UNIQUE INDEX "SimAssignment_open_sim_key" ON "SimAssignment"("simId") WHERE "toTime" IS NULL;
CREATE UNIQUE INDEX "SimAssignment_open_device_key" ON "SimAssignment"("deviceId") WHERE "toTime" IS NULL AND "deviceId" IS NOT NULL;

-- Money and counters are never negative.
ALTER TABLE "SimPlan" ADD CONSTRAINT "SimPlan_amounts_check" CHECK ("costPaise" >= 0 AND ("pricePaise" IS NULL OR "pricePaise" >= 0) AND "validityDays" > 0);
ALTER TABLE "SimUsage" ADD CONSTRAINT "SimUsage_amounts_check" CHECK (("costPaise" IS NULL OR "costPaise" >= 0) AND ("dataMb" IS NULL OR "dataMb" >= 0) AND ("smsCount" IS NULL OR "smsCount" >= 0) AND "periodEnd" >= "periodStart");
