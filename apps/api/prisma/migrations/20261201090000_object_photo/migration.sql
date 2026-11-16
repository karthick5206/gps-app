-- Person / pet / asset photo on the tracked object (files under var/object-photos, served through the API only).
ALTER TABLE "TrackedObject" ADD COLUMN "photoPath" TEXT,
ADD COLUMN "photoThumbPath" TEXT,
ADD COLUMN "photoAt" TIMESTAMPTZ(3);
