-- Location photo notes ("memory pins"). Additive only: two NEW tables and the new menu `photo_notes` granted to the
-- built-in roles (RolePermission rows, ON CONFLICT DO NOTHING; an existing row wins).
-- * GeoPhotoNote: company / object / uploader, time, coordinates, reverse-geocoded address, category, note, optional
--   amount, source, clientId (idempotency, unique per company), expenseId (logical), soft delete.
-- * GeoPhotoNotePhoto: the stored photos (re-encoded JPEG + thumbnail paths under var/photo-notes).
-- Personal data: rows cascade with the object (person) and the uploader user on a purge; Company is RESTRICT and is
-- walked by the company purge. Files are removed by the retention job (soft-deleted notes and orphaned folders).
--
-- ROLLBACK: redeploy the previous tag (the old code never reads these tables). Manual revert (owner decision only):
--   DELETE FROM "RolePermission" WHERE "menu" = 'photo_notes';
--   DROP TABLE "GeoPhotoNotePhoto"; DROP TABLE "GeoPhotoNote";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261201100000_geo_photo_notes';
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "GeoPhotoNote" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "objectId" UUID,
    "userId" UUID,
    "takenAt" TIMESTAMPTZ(3) NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracyM" DOUBLE PRECISION,
    "address" TEXT,
    "category" TEXT NOT NULL,
    "note" TEXT,
    "amountMinor" INTEGER,
    "currency" TEXT,
    "source" TEXT NOT NULL,
    "clientId" TEXT,
    "expenseId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "deletedById" UUID,

    CONSTRAINT "GeoPhotoNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeoPhotoNotePhoto" (
    "id" UUID NOT NULL,
    "noteId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "thumbPath" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeoPhotoNotePhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GeoPhotoNote_companyId_takenAt_idx" ON "GeoPhotoNote"("companyId", "takenAt" DESC);

-- CreateIndex
CREATE INDEX "GeoPhotoNote_objectId_takenAt_idx" ON "GeoPhotoNote"("objectId", "takenAt" DESC);

-- CreateIndex
CREATE INDEX "GeoPhotoNote_userId_takenAt_idx" ON "GeoPhotoNote"("userId", "takenAt" DESC);

-- CreateIndex
CREATE INDEX "GeoPhotoNote_deletedAt_idx" ON "GeoPhotoNote"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GeoPhotoNote_companyId_clientId_key" ON "GeoPhotoNote"("companyId", "clientId");

-- CreateIndex
CREATE INDEX "GeoPhotoNotePhoto_noteId_position_idx" ON "GeoPhotoNotePhoto"("noteId", "position");

-- AddForeignKey
ALTER TABLE "GeoPhotoNote" ADD CONSTRAINT "GeoPhotoNote_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeoPhotoNote" ADD CONSTRAINT "GeoPhotoNote_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeoPhotoNote" ADD CONSTRAINT "GeoPhotoNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeoPhotoNotePhoto" ADD CONSTRAINT "GeoPhotoNotePhoto_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "GeoPhotoNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Built-in roles get the new "photo_notes" menu: Admin / Manager every action, User view + create (own notes and those
-- of the objects in their scope).
INSERT INTO "RolePermission" ("roleId", "menu", "actions")
SELECT r."id", 'photo_notes',
       CASE WHEN r."name" IN ('Admin', 'Manager') THEN ARRAY['view', 'create', 'edit', 'delete', 'export'] ELSE ARRAY['view', 'create'] END
FROM "Role" r
WHERE r."isSystem" = true
  AND r."name" IN ('Admin', 'Manager', 'User')
ON CONFLICT ("roleId", "menu") DO NOTHING;
