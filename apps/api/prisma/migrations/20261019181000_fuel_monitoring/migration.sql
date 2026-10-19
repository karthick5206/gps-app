-- CreateTable
CREATE TABLE "FuelConfig" (
    "objectId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'none',
    "tankCapacityL" DOUBLE PRECISION,
    "calibration" JSONB NOT NULL DEFAULT '[]',
    "refillMinL" DOUBLE PRECISION,
    "drainMinL" DOUBLE PRECISION NOT NULL DEFAULT 8,
    "drainWindowMin" INTEGER NOT NULL DEFAULT 10,
    "smoothingWindow" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "FuelConfig_pkey" PRIMARY KEY ("objectId")
);

-- CreateTable
CREATE TABLE "FuelEvent" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "startTime" TIMESTAMPTZ(3) NOT NULL,
    "endTime" TIMESTAMPTZ(3) NOT NULL,
    "litresBefore" DOUBLE PRECISION NOT NULL,
    "litresAfter" DOUBLE PRECISION NOT NULL,
    "deltaL" DOUBLE PRECISION NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FuelEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FuelConfig_companyId_idx" ON "FuelConfig"("companyId");

-- CreateIndex
CREATE INDEX "FuelEvent_companyId_startTime_idx" ON "FuelEvent"("companyId", "startTime" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "FuelEvent_objectId_type_startTime_key" ON "FuelEvent"("objectId", "type", "startTime");

-- AddForeignKey
ALTER TABLE "FuelConfig" ADD CONSTRAINT "FuelConfig_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelEvent" ADD CONSTRAINT "FuelEvent_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

