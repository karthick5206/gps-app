# Inventory Modules — Phase B: Device Inventory (backend)

**Branch:** `feature/inventory-phase-b` (from `feature/s0-safety` @ `a8f8710`). **Date:** 2026-11-09.
**Scope of this run:** B1 schema + migration, B2 shared types / permissions / state machine, B3 API module, B4 backfill design (dry run only), plus an optional read-only Super Admin list page.
**Spec:** [00 plan & dependency map](../00-phase-a-plan-and-dependency-map.md), [01 owner decisions](../01-owner-decisions.md), [02 role matrix](../../modernization/02-role-permission-matrix.md).

No production database was used. Migrations and the service tests ran against a new scratch database `veetrax_inv` (same local PostgreSQL, seeded with `SEED_DEMO=1`). `.env` was not edited; port 4000 was not used.

> Numbering note: the Phase A table numbered "B1 shared / B2 migration". This run follows the assignment numbering: **B1 = schema, B2 = shared**. Phase A's B4 (receive) and B5 (movements) are folded into B3 here. Phase A's B6 (hooks in existing flows), B7 (full web UI) and B8 (backfill apply) are still open; B8's design is delivered as B4 (dry run).

---

## 1. Implemented

| Item | What | Files |
|---|---|---|
| B1 schema | 5 new tables: `StockLocation`, `Supplier`, `StockReceipt`, `DeviceStock` (1:1 with `Device`), `StockMovement` (append-only ledger). Prisma back-relations on `Device`, `Company`, `Partner`, `TrackedObject` (no SQL change to those tables). | `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20261109090000_device_inventory/migration.sql` |
| B2 shared | `INVENTORY_STATUSES` (In stock, Reserved, Assigned, Active, Faulty, Under repair, Returned, Retired), `INVENTORY_TRANSITIONS` (allowed table), `REASON_REQUIRED_STATUSES`, `STOCK_MOVEMENT_KINDS`, `STOCK_LOCATION_KINDS`, `DEVICE_CONDITIONS`, `deriveDeviceStatus`, `checkStatusConsistency`, `validateStatusChange`, DTO types. New menu `sa_inventory` ("Stock & Movements", group platform, `superAdminOnly: true`). | `packages/shared/src/inventory.ts`, `packages/shared/src/permissions.ts`, `packages/shared/src/index.ts` |
| B3 API | `/api/inventory`: locations & suppliers CRUD, receipts (existing stock devices or new IMEIs), stock list / filter / paginate / CSV with read-only assignment + licence status, summary, status change, transfer, adjustment, sync with the existing assignment, movement history (per device and global, CSV), CSV import with dry-run report. | `apps/api/src/inventory/*` (`inventory.module.ts`, `inventory.controller.ts`, `inventory.dto.ts`, `inventory.mapper.ts`, `catalog.service.ts`, `stock.service.ts`, `stock-csv.ts`), `apps/api/src/app.module.ts` |
| Existing create path reuse | `AdminDevicesService.create` split into `prepareCreate` → `createInTx` → `afterCreate` (identical behaviour; `create` is exactly those three calls) so receipts register new IMEIs inside their own transaction through the Device Inventory path (IMEI normalisation, unique `Device.uniqueId`, model check, audit, cache invalidation). Exported from `MastersModule`. | `apps/api/src/masters/admin-devices/admin-devices.service.ts`, `apps/api/src/masters/masters.module.ts` |
| B4 backfill design | Pure `planBackfill` + `scripts/inventory-backfill-dry-run.ts` (read-only, refuses `--apply`). | `apps/api/src/inventory/backfill-plan.ts`, `apps/api/scripts/inventory-backfill-dry-run.ts` |
| Web (optional) | Read-only page *Platform → Stock & Movements* (list, status / location / mismatch filters, column chooser, CSV export via the existing master page). Route + icon registered (required by `Record<MenuKey,…>`). | `apps/web/src/features/platform/InventoryStockPage.tsx`, `apps/web/src/app/router.tsx`, `apps/web/src/features/shell/nav.ts` |

### 1.1 Design rules as implemented

- **Licence isolation.** Inventory code never writes `Device.companyId` / `Device.isActive`, never writes `DeviceAssignment`, and has no dependency on `SeatsService` / `PoolsService` / `prisma.licenceSeat`. New devices are created through `AdminDevicesService.createInTx` with an explicit field list (`uniqueId`, `modelId`, `simNumber`, `simOperator`, `firmware`) and `companyId: undefined, isActive: undefined`, so `ensureDevice` is never reached (it needs a company). A receipt refuses a device that is already in a customer account.
- **Customer assignment stays on existing flows.** Assign / move between companies = Device Inventory edit, Super Admin Transfer, customer Claim. Inventory only *records* it: `POST /inventory/stock/:id/sync` moves the stock status to the status implied by the assignment and writes a `SYNC` movement carrying `companyId`, `objectId` and `reference = DeviceAssignment:<id>`.
- **ASSIGNED / ACTIVE are derived.** `checkStatusConsistency`: IN_STOCK / RESERVED require no company; ASSIGNED requires a company and no open vehicle assignment; ACTIVE requires a company **and** an open `DeviceAssignment`. Applies to status changes, adjustments and sync. Inventory can therefore never mark a device Active that has no customer / vehicle. FAULTY / UNDER_REPAIR / RETURNED / RETIRED record facts only (no seat release, no deactivation; QI-13 / QI-15 stay open).
- **Mismatch flag.** Until B6 hooks exist, an admin flow can change the owner / vehicle after inventory recorded a status. Every stock row returns `derivedStatus` and `mismatch`; `?mismatch=true` filters them and `summary.mismatches` counts them.
- **Transitions.** `STATUS` follows `INVENTORY_TRANSITIONS`; `ADJUST` may skip the table (reason mandatory, ≥3 chars) but never the assignment rules; `SYNC` may only set the derived status. RETIRED is terminal except through an adjustment.
- **Reasons.** Required for FAULTY, RETURNED, RETIRED and every adjustment.
- **Ledger.** Every stock change (receipt, status, transfer, adjust, sync) writes one `StockMovement` in the same interactive transaction: who (`createdById`), when (`at`), from → to status / location / holder partner, linked company / object / receipt, reason, reference, note, and for adjustments a field diff (`changes`). Application code never updates or deletes movements. Concurrent edits are refused with 409 (optimistic guard on `DeviceStock.updatedAt`).
- **Duplicate IMEI.** Reuses `Device.uniqueId @unique` (pre-checked for a readable report; the DB constraint is the final guard). Serial numbers are unique (`DeviceStock.serialNumber @unique`, case-insensitive pre-check). Receipts are all-or-nothing.
- **Purge safety.** `DeviceStock` cascades with its device; every `StockMovement` link is `SET NULL` and `itemRef` keeps the IMEI, so the catalogue-driven purge leaves the ledger intact (tested).
- **Super Admin only.** `sa_inventory` is `superAdminOnly`, so `resolvePermissions` / `validateRolePermissions` never grant it to a tenant role and `SYSTEM_ROLES.Admin` excludes it (tested). No tenant menu was added (no role-sync rollout, R-I8). Partner views are Phase F.

---

## 2. Migration `20261109090000_device_inventory`

**Summary (additive only):**
- `CREATE TABLE` × 5: `StockLocation`, `Supplier`, `StockReceipt`, `DeviceStock`, `StockMovement` (UUID PKs, `timestamptz(3)`, money in paise, enum-like values as `TEXT` + shared constants).
- Indexes: `StockLocation(kind)`, UK `StockLocation(ownerPartnerId, code)` + partial UK `(code) WHERE ownerPartnerId IS NULL`; UK `Supplier(ownerPartnerId, name)` + partial UK `(name) WHERE ownerPartnerId IS NULL`; `StockReceipt(supplierId, receivedAt DESC)`, `(receivedAt DESC)`; UK `DeviceStock(serialNumber)`, `(status, locationId)`, `(holderPartnerId, status)`, `(receiptId)`; `StockMovement(deviceId, at DESC)`, `(at DESC)`, `(toLocationId, at DESC)`, `(fromLocationId, at DESC)`, `(companyId, at DESC)`, `(kind, at DESC)`.
- FKs: `DeviceStock.deviceId → Device` **CASCADE**; `DeviceStock.locationId → StockLocation` RESTRICT; `DeviceStock.holderPartnerId → Partner` SET NULL; `DeviceStock.receiptId → StockReceipt` SET NULL; `StockReceipt.locationId / supplierId` RESTRICT; `StockLocation / Supplier.ownerPartnerId → Partner` RESTRICT; all `StockMovement` FKs (`deviceId`, `fromLocationId`, `toLocationId`, `companyId`, `objectId`, `partnerId`, `receiptId`) **SET NULL**.
- `CHECK (unitCostPaise IS NULL OR unitCostPaise >= 0)`.
- No `ALTER` / `DROP` of any existing table, column, index or constraint. `prisma migrate diff` (DB → schema) after deploy is empty.

**Rollback (manual, owner-approved; discards inventory data only):**
```sql
BEGIN;
DROP TABLE "StockMovement", "DeviceStock", "StockReceipt", "Supplier", "StockLocation";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261109090000_device_inventory';
COMMIT;
```
Then revert the B1–B4 commits (the API module would fail without the tables). Existing tables are unaffected either way.

---

## 3. API contract

All routes are under `/api/inventory`, authenticated, and guarded by `@RequirePermission('sa_inventory', …)` (Super Admin only). `?format=csv` on list routes additionally requires `export` (existing guard rule). List routes accept the common `q`, `page`, `pageSize` (≤200), `sort`, `order`.

| Method | Path | Permission | Request | Response |
|---|---|---|---|---|
| GET | `/locations` | view | `kind?`, `status?` (ACTIVE/INACTIVE) | `Paginated<StockLocationDto>` / CSV |
| GET | `/locations/:id` | view | — | `StockLocationDto` |
| POST | `/locations` | create | `{ kind, code (1-20 [A-Za-z0-9_-]), name, address?, stateCode? (2 digits), isActive? }` | `StockLocationDto` (409 on duplicate code) |
| PATCH | `/locations/:id` | edit | partial of POST | `StockLocationDto` |
| DELETE | `/locations/:id` | delete | — | `{ ok: true }`; 409 when stock, receipts or movements reference it (deactivate instead) |
| GET | `/suppliers` | view | `status?` | `Paginated<SupplierDto>` / CSV |
| GET | `/suppliers/:id` | view | — | `SupplierDto` |
| POST | `/suppliers` | create | `{ name, gstin? (15), stateCode?, contact?: {k: v}, isActive? }` | `SupplierDto` |
| PATCH | `/suppliers/:id` | edit | partial of POST | `SupplierDto` |
| DELETE | `/suppliers/:id` | delete | — | `{ ok: true }`; 409 when a receipt references it |
| GET | `/receipts` | view | `supplierId?`, `locationId?` | `Paginated<StockReceiptDto>` |
| GET | `/receipts/:id` | view | — | `StockReceiptDto` |
| POST | `/receipts` | create | `{ locationId, supplierId?, supplierInvoiceNo?, supplierInvoiceAt? (YYYY-MM-DD), receivedAt?, note?, items: [{ deviceId? \| uniqueId + modelId?, simNumber?, simOperator?, firmware?, serialNumber?, unitCostPaise?, warrantyUntil?, condition?, note? }] (1–500) }` | `{ receipt: StockReceiptDto, created, received }`; 400 listing per-item errors (nothing written) |
| GET | `/import/template` | view | — | CSV header `imei,model,serial,unit_cost,warranty_until,condition,sim,operator,note` |
| POST | `/import` | create | `{ csv (≤100 kB, ≤500 rows), locationId, supplierId?, supplierInvoiceNo?, supplierInvoiceAt?, note?, dryRun? = true }` | `StockImportReport { dryRun, applied, receiptId, summary { rows, createDevice, addStock, errors }, rows [{ line, uniqueId, action, errors[] }] }`; apply is refused (`applied: false`) while any row has an error |
| GET | `/stock` | view | `stockStatus?`, `locationId?`, `holderPartnerId?`, `modelId?`, `supplierId?`, `receiptId?`, `companyId?`, `mismatch=true?` | `Paginated<DeviceStockDto>` / CSV. Each row: status, derivedStatus, mismatch, location, holder, receipt / supplier, serial, cost, warranty, condition + read-only company, vehicle, device active flag, licence `{ status: NOT_IN_ACCOUNT\|NO_SEAT\|ACTIVE\|EXPIRED, type, expiresAt }` |
| GET | `/stock/summary` | view | — | `StockSummaryDto { byStatus, byLocation, mismatches, untracked }` |
| GET | `/stock/:deviceId` | view | — | `DeviceStockDto` (404 when no stock record) |
| GET | `/stock/:deviceId/movements` | view | movement filters | `Paginated<StockMovementDto>` / CSV |
| POST | `/stock/:deviceId/status` | edit | `{ status, reason?, reference?, note?, toLocationId? }` | `DeviceStockDto`; 400 on a disallowed transition, missing reason or assignment conflict; 409 on concurrent change |
| POST | `/stock/:deviceId/transfer` | edit | `{ toLocationId?, holderPartnerId? (uuid \| null), reason?, reference?, note? }` | `DeviceStockDto`; 400 for ASSIGNED / ACTIVE devices (at the customer) or no change |
| POST | `/stock/:deviceId/adjust` | edit | `{ reason (required), status?, locationId?, holderPartnerId?, serialNumber?, unitCostPaise?, warrantyUntil?, condition?, note?, reference? }` | `DeviceStockDto`; movement stores the field diff |
| POST | `/stock/:deviceId/sync` | edit | `{ note? }` | `DeviceStockDto` (status := derived from the existing assignment) |
| GET | `/movements` | view | `kind?`, `deviceId?`, `locationId?` (from or to), `receiptId?`, `from?`, `to?` (ISO) | `Paginated<StockMovementDto>` / CSV |

---

## 4. Tests

| Suite | Kind | Tests |
|---|---|---|
| `inventory/inventory-status.spec.ts` | unit: transition table, derive, consistency, reasons, ADJUST / SYNC rules, `sa_inventory` never granted to tenant roles | 19 |
| `inventory/stock-csv.spec.ts` | unit: CSV split / header aliases / BOM / CRLF / row validation / duplicates / limits; mismatch + licence derivations | 10 |
| `inventory/licence-isolation.spec.ts` | static: no seat services or `.licenceSeat.` access, no `Device` / `DeviceAssignment` writes, new devices only via `createInTx` without company / active, every mutation writes its movement in the transaction | 8 |
| `inventory/backfill-plan.spec.ts` | unit: derived backfill rows, warnings, script has no write path | 3 |
| `inventory/inventory.integration.spec.ts` | service tests on the scratch DB (`INVENTORY_IT_DATABASE_URL`, refuses `…/veetracer`): receipt new + existing, duplicate / double receipt / missing model / duplicate serial (all-or-nothing), customer device refused, status machine with reasons + ledger order, adjust (retired correction, diff), transfer + partner holder, **licence safety**, CSV dry-run / refused apply / clean apply, list / filter / summary / CSV, in-use locations / suppliers, ledger survives device purge | 11 |

**Licence-safety evidence** (`inventory.integration.spec.ts`): before/after snapshots of *all* `LicenceSeat` rows (`companyId`, `partnerId`, `deviceId`, `userId`, `fuelObjectId`, `assignedAt`, `expiresAt`, `updatedAt`) and *all* `Device` rows (`companyId`, `isActive`, `updatedAt`) are identical around receipts, CSV import, status changes (incl. FAULTY / RETURNED of a licensed, fitted customer device), transfer, adjust and sync; the seat-service stub records **zero** `ensureDevice` / `releaseDevice` calls; the device's seat still belongs to its company afterwards.

**Results (2026-11-09):**
- `npx jest` (apps/api), default (no scratch DB): **105 suites passed, 1 skipped; 910 tests passed, 11 skipped**.
- `npx jest` with `INVENTORY_IT_DATABASE_URL=…/veetrax_inv`: **106 suites, 921 tests passed** (inventory: 5 suites, 51 tests).
- `npx tsc --noEmit` (apps/api): clean. `tsc -b --noEmit` (apps/web) and `tsc --noEmit` (apps/mobile): clean. `npm test` (apps/web): 95 passed.
- `prisma migrate deploy` + `SEED_DEMO=1 npx tsx prisma/seed.ts` on `veetrax_inv`: OK; `prisma migrate diff` DB → schema: empty.
- DI smoke: compiled `AppModule` (with `InventoryModule`) resolves; `summary` / `stock` / `locations` served from `veetrax_inv` (Redis pointed at an unused port so no shared cache was touched).
- Backfill dry run on `veetrax_inv`: 20 devices → 20 × ACTIVE (demo devices are fitted), would insert 20 `DeviceStock` + 20 `StockMovement`; nothing written.

Run the DB suite: `INVENTORY_IT_DATABASE_URL=postgresql://<user>:<pw>@127.0.0.1:5432/veetrax_inv npx jest src/inventory` (from `apps/api`).

---

## 5. B4 backfill (design, not applied)

`npx tsx scripts/inventory-backfill-dry-run.ts [--location WH1] [--csv out.csv]` reads devices and prints, per device without a `DeviceStock` row: proposed status (`deriveDeviceStatus`: no company → IN_STOCK or RESERVED if shipped & unclaimed; company → ACTIVE if fitted, else ASSIGNED), proposed location (only for IN_STOCK / RESERVED; ASSIGNED / ACTIVE have none), customer, vehicle, notes (deactivated flag, unclaimed shipment, missing location). No apply mode exists.

**Proposed apply (needs owner approval + a reviewed change):** one transaction per batch of ≤500 devices that inserts `DeviceStock(status, locationId)` and one `StockMovement(kind = SYNC, toStatus, companyId, objectId, reason = 'Backfill from existing assignment', reference = DeviceAssignment:<id>)` per device, skipping devices that gained a row meanwhile (`INSERT … ON CONFLICT DO NOTHING`), touching no existing table. Prerequisites: create the target platform location; confirm whether deactivated devices should get RETIRED instead of their derived status (QI-15); run on a staging copy first and compare counts with the dry run.

---

## 6. Open decisions (not assumed; neutral designs used)

| Ref | Open question | What this run did |
|---|---|---|
| QI-1 | Partner warehouses / who records movements | `ownerPartnerId` / `holderPartnerId` exist; only platform locations are listed and created; holder partner can be set by the Super Admin; no partner access |
| QI-2 | Delivered-but-unclaimed device and licences | Unchanged; RESERVED is inventory-only and never touches seats |
| QI-13 | Seat on replacement / RMA | REPLACE flow not implemented; RETURNED / FAULTY are facts only; no seat move |
| QI-14 | Warranty / RMA commercial terms | `warrantyUntil` captured, no warranty rule, no invoice line |
| QI-15 | Retired / lost device: deactivate? release seat? | No automatic action; deactivate stays the explicit Device Inventory action |
| QI-18 | Platform staff roles | Super Admin only (`sa_inventory` superAdminOnly) |
| QI-23 | Valuation / manufacturer master | `unitCostPaise` captured, no valuation; `DeviceModel.brand` = manufacturer |
| New | Should a status change to ASSIGNED / ACTIVE stay manual (via `/sync`) or be written automatically by the existing flows (Phase A B6 hooks)? | Manual sync + mismatch flag; existing flows untouched |
| New | Menu: separate `sa_inventory` (this run, per assignment) vs extending `sa_device_inventory` (Phase A §5.2) | Separate menu; can be merged later without data change |
| New | "Lost" status (Phase A diagram) is not in the assignment's list | Not added; use RETIRED + reason, or add a status later (shared constant, no migration) |

---

## 7. Next steps

1. **B6 hooks** (separate PR, reviewed with the owners of those flows): append a movement (and update `DeviceStock` when present) inside the existing transactions of Ship / Unship, Claim, admin assign / move, Transfer and `assignDevice`, so `mismatch` stays near zero without manual sync. Behaviour of those flows must not change.
2. **B5 / B7 web:** actions on the stock page (receive dialog, CSV import with the dry-run report, status / transfer / adjust dialogs, movement history sheet), Locations / Suppliers / Receipts tabs, summary tiles; i18n strings.
3. **Return / replacement flow:** a REPLACE movement linking old and new IMEI (no seat move until QI-13 is decided).
4. **Backfill apply** after owner approval (§5).
5. **Partner stock view** (Phase F, QI-1) with `partnerOf(ctx)` guard; E2E isolation probes for `/api/inventory/*`.
6. Optional DB hardening: trigger forbidding `UPDATE`/`DELETE` on `StockMovement` except FK `SET NULL` (kept out of this additive migration).
