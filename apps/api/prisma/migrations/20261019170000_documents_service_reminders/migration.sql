-- AlterTable
ALTER TABLE "Driver" ADD COLUMN "licenseNotifiedState" TEXT;

-- CreateTable
CREATE TABLE "Document" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "objectId" UUID,
    "driverId" UUID,
    "type" TEXT NOT NULL,
    "number" TEXT,
    "issuedOn" DATE,
    "expiresOn" DATE,
    "reminderDays" INTEGER NOT NULL DEFAULT 30,
    "notes" TEXT,
    "fileName" TEXT,
    "filePath" TEXT,
    "fileType" TEXT,
    "fileSize" INTEGER,
    "notifiedState" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id"),
    -- A document belongs to exactly one vehicle or one driver.
    CONSTRAINT "Document_owner_check" CHECK (("objectId" IS NULL) <> ("driverId" IS NULL))
);

-- CreateTable
CREATE TABLE "ServiceReminder" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "intervalKm" INTEGER,
    "intervalDays" INTEGER,
    "lastDoneAt" DATE,
    "lastDoneOdometerKm" DOUBLE PRECISION,
    "dueAt" DATE,
    "dueOdometerKm" DOUBLE PRECISION,
    "notifyBeforeKm" INTEGER NOT NULL DEFAULT 500,
    "notifyBeforeDays" INTEGER NOT NULL DEFAULT 7,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notifiedState" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ServiceReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceRecord" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "reminderId" UUID,
    "title" TEXT NOT NULL,
    "doneAt" DATE NOT NULL,
    "odometerKm" DOUBLE PRECISION,
    "cost" DOUBLE PRECISION,
    "notes" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Document_companyId_expiresOn_idx" ON "Document"("companyId", "expiresOn");
CREATE INDEX "Document_objectId_idx" ON "Document"("objectId");
CREATE INDEX "Document_driverId_idx" ON "Document"("driverId");
CREATE INDEX "ServiceReminder_companyId_idx" ON "ServiceReminder"("companyId");
CREATE INDEX "ServiceReminder_objectId_idx" ON "ServiceReminder"("objectId");
CREATE INDEX "ServiceRecord_objectId_doneAt_idx" ON "ServiceRecord"("objectId", "doneAt" DESC);
CREATE INDEX "ServiceRecord_reminderId_idx" ON "ServiceRecord"("reminderId");
CREATE INDEX "ServiceRecord_companyId_doneAt_idx" ON "ServiceRecord"("companyId", "doneAt" DESC);

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Document" ADD CONSTRAINT "Document_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Document" ADD CONSTRAINT "Document_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceReminder" ADD CONSTRAINT "ServiceReminder_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceRecord" ADD CONSTRAINT "ServiceRecord_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceRecord" ADD CONSTRAINT "ServiceRecord_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "ServiceReminder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Built-in roles get the new "documents" menu: Admin / Manager everything, User view only.
INSERT INTO "RolePermission" ("roleId", "menu", "actions")
SELECT r."id", 'documents',
       CASE WHEN r."name" IN ('Admin', 'Manager') THEN ARRAY['view', 'create', 'edit', 'delete', 'export'] ELSE ARRAY['view'] END
FROM "Role" r
WHERE r."isSystem" = true
  AND r."name" IN ('Admin', 'Manager', 'User')
ON CONFLICT ("roleId", "menu") DO NOTHING;
