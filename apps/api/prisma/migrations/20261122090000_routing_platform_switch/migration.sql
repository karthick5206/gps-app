-- v1.16.0 automatic route planning switch (owner decision 2026-11-13). Additive only: one new single-row table.
-- RoutingSettings ("default" row, Super Admin, Platform Settings -> Route planning): the platform switch. No row = OFF,
-- so the upgrade keeps routing off. Routing runs for a company only when this is on, the company's own
-- Company.settings.etms.autoRouting is on (JSON, no column) and ETMS_ROUTING in apps/api/.env is not "off".
SET lock_timeout = '5s';

CREATE TABLE "RoutingSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "RoutingSettings_pkey" PRIMARY KEY ("id")
);
