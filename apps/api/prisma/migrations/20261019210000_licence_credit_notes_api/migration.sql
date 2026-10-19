-- AlterTable
ALTER TABLE "PlatformBillingSettings" ADD COLUMN     "apiPlans" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "creditNotePrefix" TEXT NOT NULL DEFAULT 'VTX/CN';

-- AlterTable
ALTER TABLE "LicenceSeat" ADD COLUMN     "apiPlan" TEXT;

-- CreateTable
CREATE TABLE "CreditNote" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "fy" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL,
    "invoiceId" UUID NOT NULL,
    "companyId" UUID,
    "partnerId" UUID,
    "buyerName" TEXT NOT NULL,
    "buyerGstin" TEXT,
    "buyerStateCode" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "taxKind" TEXT NOT NULL,
    "gstRatePct" DOUBLE PRECISION NOT NULL,
    "taxablePaise" INTEGER NOT NULL,
    "cgstPaise" INTEGER NOT NULL,
    "sgstPaise" INTEGER NOT NULL,
    "utgstPaise" INTEGER NOT NULL,
    "igstPaise" INTEGER NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "refundMode" TEXT NOT NULL,
    "refundReference" TEXT,
    "keepSeatsActive" BOOLEAN NOT NULL DEFAULT false,
    "revokedSeatIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pdfFile" TEXT,
    "emailedAt" TIMESTAMPTZ(3),
    "emailError" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditNoteCounter" (
    "fy" TEXT NOT NULL,
    "lastSeq" INTEGER NOT NULL,

    CONSTRAINT "CreditNoteCounter_pkey" PRIMARY KEY ("fy")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_number_key" ON "CreditNote"("number");

-- CreateIndex
CREATE INDEX "CreditNote_invoiceId_idx" ON "CreditNote"("invoiceId");

-- CreateIndex
CREATE INDEX "CreditNote_issuedAt_idx" ON "CreditNote"("issuedAt");

-- CreateIndex
CREATE INDEX "CreditNote_companyId_issuedAt_idx" ON "CreditNote"("companyId", "issuedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_fy_seq_key" ON "CreditNote"("fy", "seq");

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Data ──
-- Developer API licence: existing companies get no free API seat, except those that already created API keys — they
-- get a Basic plan seat for 12 months (source MIGRATION) so their integrations keep working. Platform companies are
-- exempt from licensing. Mirrors apiMigrationSeatDue() in src/licences/api-access.ts.
INSERT INTO "LicenceSeat" ("id", "type", "companyId", "source", "activatedAt", "expiresAt", "apiPlan", "note", "updatedAt")
SELECT gen_random_uuid(), 'API_ACCESS', c."id", 'MIGRATION', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 year', 'BASIC',
       'Complimentary Basic plan (existing API keys at launch)', CURRENT_TIMESTAMP
FROM "Company" c
WHERE c."isPlatform" = false
  AND EXISTS (SELECT 1 FROM "ApiKey" k WHERE k."companyId" = c."id")
  AND NOT EXISTS (SELECT 1 FROM "LicenceSeat" s WHERE s."companyId" = c."id" AND s."type" = 'API_ACCESS');
