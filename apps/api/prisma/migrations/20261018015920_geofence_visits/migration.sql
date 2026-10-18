-- CreateTable
CREATE TABLE "GeofenceVisit" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "geofenceId" UUID NOT NULL,
    "enterTime" TIMESTAMPTZ(3) NOT NULL,
    "exitTime" TIMESTAMPTZ(3),
    "durationSec" INTEGER,

    CONSTRAINT "GeofenceVisit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GeofenceVisit_companyId_enterTime_idx" ON "GeofenceVisit"("companyId", "enterTime" DESC);

-- CreateIndex
CREATE INDEX "GeofenceVisit_objectId_geofenceId_enterTime_idx" ON "GeofenceVisit"("objectId", "geofenceId", "enterTime" DESC);
