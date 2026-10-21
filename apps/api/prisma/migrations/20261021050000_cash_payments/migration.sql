-- Customer payments to confirm: cash as well as UPI.
ALTER TABLE "UpiPaymentClaim" ADD COLUMN "method" TEXT NOT NULL DEFAULT 'UPI';
ALTER TABLE "UpiPaymentClaim" ADD COLUMN "customerNote" TEXT;
ALTER TABLE "UpiPaymentClaim" ALTER COLUMN "utr" DROP NOT NULL;
