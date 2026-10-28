-- Point quality analysis (History → All points): platform on/off switch, Super Admin only.
CREATE TABLE "PointQualitySettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PointQualitySettings_pkey" PRIMARY KEY ("id")
);
