-- Device inventory (Phase B1). ADDITIVE ONLY: five new tables with their indexes, foreign keys and one CHECK.
-- No existing table or column is altered. Device / Company / TrackedObject / Partner are only referenced by the new
-- tables (DeviceStock cascades with its Device; StockMovement links are SET NULL so the ledger survives a purge).
-- Rollback (manual, owner-approved; loses inventory data only):
--   DROP TABLE "StockMovement", "DeviceStock", "StockReceipt", "Supplier", "StockLocation";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261109090000_device_inventory';

-- CreateTable
CREATE TABLE "StockLocation" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerPartnerId" UUID,
    "address" TEXT,
    "stateCode" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StockLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" UUID NOT NULL,
    "ownerPartnerId" UUID,
    "name" TEXT NOT NULL,
    "gstin" TEXT,
    "stateCode" TEXT,
    "contact" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockReceipt" (
    "id" UUID NOT NULL,
    "supplierId" UUID,
    "locationId" UUID NOT NULL,
    "supplierInvoiceNo" TEXT,
    "supplierInvoiceAt" DATE,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceStock" (
    "deviceId" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "locationId" UUID,
    "holderPartnerId" UUID,
    "receiptId" UUID,
    "serialNumber" TEXT,
    "unitCostPaise" INTEGER,
    "warrantyUntil" DATE,
    "condition" TEXT,
    "note" TEXT,
    "statusChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DeviceStock_pkey" PRIMARY KEY ("deviceId")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" UUID NOT NULL,
    "deviceId" UUID,
    "itemRef" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "fromLocationId" UUID,
    "toLocationId" UUID,
    "fromHolderPartnerId" UUID,
    "toHolderPartnerId" UUID,
    "companyId" UUID,
    "objectId" UUID,
    "partnerId" UUID,
    "receiptId" UUID,
    "reason" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "changes" JSONB,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockLocation_kind_idx" ON "StockLocation"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "StockLocation_ownerPartnerId_code_key" ON "StockLocation"("ownerPartnerId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_ownerPartnerId_name_key" ON "Supplier"("ownerPartnerId", "name");

-- CreateIndex
CREATE INDEX "StockReceipt_supplierId_receivedAt_idx" ON "StockReceipt"("supplierId", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "StockReceipt_receivedAt_idx" ON "StockReceipt"("receivedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "DeviceStock_serialNumber_key" ON "DeviceStock"("serialNumber");

-- CreateIndex
CREATE INDEX "DeviceStock_status_locationId_idx" ON "DeviceStock"("status", "locationId");

-- CreateIndex
CREATE INDEX "DeviceStock_holderPartnerId_status_idx" ON "DeviceStock"("holderPartnerId", "status");

-- CreateIndex
CREATE INDEX "DeviceStock_receiptId_idx" ON "DeviceStock"("receiptId");

-- CreateIndex
CREATE INDEX "StockMovement_deviceId_at_idx" ON "StockMovement"("deviceId", "at" DESC);

-- CreateIndex
CREATE INDEX "StockMovement_at_idx" ON "StockMovement"("at" DESC);

-- CreateIndex
CREATE INDEX "StockMovement_toLocationId_at_idx" ON "StockMovement"("toLocationId", "at" DESC);

-- CreateIndex
CREATE INDEX "StockMovement_fromLocationId_at_idx" ON "StockMovement"("fromLocationId", "at" DESC);

-- CreateIndex
CREATE INDEX "StockMovement_companyId_at_idx" ON "StockMovement"("companyId", "at" DESC);

-- CreateIndex
CREATE INDEX "StockMovement_kind_at_idx" ON "StockMovement"("kind", "at" DESC);

-- AddForeignKey
ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_ownerPartnerId_fkey" FOREIGN KEY ("ownerPartnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_ownerPartnerId_fkey" FOREIGN KEY ("ownerPartnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReceipt" ADD CONSTRAINT "StockReceipt_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReceipt" ADD CONSTRAINT "StockReceipt_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceStock" ADD CONSTRAINT "DeviceStock_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceStock" ADD CONSTRAINT "DeviceStock_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceStock" ADD CONSTRAINT "DeviceStock_holderPartnerId_fkey" FOREIGN KEY ("holderPartnerId") REFERENCES "Partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceStock" ADD CONSTRAINT "DeviceStock_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "StockReceipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "StockReceipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Platform-level codes / names are unique among platform rows (NULL ownerPartnerId is not covered by the composite UK).
CREATE UNIQUE INDEX "StockLocation_platform_code_key" ON "StockLocation" ("code") WHERE "ownerPartnerId" IS NULL;
CREATE UNIQUE INDEX "Supplier_platform_name_key" ON "Supplier" ("name") WHERE "ownerPartnerId" IS NULL;

-- Money is never negative.
ALTER TABLE "DeviceStock" ADD CONSTRAINT "DeviceStock_unitCostPaise_check" CHECK ("unitCostPaise" IS NULL OR "unitCostPaise" >= 0);
