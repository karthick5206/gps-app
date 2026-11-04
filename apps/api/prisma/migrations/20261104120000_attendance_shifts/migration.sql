-- Attendance: shifts per branch / person, limits, saved days and outing decisions. Additive only.
ALTER TABLE "AttendanceSettings"
    ADD COLUMN "shifts" JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN "shortExitMin" INTEGER NOT NULL DEFAULT 5,
    ADD COLUMN "noSignalMin" INTEGER NOT NULL DEFAULT 20,
    ADD COLUMN "halfDayMin" INTEGER NOT NULL DEFAULT 240,
    ADD COLUMN "fullDayMin" INTEGER NOT NULL DEFAULT 480,
    ADD COLUMN "outReminderMin" INTEGER NOT NULL DEFAULT 60,
    ADD COLUMN "anyBranchObjectIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Where the object was at each fence crossing.
ALTER TABLE "GeofenceVisit"
    ADD COLUMN "enterLat" DOUBLE PRECISION,
    ADD COLUMN "enterLng" DOUBLE PRECISION,
    ADD COLUMN "enterAccM" REAL,
    ADD COLUMN "exitLat" DOUBLE PRECISION,
    ADD COLUMN "exitLng" DOUBLE PRECISION,
    ADD COLUMN "exitAccM" REAL;

CREATE TABLE "AttendanceDay" (
    "companyId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "day" TEXT NOT NULL,
    "row" JSONB,
    "rules" JSONB,
    "overrideStatus" TEXT,
    "overrideNote" TEXT,
    "overrideById" UUID,
    "overrideAt" TIMESTAMPTZ(3),
    "savedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AttendanceDay_pkey" PRIMARY KEY ("objectId", "day")
);
CREATE INDEX "AttendanceDay_companyId_day_idx" ON "AttendanceDay"("companyId", "day");
ALTER TABLE "AttendanceDay" ADD CONSTRAINT "AttendanceDay_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AttendanceOuting" (
    "companyId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "leftAt" TIMESTAMPTZ(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AttendanceOuting_pkey" PRIMARY KEY ("objectId", "leftAt")
);
CREATE INDEX "AttendanceOuting_companyId_idx" ON "AttendanceOuting"("companyId");
ALTER TABLE "AttendanceOuting" ADD CONSTRAINT "AttendanceOuting_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
