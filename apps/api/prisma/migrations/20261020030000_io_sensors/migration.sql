-- CreateTable
CREATE TABLE "IoSensorConfig" (
    "objectId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "companyId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'ANALOG',
    "attribute" TEXT NOT NULL DEFAULT 'adc1',
    "invert" BOOLEAN NOT NULL DEFAULT false,
    "minV" DOUBLE PRECISION,
    "maxV" DOUBLE PRECISION,
    "hysteresisV" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "debounceSec" INTEGER NOT NULL DEFAULT 10,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IoSensorConfig_pkey" PRIMARY KEY ("objectId","kind")
);

-- CreateTable
CREATE TABLE "IoSession" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "on" BOOLEAN NOT NULL,
    "startTime" TIMESTAMPTZ(3) NOT NULL,
    "endTime" TIMESTAMPTZ(3),
    "startLat" DOUBLE PRECISION,
    "startLng" DOUBLE PRECISION,
    "endLat" DOUBLE PRECISION,
    "endLng" DOUBLE PRECISION,
    "distanceKm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "engineOffSec" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IoSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IoSensorConfig_companyId_idx" ON "IoSensorConfig"("companyId");

-- CreateIndex
CREATE INDEX "IoSession_companyId_startTime_idx" ON "IoSession"("companyId", "startTime" DESC);

-- CreateIndex
CREATE INDEX "IoSession_objectId_kind_startTime_idx" ON "IoSession"("objectId", "kind", "startTime");

-- AddForeignKey
ALTER TABLE "IoSensorConfig" ADD CONSTRAINT "IoSensorConfig_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IoSession" ADD CONSTRAINT "IoSession_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

