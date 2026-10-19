-- CreateEnum
CREATE TYPE "DriverEventStatus" AS ENUM ('NEW', 'REVIEWED', 'DISMISSED', 'COACHED');

-- CreateEnum
CREATE TYPE "DriverMediaKind" AS ENUM ('PHOTO', 'VIDEO');

-- CreateEnum
CREATE TYPE "DriverMediaSource" AS ENUM ('SNAPSHOT', 'ATTACHMENT');

-- CreateTable
CREATE TABLE "DriverEvent" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "deviceId" UUID,
    "driverId" UUID,
    "alertId" UUID,
    "type" TEXT NOT NULL,
    "level" INTEGER,
    "speedKph" DOUBLE PRECISION,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "address" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "DriverEventStatus" NOT NULL DEFAULT 'NEW',
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMPTZ(3),
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverEventMedia" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "kind" "DriverMediaKind" NOT NULL,
    "source" "DriverMediaSource" NOT NULL,
    "channel" INTEGER,
    "filePath" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "mime" TEXT NOT NULL,
    "capturedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverEventMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DriverEvent_alertId_key" ON "DriverEvent"("alertId");

-- CreateIndex
CREATE INDEX "DriverEvent_companyId_occurredAt_idx" ON "DriverEvent"("companyId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "DriverEvent_objectId_occurredAt_idx" ON "DriverEvent"("objectId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "DriverEvent_driverId_occurredAt_idx" ON "DriverEvent"("driverId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "DriverEvent_deviceId_occurredAt_idx" ON "DriverEvent"("deviceId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "DriverEventMedia_eventId_idx" ON "DriverEventMedia"("eventId");

-- CreateIndex
CREATE INDEX "DriverEventMedia_companyId_createdAt_idx" ON "DriverEventMedia"("companyId", "createdAt");

-- AddForeignKey
ALTER TABLE "DriverEvent" ADD CONSTRAINT "DriverEvent_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverEvent" ADD CONSTRAINT "DriverEvent_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverEventMedia" ADD CONSTRAINT "DriverEventMedia_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "DriverEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Built-in roles get the new "driver_events" menu: Admin / Manager view + review + export, User view only.
INSERT INTO "RolePermission" ("roleId", "menu", "actions")
SELECT r."id", 'driver_events',
       CASE WHEN r."name" IN ('Admin', 'Manager') THEN ARRAY['view', 'edit', 'export'] ELSE ARRAY['view'] END
FROM "Role" r
WHERE r."isSystem" = true
  AND r."name" IN ('Admin', 'Manager', 'User')
ON CONFLICT ("roleId", "menu") DO NOTHING;
