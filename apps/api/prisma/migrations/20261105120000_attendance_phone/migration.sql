-- Attendance: the employee's answer about time outside, and the optional check-in selfie. Additive only.
ALTER TABLE "AttendanceSettings" ADD COLUMN "selfieRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AttendanceOuting"
    ADD COLUMN "employeeKind" TEXT,
    ADD COLUMN "employeeNote" TEXT,
    ADD COLUMN "employeeAt" TIMESTAMPTZ(3);

CREATE TABLE "AttendanceSelfie" (
    "companyId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "day" TEXT NOT NULL,
    "takenAt" TIMESTAMPTZ(3) NOT NULL,
    "path" TEXT NOT NULL,
    "type" TEXT NOT NULL,

    CONSTRAINT "AttendanceSelfie_pkey" PRIMARY KEY ("objectId", "day")
);
CREATE INDEX "AttendanceSelfie_takenAt_idx" ON "AttendanceSelfie"("takenAt");
ALTER TABLE "AttendanceSelfie" ADD CONSTRAINT "AttendanceSelfie_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
