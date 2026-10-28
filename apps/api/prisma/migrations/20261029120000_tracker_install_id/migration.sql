ALTER TABLE "MobileTrackerSession" ADD COLUMN "installIdHash" TEXT;
CREATE INDEX "MobileTrackerSession_installIdHash_idx" ON "MobileTrackerSession"("installIdHash");
