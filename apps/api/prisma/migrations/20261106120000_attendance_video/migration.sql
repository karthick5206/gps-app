-- Check-in proof chosen by management: PHOTO, VIDEO (10 s) or PHOTO_AND_VIDEO.
ALTER TABLE "AttendanceSettings" ADD COLUMN "checkInProof" TEXT NOT NULL DEFAULT 'PHOTO';

-- The check-in video next to the photo, and the address burnt into the photo.
ALTER TABLE "AttendanceSelfie" ADD COLUMN "videoPath" TEXT;
ALTER TABLE "AttendanceSelfie" ADD COLUMN "videoType" TEXT;
ALTER TABLE "AttendanceSelfie" ADD COLUMN "videoAt" TIMESTAMPTZ(3);
ALTER TABLE "AttendanceSelfie" ADD COLUMN "address" TEXT;
