CREATE TABLE "ParkingSchedule" (
    "objectId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "windows" JSONB NOT NULL DEFAULT '[]',
    "alarmAllAlerts" BOOLEAN NOT NULL DEFAULT true,
    "escalation" JSONB NOT NULL DEFAULT '{}',
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "ParkingSchedule_pkey" PRIMARY KEY ("objectId")
);
CREATE INDEX "ParkingSchedule_companyId_idx" ON "ParkingSchedule"("companyId");
ALTER TABLE "ParkingSchedule" ADD CONSTRAINT "ParkingSchedule_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
