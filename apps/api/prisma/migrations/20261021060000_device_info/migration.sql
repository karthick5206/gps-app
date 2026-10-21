-- SIM ICCID and firmware version reported by the tracker itself (Super Admin).
ALTER TABLE "Device" ADD COLUMN "iccid" TEXT;
ALTER TABLE "Device" ADD COLUMN "firmwareReported" TEXT;
ALTER TABLE "Device" ADD COLUMN "deviceInfoAt" TIMESTAMPTZ(3);
