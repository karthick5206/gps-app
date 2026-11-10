-- Stock & sales → Stock & movements link (additive: three nullable columns, no data changed).
-- Rollback: ALTER TABLE "StockSupplier" DROP COLUMN "inventorySupplierId"; ALTER TABLE "StockStore" DROP COLUMN "inventoryLocationId"; ALTER TABLE "StockDoc" DROP COLUMN "inventoryReceiptId";
ALTER TABLE "StockSupplier" ADD COLUMN "inventorySupplierId" UUID;
ALTER TABLE "StockStore" ADD COLUMN "inventoryLocationId" UUID;
ALTER TABLE "StockDoc" ADD COLUMN "inventoryReceiptId" UUID;

CREATE UNIQUE INDEX "StockDoc_inventoryReceiptId_key" ON "StockDoc"("inventoryReceiptId");

ALTER TABLE "StockSupplier" ADD CONSTRAINT "StockSupplier_inventorySupplierId_fkey" FOREIGN KEY ("inventorySupplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockStore" ADD CONSTRAINT "StockStore_inventoryLocationId_fkey" FOREIGN KEY ("inventoryLocationId") REFERENCES "StockLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockDoc" ADD CONSTRAINT "StockDoc_inventoryReceiptId_fkey" FOREIGN KEY ("inventoryReceiptId") REFERENCES "StockReceipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
