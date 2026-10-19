-- CreateTable
CREATE TABLE "RelaySettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RelaySettings_pkey" PRIMARY KEY ("id")
);

