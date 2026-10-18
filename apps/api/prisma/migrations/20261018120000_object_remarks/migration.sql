-- CreateTable
CREATE TABLE "ObjectRemark" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "note" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ObjectRemark_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ObjectRemark_objectId_createdAt_idx" ON "ObjectRemark"("objectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ObjectRemark_companyId_createdAt_idx" ON "ObjectRemark"("companyId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "ObjectRemark" ADD CONSTRAINT "ObjectRemark_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

