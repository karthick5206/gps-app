-- Tracker app: latest phone health report (Devices -> Tracker app -> Phone health; Device offline alert cause).
ALTER TABLE "Device" ADD COLUMN "trackerHealth" JSONB;
ALTER TABLE "Device" ADD COLUMN "trackerHealthAt" TIMESTAMPTZ(3);
