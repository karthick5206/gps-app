-- DropIndex
DROP INDEX "Alert_companyId_status_idx";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "alertsReadBefore" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "AlertRead" (
    "alertId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "readAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertRead_pkey" PRIMARY KEY ("alertId","userId")
);

-- CreateIndex
CREATE INDEX "AlertRead_userId_readAt_idx" ON "AlertRead"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Alert_companyId_status_occurredAt_idx" ON "Alert"("companyId", "status", "occurredAt" DESC);
