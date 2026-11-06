-- Attendance: other-branch work sites, travel between sites, daily break allowance.
ALTER TABLE "AttendanceSettings" ADD COLUMN "otherBranchSites" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "AttendanceSettings" ADD COLUMN "travelMaxMin" INTEGER NOT NULL DEFAULT 120;
ALTER TABLE "AttendanceSettings" ADD COLUMN "breakMin" INTEGER NOT NULL DEFAULT 45;
