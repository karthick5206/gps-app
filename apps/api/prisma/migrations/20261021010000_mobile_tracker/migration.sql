-- Phones running the VeeTrax Tracker app: licence type, activation codes, tracking sessions.
ALTER TYPE "LicenceType" ADD VALUE IF NOT EXISTS 'MOBILE_TRACKER';

CREATE TABLE "MobileTrackerCode" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMPTZ(3),
    "smsSent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MobileTrackerCode_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MobileTrackerCode_deviceId_createdAt_idx" ON "MobileTrackerCode"("deviceId", "createdAt" DESC);
ALTER TABLE "MobileTrackerCode" ADD CONSTRAINT "MobileTrackerCode_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MobileTrackerSession" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "deviceName" TEXT,
    "appVersion" TEXT,
    "platform" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    CONSTRAINT "MobileTrackerSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MobileTrackerSession_tokenHash_key" ON "MobileTrackerSession"("tokenHash");
CREATE INDEX "MobileTrackerSession_deviceId_idx" ON "MobileTrackerSession"("deviceId");
ALTER TABLE "MobileTrackerSession" ADD CONSTRAINT "MobileTrackerSession_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
