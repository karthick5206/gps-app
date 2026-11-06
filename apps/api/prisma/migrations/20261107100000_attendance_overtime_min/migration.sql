-- Attendance: overtime on/off per company, and the minimum minutes past the shift end that count.
ALTER TABLE "AttendanceSettings" ADD COLUMN "overtimeOn" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "AttendanceSettings" ADD COLUMN "overtimeMinMin" INTEGER NOT NULL DEFAULT 15;
