-- CreateEnum
CREATE TYPE "PlannedTripStatus" AS ENUM ('SCHEDULED', 'STARTED', 'IN_PROGRESS', 'COMPLETED', 'INCOMPLETE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PlannedStopStatus" AS ENUM ('PENDING', 'ARRIVED', 'DEPARTED', 'SKIPPED');

-- CreateTable
CREATE TABLE "Route" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "branchId" UUID,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "corridorM" INTEGER NOT NULL DEFAULT 200,
    "path" JSONB,
    "distanceM" INTEGER,
    "durationSec" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Route_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteStop" (
    "id" UUID NOT NULL,
    "routeId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "radiusM" INTEGER NOT NULL DEFAULT 100,
    "offsetMin" INTEGER NOT NULL DEFAULT 0,
    "waitMin" INTEGER NOT NULL DEFAULT 0,
    "geofenceId" UUID,

    CONSTRAINT "RouteStop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteSchedule" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "routeId" UUID NOT NULL,
    "days" INTEGER[],
    "startMin" INTEGER NOT NULL,
    "objectId" UUID,
    "driverId" UUID,
    "validFrom" DATE,
    "validTo" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RouteSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlannedTrip" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "branchId" UUID,
    "routeId" UUID NOT NULL,
    "scheduleId" UUID,
    "objectId" UUID NOT NULL,
    "driverId" UUID,
    "routeName" TEXT NOT NULL,
    "corridorM" INTEGER NOT NULL,
    "path" JSONB,
    "plannedStart" TIMESTAMPTZ(3) NOT NULL,
    "plannedEnd" TIMESTAMPTZ(3) NOT NULL,
    "status" "PlannedTripStatus" NOT NULL DEFAULT 'SCHEDULED',
    "actualStart" TIMESTAMPTZ(3),
    "actualEnd" TIMESTAMPTZ(3),
    "closedBy" TEXT,
    "cancelReason" TEXT,
    "notes" TEXT,
    "distanceKm" DOUBLE PRECISION,
    "deviationCount" INTEGER NOT NULL DEFAULT 0,
    "maxDeviationM" INTEGER,
    "nextStopSeq" INTEGER,
    "etaNextStop" TIMESTAMPTZ(3),
    "delaySec" INTEGER,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PlannedTrip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlannedTripStop" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "radiusM" INTEGER NOT NULL,
    "plannedArrival" TIMESTAMPTZ(3) NOT NULL,
    "plannedDeparture" TIMESTAMPTZ(3) NOT NULL,
    "actualArrival" TIMESTAMPTZ(3),
    "actualDeparture" TIMESTAMPTZ(3),
    "status" "PlannedStopStatus" NOT NULL DEFAULT 'PENDING',
    "delaySec" INTEGER,

    CONSTRAINT "PlannedTripStop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlannedTripEvent" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3),
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "data" JSONB,

    CONSTRAINT "PlannedTripEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Route_companyId_isActive_idx" ON "Route"("companyId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Route_companyId_name_key" ON "Route"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "RouteStop_routeId_seq_key" ON "RouteStop"("routeId", "seq");

-- CreateIndex
CREATE INDEX "RouteSchedule_companyId_isActive_idx" ON "RouteSchedule"("companyId", "isActive");

-- CreateIndex
CREATE INDEX "PlannedTrip_companyId_plannedStart_idx" ON "PlannedTrip"("companyId", "plannedStart");

-- CreateIndex
CREATE INDEX "PlannedTrip_objectId_status_idx" ON "PlannedTrip"("objectId", "status");

-- CreateIndex
CREATE INDEX "PlannedTrip_routeId_plannedStart_idx" ON "PlannedTrip"("routeId", "plannedStart");

-- CreateIndex
CREATE UNIQUE INDEX "PlannedTrip_scheduleId_plannedStart_key" ON "PlannedTrip"("scheduleId", "plannedStart");

-- CreateIndex
CREATE UNIQUE INDEX "PlannedTripStop_tripId_seq_key" ON "PlannedTripStop"("tripId", "seq");

-- CreateIndex
CREATE INDEX "PlannedTripEvent_tripId_startAt_idx" ON "PlannedTripEvent"("tripId", "startAt");

-- AddForeignKey
ALTER TABLE "RouteStop" ADD CONSTRAINT "RouteStop_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteSchedule" ADD CONSTRAINT "RouteSchedule_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedTripStop" ADD CONSTRAINT "PlannedTripStop_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "PlannedTrip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedTripEvent" ADD CONSTRAINT "PlannedTripEvent_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "PlannedTrip"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- Built-in roles get the new "routes" and "plannedTrips" menus: Admin / Manager every action, User view only.
INSERT INTO "RolePermission" ("roleId", "menu", "actions")
SELECT r."id", m."menu",
       CASE WHEN r."name" IN ('Admin', 'Manager') THEN ARRAY['view', 'create', 'edit', 'delete', 'export'] ELSE ARRAY['view'] END
FROM "Role" r
CROSS JOIN (VALUES ('routes'), ('plannedTrips')) AS m("menu")
WHERE r."isSystem" = true
  AND r."name" IN ('Admin', 'Manager', 'User')
ON CONFLICT ("roleId", "menu") DO NOTHING;
