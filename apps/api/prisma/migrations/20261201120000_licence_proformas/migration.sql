-- Pro-forma invoices (Super Admin, before payment). Additive.
CREATE TABLE "LicenceProforma" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "fy" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "companyId" UUID,
    "partnerId" UUID,
    "buyerName" TEXT NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL,
    "validUntil" TIMESTAMPTZ(3) NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "discountPaise" INTEGER NOT NULL DEFAULT 0,
    "request" JSONB NOT NULL,
    "snapshot" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "invoiceId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "LicenceProforma_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LicenceProforma_number_key" ON "LicenceProforma"("number");
CREATE UNIQUE INDEX "LicenceProforma_fy_seq_key" ON "LicenceProforma"("fy", "seq");
CREATE INDEX "LicenceProforma_companyId_issuedAt_idx" ON "LicenceProforma"("companyId", "issuedAt" DESC);
CREATE INDEX "LicenceProforma_partnerId_issuedAt_idx" ON "LicenceProforma"("partnerId", "issuedAt" DESC);
