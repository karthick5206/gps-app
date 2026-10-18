-- CreateTable
CREATE TABLE "Driver" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "branchId" UUID,
    "name" TEXT NOT NULL,
    "mobile" TEXT,
    "employeeId" TEXT,
    "licenseNo" TEXT,
    "licenseExpiry" DATE,
    "rfidTag" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverAssignment" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "fromTime" TIMESTAMPTZ(3) NOT NULL,
    "toTime" TIMESTAMPTZ(3),
    "source" TEXT NOT NULL,
    "createdById" UUID,

    CONSTRAINT "DriverAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Driver_companyId_rfidTag_key" ON "Driver"("companyId", "rfidTag");
CREATE UNIQUE INDEX "Driver_companyId_employeeId_key" ON "Driver"("companyId", "employeeId");
CREATE INDEX "Driver_companyId_name_idx" ON "Driver"("companyId", "name");
CREATE INDEX "DriverAssignment_objectId_fromTime_idx" ON "DriverAssignment"("objectId", "fromTime" DESC);
CREATE INDEX "DriverAssignment_driverId_fromTime_idx" ON "DriverAssignment"("driverId", "fromTime" DESC);
CREATE INDEX "DriverAssignment_companyId_fromTime_idx" ON "DriverAssignment"("companyId", "fromTime" DESC);

-- One open session per vehicle and per driver.
CREATE UNIQUE INDEX "DriverAssignment_open_object_key" ON "DriverAssignment"("objectId") WHERE "toTime" IS NULL;
CREATE UNIQUE INDEX "DriverAssignment_open_driver_key" ON "DriverAssignment"("driverId") WHERE "toTime" IS NULL;

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DriverAssignment" ADD CONSTRAINT "DriverAssignment_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DriverAssignment" ADD CONSTRAINT "DriverAssignment_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
