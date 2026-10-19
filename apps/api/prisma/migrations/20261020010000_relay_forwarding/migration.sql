-- CreateEnum
CREATE TYPE "RelayTargetType" AS ENUM ('RAW_TCP', 'HTTP_JSON');

-- CreateEnum
CREATE TYPE "RelayScope" AS ENUM ('ALL', 'COMPANY', 'DEVICES', 'PROTOCOL');

-- CreateTable
CREATE TABLE "RelayTarget" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "RelayTargetType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "host" TEXT,
    "port" INTEGER,
    "passDownstream" BOOLEAN NOT NULL DEFAULT false,
    "url" TEXT,
    "authType" TEXT NOT NULL DEFAULT 'NONE',
    "authValue" TEXT,
    "secret" TEXT NOT NULL,
    "includeAlerts" BOOLEAN NOT NULL DEFAULT false,
    "scope" "RelayScope" NOT NULL DEFAULT 'ALL',
    "companyId" UUID,
    "deviceIds" UUID[],
    "protocol" TEXT,
    "liveOnly" BOOLEAN NOT NULL DEFAULT false,
    "validOnly" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RelayTarget_pkey" PRIMARY KEY ("id")
);

