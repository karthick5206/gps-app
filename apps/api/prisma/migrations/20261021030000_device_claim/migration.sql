-- Devices shipped to customers: claim code, reservation and shipment details.
ALTER TABLE "Device" ADD COLUMN "claimCode" TEXT;
ALTER TABLE "Device" ADD COLUMN "reservedEmail" TEXT;
ALTER TABLE "Device" ADD COLUMN "reservedMobile" TEXT;
ALTER TABLE "Device" ADD COLUMN "reservedName" TEXT;
ALTER TABLE "Device" ADD COLUMN "shipmentNote" TEXT;
ALTER TABLE "Device" ADD COLUMN "shippedAt" TIMESTAMPTZ(3);
ALTER TABLE "Device" ADD COLUMN "claimedAt" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "Device_claimCode_key" ON "Device"("claimCode");
