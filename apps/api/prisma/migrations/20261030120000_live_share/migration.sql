CREATE TABLE "LiveShare" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "companyId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "createdById" UUID,
    "note" TEXT,
    "hours" INTEGER NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LiveShare_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LiveShare_tokenHash_key" ON "LiveShare"("tokenHash");
CREATE INDEX "LiveShare_objectId_createdAt_idx" ON "LiveShare"("objectId", "createdAt" DESC);
CREATE INDEX "LiveShare_companyId_idx" ON "LiveShare"("companyId");
ALTER TABLE "LiveShare" ADD CONSTRAINT "LiveShare_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
