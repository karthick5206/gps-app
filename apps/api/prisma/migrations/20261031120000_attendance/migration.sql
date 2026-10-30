CREATE TABLE "AttendanceSettings" (
    "companyId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "geofenceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "objectIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "days" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5, 6]::INTEGER[],
    "startMin" INTEGER NOT NULL DEFAULT 570,
    "endMin" INTEGER NOT NULL DEFAULT 1110,
    "graceMin" INTEGER NOT NULL DEFAULT 15,
    "updatedById" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "AttendanceSettings_pkey" PRIMARY KEY ("companyId")
);
