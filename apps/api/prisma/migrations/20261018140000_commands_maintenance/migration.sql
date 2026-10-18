-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('QUEUED', 'SENT', 'ACKED', 'FAILED', 'EXPIRED');

-- AlterTable
ALTER TABLE "TrackedObject" ADD COLUMN     "maintenanceNote" TEXT,
ADD COLUMN     "maintenanceSince" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "DeviceCommand" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "uniqueId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" "CommandStatus" NOT NULL DEFAULT 'QUEUED',
    "response" TEXT,
    "error" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(3),
    "ackAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DeviceCommand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceCommand_objectId_createdAt_idx" ON "DeviceCommand"("objectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "DeviceCommand_companyId_createdAt_idx" ON "DeviceCommand"("companyId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RawPacket_uniqueId_receivedAt_idx" ON "RawPacket"("uniqueId", "receivedAt" DESC);

-- AddForeignKey
ALTER TABLE "DeviceCommand" ADD CONSTRAINT "DeviceCommand_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

