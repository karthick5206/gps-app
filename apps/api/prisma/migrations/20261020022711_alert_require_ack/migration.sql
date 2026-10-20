-- AlterTable
ALTER TABLE "Alert" ADD COLUMN     "ackRequired" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "AlertSetting" ADD COLUMN     "requireAck" BOOLEAN;

-- Backfill with the default rule (shared `defaultRequireAck`): SOS, crash, power cut, device offline and every CRITICAL alert.
UPDATE "Alert" SET "ackRequired" = true
WHERE "severity" = 'CRITICAL' OR "type" IN ('SOS', 'CRASH', 'POWER_CUT', 'DEVICE_OFFLINE');
