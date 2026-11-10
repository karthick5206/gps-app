-- Supplier payments against goods received notes (additive: one table, one column with a default).
-- Rollback: DROP TABLE "StockSupplierPayment"; ALTER TABLE "StockSupplier" DROP COLUMN "paymentTermsDays";
ALTER TABLE "StockSupplier" ADD COLUMN "paymentTermsDays" INTEGER NOT NULL DEFAULT 30;

CREATE TABLE "StockSupplierPayment" (
    "id" UUID NOT NULL,
    "docId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "paidOn" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "reference" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockSupplierPayment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StockSupplierPayment_docId_idx" ON "StockSupplierPayment"("docId");
CREATE INDEX "StockSupplierPayment_supplierId_paidOn_idx" ON "StockSupplierPayment"("supplierId", "paidOn");
ALTER TABLE "StockSupplierPayment" ADD CONSTRAINT "StockSupplierPayment_docId_fkey" FOREIGN KEY ("docId") REFERENCES "StockDoc"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockSupplierPayment" ADD CONSTRAINT "StockSupplierPayment_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "StockSupplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
