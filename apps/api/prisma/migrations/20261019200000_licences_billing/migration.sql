-- CreateEnum
CREATE TYPE "LicenceType" AS ENUM ('USER', 'GPS_DEVICE', 'DASHCAM', 'FUEL_SENSOR');

-- AlterTable
ALTER TABLE "Partner" ADD COLUMN     "homeCompanyId" UUID,
ADD COLUMN     "pricesPaise" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "PlatformBillingSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "pricesPaise" JSONB NOT NULL DEFAULT '{}',
    "gstRatePct" DOUBLE PRECISION NOT NULL DEFAULT 18,
    "graceDays" INTEGER NOT NULL DEFAULT 15,
    "overrideDays" INTEGER NOT NULL DEFAULT 30,
    "legalName" TEXT NOT NULL DEFAULT '',
    "addressLines" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "city" TEXT NOT NULL DEFAULT '',
    "stateCode" TEXT NOT NULL DEFAULT '33',
    "pin" TEXT NOT NULL DEFAULT '',
    "gstin" TEXT NOT NULL DEFAULT '',
    "pan" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "website" TEXT NOT NULL DEFAULT '',
    "accountsEmail" TEXT NOT NULL DEFAULT '',
    "logoFile" TEXT,
    "sacCode" TEXT NOT NULL DEFAULT '998314',
    "invoicePrefix" TEXT NOT NULL DEFAULT 'VTX',
    "bankName" TEXT NOT NULL DEFAULT '',
    "bankAccountName" TEXT NOT NULL DEFAULT '',
    "bankAccountNo" TEXT NOT NULL DEFAULT '',
    "bankIfsc" TEXT NOT NULL DEFAULT '',
    "bankBranch" TEXT NOT NULL DEFAULT '',
    "upiId" TEXT NOT NULL DEFAULT '',
    "terms" TEXT NOT NULL DEFAULT '',
    "footerNote" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PlatformBillingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingProfile" (
    "id" UUID NOT NULL,
    "companyId" UUID,
    "partnerId" UUID,
    "billingName" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL DEFAULT '',
    "stateCode" TEXT NOT NULL,
    "pin" TEXT NOT NULL DEFAULT '',
    "gstin" TEXT,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BillingProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LicenceSeat" (
    "id" UUID NOT NULL,
    "type" "LicenceType" NOT NULL,
    "companyId" UUID,
    "partnerId" UUID,
    "source" TEXT NOT NULL,
    "activatedAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "userId" UUID,
    "deviceId" UUID,
    "fuelObjectId" UUID,
    "assignedAt" TIMESTAMPTZ(3),
    "note" TEXT,
    "notifiedState" TEXT,
    "lastOrderId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LicenceSeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LicenceOrder" (
    "id" UUID NOT NULL,
    "companyId" UUID,
    "partnerId" UUID,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "mode" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "razorpayOrderId" TEXT,
    "razorpayPaymentId" TEXT,
    "paymentReference" TEXT,
    "paidAt" TIMESTAMPTZ(3),
    "failureReason" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LicenceOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "fy" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL,
    "orderId" UUID NOT NULL,
    "companyId" UUID,
    "partnerId" UUID,
    "buyerName" TEXT NOT NULL,
    "buyerGstin" TEXT,
    "buyerStateCode" TEXT NOT NULL,
    "supplier" JSONB NOT NULL,
    "buyer" JSONB NOT NULL,
    "lines" JSONB NOT NULL,
    "taxKind" TEXT NOT NULL,
    "gstRatePct" DOUBLE PRECISION NOT NULL,
    "sacCode" TEXT NOT NULL,
    "taxablePaise" INTEGER NOT NULL,
    "cgstPaise" INTEGER NOT NULL,
    "sgstPaise" INTEGER NOT NULL,
    "utgstPaise" INTEGER NOT NULL,
    "igstPaise" INTEGER NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "paymentMode" TEXT NOT NULL,
    "paymentReference" TEXT,
    "paidAt" TIMESTAMPTZ(3) NOT NULL,
    "pdfFile" TEXT,
    "emailedAt" TIMESTAMPTZ(3),
    "emailError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceCounter" (
    "fy" TEXT NOT NULL,
    "lastSeq" INTEGER NOT NULL,

    CONSTRAINT "InvoiceCounter_pkey" PRIMARY KEY ("fy")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingProfile_companyId_key" ON "BillingProfile"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingProfile_partnerId_key" ON "BillingProfile"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "LicenceSeat_userId_key" ON "LicenceSeat"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LicenceSeat_deviceId_key" ON "LicenceSeat"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "LicenceSeat_fuelObjectId_key" ON "LicenceSeat"("fuelObjectId");

-- CreateIndex
CREATE INDEX "LicenceSeat_companyId_type_expiresAt_idx" ON "LicenceSeat"("companyId", "type", "expiresAt");

-- CreateIndex
CREATE INDEX "LicenceSeat_partnerId_type_idx" ON "LicenceSeat"("partnerId", "type");

-- CreateIndex
CREATE INDEX "LicenceSeat_expiresAt_idx" ON "LicenceSeat"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "LicenceOrder_razorpayOrderId_key" ON "LicenceOrder"("razorpayOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "LicenceOrder_razorpayPaymentId_key" ON "LicenceOrder"("razorpayPaymentId");

-- CreateIndex
CREATE INDEX "LicenceOrder_companyId_createdAt_idx" ON "LicenceOrder"("companyId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "LicenceOrder_partnerId_createdAt_idx" ON "LicenceOrder"("partnerId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_orderId_key" ON "Invoice"("orderId");

-- CreateIndex
CREATE INDEX "Invoice_issuedAt_idx" ON "Invoice"("issuedAt");

-- CreateIndex
CREATE INDEX "Invoice_companyId_issuedAt_idx" ON "Invoice"("companyId", "issuedAt" DESC);

-- CreateIndex
CREATE INDEX "Invoice_partnerId_issuedAt_idx" ON "Invoice"("partnerId", "issuedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_fy_seq_key" ON "Invoice"("fy", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "Partner_homeCompanyId_key" ON "Partner"("homeCompanyId");

-- AddForeignKey
ALTER TABLE "BillingProfile" ADD CONSTRAINT "BillingProfile_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingProfile" ADD CONSTRAINT "BillingProfile_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LicenceSeat" ADD CONSTRAINT "LicenceSeat_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LicenceSeat" ADD CONSTRAINT "LicenceSeat_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LicenceSeat" ADD CONSTRAINT "LicenceSeat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LicenceSeat" ADD CONSTRAINT "LicenceSeat_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LicenceSeat" ADD CONSTRAINT "LicenceSeat_fuelObjectId_fkey" FOREIGN KEY ("fuelObjectId") REFERENCES "FuelConfig"("objectId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LicenceOrder" ADD CONSTRAINT "LicenceOrder_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LicenceOrder" ADD CONSTRAINT "LicenceOrder_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "LicenceOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Data ──

-- The built-in Admin role gets the new "billing" (Billing & Licences) menu.
INSERT INTO "RolePermission" ("roleId", "menu", "actions")
SELECT r."id", 'billing', ARRAY['view', 'create', 'edit']
FROM "Role" r
WHERE r."isSystem" = true
  AND r."name" = 'Admin'
ON CONFLICT ("roleId", "menu") DO NOTHING;

-- Supplier (invoicing) defaults; never overwrites an existing row.
INSERT INTO "PlatformBillingSettings" ("id", "pricesPaise", "legalName", "addressLines", "city", "stateCode", "pin", "gstin", "pan", "updatedAt")
VALUES (
  'default',
  '{"USER": 0, "GPS_DEVICE": 0, "DASHCAM": 0, "FUEL_SENSOR": 0}',
  'VIBHAV ENTERPRISE SOLUTIONS',
  ARRAY['No. 7, Ragavendra Nagar Extension', 'Rajeshwari Salai, Lakshmi Narasimhan Road', 'Perungulathur'],
  '',
  '33',
  '600063',
  '33ANRPP5546L1ZB',
  'ANRPP5546L',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;

-- Existing users / devices / fuel sensors keep working: a complimentary seat each, valid 12 months from deploy.
-- Platform companies are exempt from licensing (no seats needed).
INSERT INTO "LicenceSeat" ("id", "type", "companyId", "source", "activatedAt", "expiresAt", "userId", "assignedAt", "note", "updatedAt")
SELECT gen_random_uuid(), 'USER', u."companyId", 'MIGRATION', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 year', u."id", CURRENT_TIMESTAMP, 'Complimentary (existing user at launch)', CURRENT_TIMESTAMP
FROM "User" u
JOIN "Company" c ON c."id" = u."companyId"
WHERE u."isActive" = true AND u."isSuperAdmin" = false AND c."isPlatform" = false;

INSERT INTO "LicenceSeat" ("id", "type", "companyId", "source", "activatedAt", "expiresAt", "deviceId", "assignedAt", "note", "updatedAt")
SELECT gen_random_uuid(),
       CASE WHEN m."capabilities" && ARRAY['video', 'adas', 'dms'] THEN 'DASHCAM'::"LicenceType" ELSE 'GPS_DEVICE'::"LicenceType" END,
       d."companyId", 'MIGRATION', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 year', d."id", CURRENT_TIMESTAMP, 'Complimentary (existing device at launch)', CURRENT_TIMESTAMP
FROM "Device" d
JOIN "DeviceModel" m ON m."id" = d."modelId"
JOIN "Company" c ON c."id" = d."companyId"
WHERE d."isActive" = true AND c."isPlatform" = false;

INSERT INTO "LicenceSeat" ("id", "type", "companyId", "source", "activatedAt", "expiresAt", "fuelObjectId", "assignedAt", "note", "updatedAt")
SELECT gen_random_uuid(), 'FUEL_SENSOR', f."companyId", 'MIGRATION', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 year', f."objectId", CURRENT_TIMESTAMP, 'Complimentary (existing fuel sensor at launch)', CURRENT_TIMESTAMP
FROM "FuelConfig" f
JOIN "Company" c ON c."id" = f."companyId"
WHERE f."source" <> 'none' AND c."isPlatform" = false;
