-- v1.16.9 Employee transport: vendors, rate cards, vendor vehicles / drivers. Additive only.
CREATE TABLE "TransportVendor" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "gstin" TEXT,
    "pan" TEXT,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "bankName" TEXT,
    "bankAccount" TEXT,
    "ifsc" TEXT,
    "upiId" TEXT,
    "branchIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "TransportVendor_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "TransportRateCard" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "vendorId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "branchId" UUID,
    "vehicleCategory" TEXT,
    "model" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "addons" JSONB NOT NULL DEFAULT '{}',
    "gstPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "TransportRateCard_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TransportRateCard_model_check" CHECK ("model" IN ('TRIP','KM','SLAB','MONTHLY','PACKAGE','SEAT'))
);
CREATE TABLE "TransportVendorVehicle" (
    "objectId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "vendorId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TransportVendorVehicle_pkey" PRIMARY KEY ("objectId")
);
CREATE TABLE "TransportVendorDriver" (
    "driverId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "vendorId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TransportVendorDriver_pkey" PRIMARY KEY ("driverId")
);
CREATE UNIQUE INDEX "TransportVendor_companyId_name_key" ON "TransportVendor"("companyId", "name");
CREATE INDEX "TransportVendor_companyId_isActive_idx" ON "TransportVendor"("companyId", "isActive");
CREATE INDEX "TransportRateCard_companyId_vendorId_idx" ON "TransportRateCard"("companyId", "vendorId");
CREATE INDEX "TransportVendorVehicle_vendorId_idx" ON "TransportVendorVehicle"("vendorId");
CREATE INDEX "TransportVendorDriver_vendorId_idx" ON "TransportVendorDriver"("vendorId");
ALTER TABLE "TransportVendor" ADD CONSTRAINT "TransportVendor_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TransportRateCard" ADD CONSTRAINT "TransportRateCard_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "TransportVendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TransportVendorVehicle" ADD CONSTRAINT "TransportVendorVehicle_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "TransportVendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TransportVendorVehicle" ADD CONSTRAINT "TransportVendorVehicle_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TransportVendorDriver" ADD CONSTRAINT "TransportVendorDriver_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "TransportVendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TransportVendorDriver" ADD CONSTRAINT "TransportVendorDriver_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;
