-- Scheduled reports: keep the report options (alert types, halt minutes, over-speed duration...) per report type.
-- Additive: existing schedules get {} and keep running with the API defaults exactly as before.
ALTER TABLE "ReportSchedule" ADD COLUMN "options" JSONB NOT NULL DEFAULT '{}';
