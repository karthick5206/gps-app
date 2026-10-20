-- UPI payments: uploaded QR image and customers' "I've paid" claims awaiting confirmation.
ALTER TABLE "PlatformBillingSettings" ADD COLUMN "upiQrFile" TEXT;

CREATE TABLE "UpiPaymentClaim" (
    "id" UUID NOT NULL,
    "ownerKind" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "purchase" JSONB NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "utr" TEXT NOT NULL,
    "paidOn" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" UUID,
    "note" TEXT,
    CONSTRAINT "UpiPaymentClaim_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "UpiPaymentClaim_status_createdAt_idx" ON "UpiPaymentClaim"("status", "createdAt" DESC);
CREATE INDEX "UpiPaymentClaim_ownerId_idx" ON "UpiPaymentClaim"("ownerId");
