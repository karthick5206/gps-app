-- CreateTable
CREATE TABLE "Poi" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "branchId" UUID,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "address" TEXT,
    "radiusM" INTEGER NOT NULL DEFAULT 100,
    "icon" TEXT,
    "color" TEXT NOT NULL DEFAULT '#2563eb',
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Poi_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Poi_companyId_isActive_idx" ON "Poi"("companyId", "isActive");
CREATE INDEX "Poi_companyId_lat_lng_idx" ON "Poi"("companyId", "lat", "lng");

-- AddForeignKey
ALTER TABLE "Poi" ADD CONSTRAINT "Poi_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Poi" ADD CONSTRAINT "Poi_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Built-in roles get the new "pois" menu: Admin / Manager everything, User view only.
INSERT INTO "RolePermission" ("roleId", "menu", "actions")
SELECT r."id", 'pois',
       CASE WHEN r."name" IN ('Admin', 'Manager') THEN ARRAY['view', 'create', 'edit', 'delete', 'export'] ELSE ARRAY['view'] END
FROM "Role" r
WHERE r."isSystem" = true
  AND r."name" IN ('Admin', 'Manager', 'User')
ON CONFLICT ("roleId", "menu") DO NOTHING;

-- System POI_CATEGORY lookups (the seed keeps them up to date afterwards).
INSERT INTO "Lookup" ("id", "companyId", "type", "code", "label", "sortOrder", "isActive", "createdAt", "updatedAt")
SELECT md5(random()::text || clock_timestamp()::text || v.code)::uuid, NULL, 'POI_CATEGORY', v.code, v.label, v.sort, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (VALUES
  ('CUSTOMER', 'Customer', 10),
  ('DEPOT', 'Depot', 20),
  ('FUEL_STATION', 'Fuel station', 30),
  ('SERVICE_CENTER', 'Service center', 40),
  ('HOSPITAL', 'Hospital', 50),
  ('SCHOOL', 'School', 60),
  ('TOLL', 'Toll', 70),
  ('PARKING', 'Parking', 80),
  ('OTHER', 'Other', 90)
) AS v(code, label, sort)
WHERE NOT EXISTS (SELECT 1 FROM "Lookup" l WHERE l."companyId" IS NULL AND l."type" = 'POI_CATEGORY' AND l."code" = v.code);
