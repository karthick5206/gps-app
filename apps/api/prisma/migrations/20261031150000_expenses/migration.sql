CREATE TABLE "Expense" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "objectId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "litres" DOUBLE PRECISION,
    "odometerKm" DOUBLE PRECISION,
    "vendor" TEXT,
    "note" TEXT,
    "photoPath" TEXT,
    "photoType" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Expense_objectId_at_idx" ON "Expense"("objectId", "at" DESC);
CREATE INDEX "Expense_companyId_at_idx" ON "Expense"("companyId", "at" DESC);
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "TrackedObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
