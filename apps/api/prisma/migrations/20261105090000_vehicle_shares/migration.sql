-- A vehicle of one company shown, view only, to another. Additive only.
CREATE TABLE "VehicleShare" (
    "id" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "sharedWithId" UUID NOT NULL,
    "startAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endAt" TIMESTAMPTZ(3),
    "alertsOn" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VehicleShare_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VehicleShare_objectId_sharedWithId_key" ON "VehicleShare"("objectId", "sharedWithId");
CREATE INDEX "VehicleShare_sharedWithId_idx" ON "VehicleShare"("sharedWithId");
ALTER TABLE "VehicleShare" ADD CONSTRAINT "VehicleShare_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VehicleShare" ADD CONSTRAINT "VehicleShare_sharedWithId_fkey" FOREIGN KEY ("sharedWithId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
