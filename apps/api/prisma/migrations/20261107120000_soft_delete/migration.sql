-- Soft delete: "Delete" hides and keeps rows (restorable); "Delete permanently" still removes them.
ALTER TABLE "Company" ADD COLUMN "deletedAt" TIMESTAMPTZ(3), ADD COLUMN "deletedById" UUID, ADD COLUMN "deletedInfo" JSONB;
ALTER TABLE "Branch" ADD COLUMN "deletedAt" TIMESTAMPTZ(3), ADD COLUMN "deletedById" UUID, ADD COLUMN "deletedInfo" JSONB;
ALTER TABLE "User" ADD COLUMN "deletedAt" TIMESTAMPTZ(3), ADD COLUMN "deletedById" UUID, ADD COLUMN "deletedInfo" JSONB;
ALTER TABLE "Device" ADD COLUMN "deletedAt" TIMESTAMPTZ(3), ADD COLUMN "deletedById" UUID, ADD COLUMN "deletedInfo" JSONB;
ALTER TABLE "TrackedObject" ADD COLUMN "deletedAt" TIMESTAMPTZ(3), ADD COLUMN "deletedById" UUID, ADD COLUMN "deletedInfo" JSONB;
ALTER TABLE "Driver" ADD COLUMN "deletedAt" TIMESTAMPTZ(3), ADD COLUMN "deletedById" UUID, ADD COLUMN "deletedInfo" JSONB;
ALTER TABLE "VehicleGroup" ADD COLUMN "deletedAt" TIMESTAMPTZ(3), ADD COLUMN "deletedById" UUID, ADD COLUMN "deletedInfo" JSONB;
ALTER TABLE "Geofence" ADD COLUMN "deletedAt" TIMESTAMPTZ(3), ADD COLUMN "deletedById" UUID, ADD COLUMN "deletedInfo" JSONB;
ALTER TABLE "Poi" ADD COLUMN "deletedAt" TIMESTAMPTZ(3), ADD COLUMN "deletedById" UUID, ADD COLUMN "deletedInfo" JSONB;
