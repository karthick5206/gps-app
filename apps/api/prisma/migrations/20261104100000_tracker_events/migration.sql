-- Why tracker phones stopped and started, as reported by the app.
CREATE TABLE "TrackerEvent" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "why" TEXT NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackerEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrackerEvent_deviceId_at_kind_key" ON "TrackerEvent"("deviceId", "at", "kind");

ALTER TABLE "TrackerEvent" ADD CONSTRAINT "TrackerEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The company requires tracking on this phone.
ALTER TABLE "Device" ADD COLUMN "trackingRequired" BOOLEAN NOT NULL DEFAULT false;
