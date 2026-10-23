-- Tracker app: extra e-mail address that receives the activation code.
ALTER TABLE "Device" ADD COLUMN "activationEmail" TEXT;
ALTER TABLE "MobileTrackerCode" ADD COLUMN "emailCount" INTEGER NOT NULL DEFAULT 0;
