-- Personal accounts with phones of several people.
ALTER TYPE "AccountType" ADD VALUE IF NOT EXISTS 'FAMILY';

-- Tracker codes for numbers that aren't registered yet (self-service activation) and family-member consent OTPs.
ALTER TABLE "MobileTrackerCode" ALTER COLUMN "deviceId" DROP NOT NULL;
ALTER TABLE "MobileTrackerCode" ADD COLUMN "mobile" TEXT;
ALTER TABLE "MobileTrackerCode" ADD COLUMN "email" TEXT;
ALTER TABLE "MobileTrackerCode" ADD COLUMN "name" TEXT;
ALTER TABLE "MobileTrackerCode" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'ACTIVATE';
ALTER TABLE "MobileTrackerCode" ADD COLUMN "companyId" UUID;
CREATE INDEX "MobileTrackerCode_mobile_createdAt_idx" ON "MobileTrackerCode"("mobile", "createdAt" DESC);
