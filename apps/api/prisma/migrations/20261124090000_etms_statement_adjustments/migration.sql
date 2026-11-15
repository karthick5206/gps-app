-- v1.16.13: manual adjustments on a vendor's monthly statement. Additive only.
CREATE TABLE "TransportStatementAdjustment" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "vendorId" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "objectId" UUID,
    "kind" TEXT NOT NULL,
    "days" DOUBLE PRECISION,
    "amount" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TransportStatementAdjustment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TransportStatementAdjustment_kind_check" CHECK ("kind" IN ('NOT_AVAILABLE','PENALTY','TOLL_PARKING','EXTRA','DEDUCTION'))
);
CREATE INDEX "TransportStatementAdjustment_companyId_vendorId_month_idx" ON "TransportStatementAdjustment"("companyId", "vendorId", "month");
ALTER TABLE "TransportStatementAdjustment" ADD CONSTRAINT "TransportStatementAdjustment_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "TransportVendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
