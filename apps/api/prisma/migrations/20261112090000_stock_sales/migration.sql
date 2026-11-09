-- Stock & sales: items, special prices, suppliers / stores of the sales flow (StockSupplier, StockStore), documents (PO,
-- receipt, returns, orders, sales, adjustments), IMEI / SIM serials, ledger, files, sales invoices / credit notes, numbering.
-- Separate from the inventory module tables (StockLocation, Supplier, StockReceipt, DeviceStock, StockMovement).
-- AlterTable
ALTER TABLE "PlatformBillingSettings" ADD COLUMN     "stockCreditNotePrefix" TEXT NOT NULL DEFAULT 'VTX/SCN',
ADD COLUMN     "stockInvoicePrefix" TEXT NOT NULL DEFAULT 'VTX/S';

-- CreateTable
CREATE TABLE "StockItem" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "deviceModelId" UUID,
    "sku" TEXT,
    "hsnCode" TEXT NOT NULL DEFAULT '',
    "gstRatePct" DOUBLE PRECISION NOT NULL DEFAULT 18,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "serialTracked" BOOLEAN NOT NULL DEFAULT false,
    "salePricePaise" INTEGER NOT NULL DEFAULT 0,
    "purchasePricePaise" INTEGER NOT NULL DEFAULT 0,
    "lowStockAt" INTEGER,
    "reorderQty" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockPrice" (
    "id" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "partnerId" UUID,
    "companyId" UUID,
    "pricePaise" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockSupplier" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "gstin" TEXT,
    "stateCode" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "pin" TEXT NOT NULL DEFAULT '',
    "contactName" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "leadTimeDays" INTEGER NOT NULL DEFAULT 7,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockSupplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockStore" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "partnerId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockStore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockDoc" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "fy" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "docDate" TEXT NOT NULL,
    "partnerId" UUID,
    "supplierId" UUID,
    "toPlatform" BOOLEAN NOT NULL DEFAULT false,
    "saleTo" TEXT,
    "customerCompanyId" UUID,
    "customerPartnerId" UUID,
    "customerName" TEXT NOT NULL DEFAULT '',
    "customerPhone" TEXT NOT NULL DEFAULT '',
    "customerEmail" TEXT NOT NULL DEFAULT '',
    "customerGstin" TEXT,
    "customerStateCode" TEXT NOT NULL DEFAULT '',
    "customerAddress" TEXT NOT NULL DEFAULT '',
    "locationId" UUID,
    "sourceId" UUID,
    "channel" TEXT,
    "supplierInvoiceNo" TEXT NOT NULL DEFAULT '',
    "supplierInvoiceDate" TEXT,
    "supplierInvoiceAmountPaise" INTEGER,
    "reason" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "totalPaise" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockDoc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockDocLine" (
    "id" UUID NOT NULL,
    "docId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "ratePaise" INTEGER NOT NULL DEFAULT 0,
    "gstRatePct" DOUBLE PRECISION NOT NULL DEFAULT 18,
    "serials" TEXT[],
    "condition" TEXT NOT NULL DEFAULT 'OK',
    "note" TEXT NOT NULL DEFAULT '',
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "StockDocLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockSerial" (
    "id" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "serial" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "locationId" UUID,
    "customerCompanyId" UUID,
    "customerPartnerId" UUID,
    "lastDocId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockSerial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMove" (
    "id" UUID NOT NULL,
    "docId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "locationId" UUID,
    "qty" INTEGER NOT NULL,
    "serial" TEXT,
    "effect" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMove_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockFile" (
    "id" UUID NOT NULL,
    "docId" UUID NOT NULL,
    "fileName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "uploadedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockInvoice" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "fy" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "docId" UUID NOT NULL,
    "invoiceId" UUID,
    "supplier" JSONB NOT NULL,
    "buyer" JSONB NOT NULL,
    "lines" JSONB NOT NULL,
    "taxKind" TEXT NOT NULL,
    "taxablePaise" INTEGER NOT NULL,
    "cgstPaise" INTEGER NOT NULL,
    "sgstPaise" INTEGER NOT NULL,
    "utgstPaise" INTEGER NOT NULL,
    "igstPaise" INTEGER NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "paymentStatus" TEXT NOT NULL DEFAULT 'UNPAID',
    "paidPaise" INTEGER NOT NULL DEFAULT 0,
    "paymentMode" TEXT,
    "paymentReference" TEXT,
    "paidAt" TIMESTAMPTZ(3),
    "pdfFile" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCounter" (
    "key" TEXT NOT NULL,
    "lastSeq" INTEGER NOT NULL,

    CONSTRAINT "StockCounter_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "StockItem_name_key" ON "StockItem"("name");

-- CreateIndex
CREATE INDEX "StockPrice_itemId_idx" ON "StockPrice"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "StockSupplier_name_key" ON "StockSupplier"("name");

-- CreateIndex
CREATE UNIQUE INDEX "StockStore_name_key" ON "StockStore"("name");

-- CreateIndex
CREATE UNIQUE INDEX "StockStore_partnerId_key" ON "StockStore"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "StockDoc_number_key" ON "StockDoc"("number");

-- CreateIndex
CREATE INDEX "StockDoc_kind_docDate_idx" ON "StockDoc"("kind", "docDate" DESC);

-- CreateIndex
CREATE INDEX "StockDoc_partnerId_idx" ON "StockDoc"("partnerId");

-- CreateIndex
CREATE INDEX "StockDoc_sourceId_idx" ON "StockDoc"("sourceId");

-- CreateIndex
CREATE INDEX "StockDocLine_docId_idx" ON "StockDocLine"("docId");

-- CreateIndex
CREATE INDEX "StockSerial_serial_idx" ON "StockSerial"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "StockSerial_itemId_serial_key" ON "StockSerial"("itemId", "serial");

-- CreateIndex
CREATE INDEX "StockMove_itemId_locationId_idx" ON "StockMove"("itemId", "locationId");

-- CreateIndex
CREATE INDEX "StockMove_serial_idx" ON "StockMove"("serial");

-- CreateIndex
CREATE INDEX "StockMove_docId_idx" ON "StockMove"("docId");

-- CreateIndex
CREATE UNIQUE INDEX "StockInvoice_number_key" ON "StockInvoice"("number");

-- CreateIndex
CREATE UNIQUE INDEX "StockInvoice_docId_key" ON "StockInvoice"("docId");

-- AddForeignKey
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_deviceModelId_fkey" FOREIGN KEY ("deviceModelId") REFERENCES "DeviceModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockPrice" ADD CONSTRAINT "StockPrice_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "StockItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockDoc" ADD CONSTRAINT "StockDoc_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "StockSupplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockDocLine" ADD CONSTRAINT "StockDocLine_docId_fkey" FOREIGN KEY ("docId") REFERENCES "StockDoc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockDocLine" ADD CONSTRAINT "StockDocLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "StockItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockSerial" ADD CONSTRAINT "StockSerial_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "StockItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_docId_fkey" FOREIGN KEY ("docId") REFERENCES "StockDoc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockFile" ADD CONSTRAINT "StockFile_docId_fkey" FOREIGN KEY ("docId") REFERENCES "StockDoc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

