-- Super Admin "Import old history" records. Additive.
CREATE TABLE "HistoryImport" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "fileName" TEXT NOT NULL,
    "fromTime" TIMESTAMPTZ(3),
    "toTime" TIMESTAMPTZ(3),
    "points" INTEGER NOT NULL DEFAULT 0,
    "inserted" INTEGER NOT NULL DEFAULT 0,
    "oldKm" DOUBLE PRECISION,
    "importedKm" DOUBLE PRECISION,
    "baseKm" DOUBLE PRECISION,
    "odometerKm" DOUBLE PRECISION,
    "odometerAt" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'UPLOADING',
    "error" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    CONSTRAINT "HistoryImport_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "HistoryImport_objectId_createdAt_idx" ON "HistoryImport"("objectId", "createdAt" DESC);
CREATE INDEX "HistoryImport_status_idx" ON "HistoryImport"("status");
