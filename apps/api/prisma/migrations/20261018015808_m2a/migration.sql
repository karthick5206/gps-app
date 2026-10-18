-- CreateEnum
CREATE TYPE "GeofenceType" AS ENUM ('CIRCLE', 'POLYGON', 'RECTANGLE');

-- CreateEnum
CREATE TYPE "GeofenceMode" AS ENUM ('NORMAL', 'NO_GO', 'KEEP_IN');

-- CreateEnum
CREATE TYPE "AlertLevel" AS ENUM ('COMPANY', 'BRANCH', 'GROUP', 'OBJECT');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('NEW', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "NotifyChannel" AS ENUM ('INAPP', 'EMAIL', 'SMS', 'WHATSAPP', 'PUSH');

-- CreateEnum
CREATE TYPE "RecipientMode" AS ENUM ('DEFAULT', 'ADD', 'ONLY', 'NONE');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ReportFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "ReportPeriod" AS ENUM ('DAY', 'WEEK', 'MONTH');

-- CreateEnum
CREATE TYPE "ReportFormat" AS ENUM ('XLSX', 'PDF', 'CSV');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "VehicleGroup" ADD COLUMN     "alertPriority" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Geofence" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "branchId" UUID,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "type" "GeofenceType" NOT NULL,
    "geometry" JSONB NOT NULL,
    "minLat" DOUBLE PRECISION NOT NULL,
    "minLng" DOUBLE PRECISION NOT NULL,
    "maxLat" DOUBLE PRECISION NOT NULL,
    "maxLng" DOUBLE PRECISION NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#0f766e',
    "address" TEXT,
    "description" TEXT,
    "mode" "GeofenceMode" NOT NULL DEFAULT 'NORMAL',
    "notifyEnter" BOOLEAN NOT NULL DEFAULT true,
    "notifyExit" BOOLEAN NOT NULL DEFAULT true,
    "maxStayMin" INTEGER,
    "speedLimitKph" INTEGER,
    "timeWindows" JSONB NOT NULL DEFAULT '[]',
    "appliesToAll" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Geofence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeofenceTarget" (
    "geofenceId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" UUID NOT NULL,

    CONSTRAINT "GeofenceTarget_pkey" PRIMARY KEY ("geofenceId","kind","refId")
);

-- CreateTable
CREATE TABLE "AlertSetting" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "level" "AlertLevel" NOT NULL,
    "targetId" UUID NOT NULL,
    "alertType" TEXT NOT NULL,
    "enabled" BOOLEAN,
    "params" JSONB NOT NULL DEFAULT '{}',
    "schedule" JSONB,
    "cooldownMin" INTEGER,
    "severity" "AlertSeverity",
    "channels" JSONB,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipientList" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "level" "AlertLevel" NOT NULL,
    "targetId" UUID NOT NULL,
    "alertType" TEXT NOT NULL DEFAULT '*',
    "severity" TEXT NOT NULL DEFAULT '*',
    "channel" "NotifyChannel" NOT NULL,
    "mode" "RecipientMode" NOT NULL DEFAULT 'DEFAULT',
    "entries" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipientList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertSnooze" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "level" "AlertLevel" NOT NULL,
    "targetId" UUID NOT NULL,
    "alertTypes" TEXT[],
    "until" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertSnooze_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertPack" (
    "id" UUID NOT NULL,
    "companyId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "settings" JSONB NOT NULL DEFAULT '[]',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertPack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "deviceId" UUID,
    "type" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "message" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "address" TEXT,
    "geofenceId" UUID,
    "data" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "AlertStatus" NOT NULL DEFAULT 'NEW',
    "ackById" UUID,
    "ackAt" TIMESTAMP(3),
    "ackNote" TEXT,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "alertId" UUID,
    "channel" "NotifyChannel" NOT NULL,
    "recipient" TEXT NOT NULL,
    "templateId" UUID,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL,
    "error" TEXT,
    "provider" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" UUID NOT NULL,
    "companyId" UUID,
    "purpose" TEXT NOT NULL,
    "channel" "NotifyChannel" NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "name" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "dltTemplateId" TEXT,
    "senderId" TEXT,
    "approvalStatus" TEXT NOT NULL DEFAULT 'NA',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageTemplateVersion" (
    "id" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "changedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageTemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trip" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "startTime" TIMESTAMPTZ(3) NOT NULL,
    "endTime" TIMESTAMPTZ(3) NOT NULL,
    "startLat" DOUBLE PRECISION NOT NULL,
    "startLng" DOUBLE PRECISION NOT NULL,
    "endLat" DOUBLE PRECISION NOT NULL,
    "endLng" DOUBLE PRECISION NOT NULL,
    "startAddress" TEXT,
    "endAddress" TEXT,
    "distanceKm" DOUBLE PRECISION NOT NULL,
    "durationSec" INTEGER NOT NULL,
    "idleSec" INTEGER NOT NULL DEFAULT 0,
    "maxSpeedKph" DOUBLE PRECISION NOT NULL,
    "avgSpeedKph" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stop" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "startTime" TIMESTAMPTZ(3) NOT NULL,
    "endTime" TIMESTAMPTZ(3) NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "address" TEXT,
    "durationSec" INTEGER NOT NULL,
    "ignitionOn" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Stop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailySummary" (
    "objectId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "companyId" UUID NOT NULL,
    "distanceKm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "runningSec" INTEGER NOT NULL DEFAULT 0,
    "idleSec" INTEGER NOT NULL DEFAULT 0,
    "stopSec" INTEGER NOT NULL DEFAULT 0,
    "offlineSec" INTEGER NOT NULL DEFAULT 0,
    "overspeedSec" INTEGER NOT NULL DEFAULT 0,
    "overspeedCount" INTEGER NOT NULL DEFAULT 0,
    "tripCount" INTEGER NOT NULL DEFAULT 0,
    "maxSpeedKph" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgSpeedKph" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "engineSec" INTEGER NOT NULL DEFAULT 0,
    "firstStart" TIMESTAMP(3),
    "lastStop" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailySummary_pkey" PRIMARY KEY ("objectId","day")
);

-- CreateTable
CREATE TABLE "SummaryCursor" (
    "objectId" UUID NOT NULL,
    "processedUntil" TIMESTAMPTZ(3) NOT NULL,
    "state" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SummaryCursor_pkey" PRIMARY KEY ("objectId")
);

-- CreateTable
CREATE TABLE "SummaryDirtyDay" (
    "objectId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SummaryDirtyDay_pkey" PRIMARY KEY ("objectId","day")
);

-- CreateTable
CREATE TABLE "ReportSchedule" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "reportTypes" TEXT[],
    "scope" JSONB NOT NULL DEFAULT '{}',
    "period" "ReportPeriod" NOT NULL DEFAULT 'DAY',
    "frequency" "ReportFrequency" NOT NULL,
    "dayOfWeek" INTEGER,
    "dayOfMonth" INTEGER,
    "timeOfDay" TEXT NOT NULL DEFAULT '07:00',
    "format" "ReportFormat" NOT NULL DEFAULT 'XLSX',
    "recipients" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportRun" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "scheduleId" UUID,
    "requestedById" UUID,
    "reportTypes" TEXT[],
    "params" JSONB NOT NULL DEFAULT '{}',
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "fileName" TEXT,
    "filePath" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ReportRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AddressCache" (
    "key" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AddressCache_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "Geofence_companyId_isActive_idx" ON "Geofence"("companyId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Geofence_companyId_name_key" ON "Geofence"("companyId", "name");

-- CreateIndex
CREATE INDEX "GeofenceTarget_refId_idx" ON "GeofenceTarget"("refId");

-- CreateIndex
CREATE INDEX "AlertSetting_companyId_idx" ON "AlertSetting"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "AlertSetting_companyId_level_targetId_alertType_key" ON "AlertSetting"("companyId", "level", "targetId", "alertType");

-- CreateIndex
CREATE INDEX "RecipientList_companyId_idx" ON "RecipientList"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipientList_companyId_level_targetId_alertType_channel_se_key" ON "RecipientList"("companyId", "level", "targetId", "alertType", "channel", "severity");

-- CreateIndex
CREATE INDEX "AlertSnooze_companyId_until_idx" ON "AlertSnooze"("companyId", "until");

-- CreateIndex
CREATE UNIQUE INDEX "AlertPack_companyId_name_key" ON "AlertPack"("companyId", "name");

-- CreateIndex
CREATE INDEX "Alert_companyId_occurredAt_idx" ON "Alert"("companyId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "Alert_objectId_occurredAt_idx" ON "Alert"("objectId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "Alert_companyId_status_idx" ON "Alert"("companyId", "status");

-- CreateIndex
CREATE INDEX "NotificationLog_alertId_idx" ON "NotificationLog"("alertId");

-- CreateIndex
CREATE INDEX "NotificationLog_companyId_createdAt_idx" ON "NotificationLog"("companyId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "MessageTemplate_purpose_channel_idx" ON "MessageTemplate"("purpose", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_companyId_purpose_channel_language_key" ON "MessageTemplate"("companyId", "purpose", "channel", "language");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplateVersion_templateId_version_key" ON "MessageTemplateVersion"("templateId", "version");

-- CreateIndex
CREATE INDEX "Trip_companyId_startTime_idx" ON "Trip"("companyId", "startTime" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Trip_objectId_startTime_key" ON "Trip"("objectId", "startTime");

-- CreateIndex
CREATE INDEX "Stop_companyId_startTime_idx" ON "Stop"("companyId", "startTime" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Stop_objectId_startTime_key" ON "Stop"("objectId", "startTime");

-- CreateIndex
CREATE INDEX "DailySummary_companyId_day_idx" ON "DailySummary"("companyId", "day");

-- CreateIndex
CREATE INDEX "ReportSchedule_companyId_idx" ON "ReportSchedule"("companyId");

-- CreateIndex
CREATE INDEX "ReportSchedule_isActive_nextRunAt_idx" ON "ReportSchedule"("isActive", "nextRunAt");

-- CreateIndex
CREATE INDEX "ReportRun_scheduleId_startedAt_idx" ON "ReportRun"("scheduleId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "ReportRun_companyId_startedAt_idx" ON "ReportRun"("companyId", "startedAt" DESC);

-- AddForeignKey
ALTER TABLE "GeofenceTarget" ADD CONSTRAINT "GeofenceTarget_geofenceId_fkey" FOREIGN KEY ("geofenceId") REFERENCES "Geofence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageTemplateVersion" ADD CONSTRAINT "MessageTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MessageTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- System rows (companyId NULL) must be unique too; the composite unique above treats NULLs as distinct.
CREATE UNIQUE INDEX "MessageTemplate_system_unique" ON "MessageTemplate" ("purpose", "channel", "language") WHERE "companyId" IS NULL;
CREATE UNIQUE INDEX "AlertPack_system_unique" ON "AlertPack" ("name") WHERE "companyId" IS NULL;
