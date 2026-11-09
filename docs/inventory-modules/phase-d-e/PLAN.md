# Inventory Modules — Phase D (Vehicle) and Phase E (Invoice): assessment and design notes

**Status:** design only, nothing built in this run. **Date:** 2026-11-09. **Branch:** `feature/inventory-management`.
**Inputs:** [00 Phase A plan](../00-phase-a-plan-and-dependency-map.md) §1.3, §1.4, §2.3, §2.4, §3.5, §4; [01 owner decisions](../01-owner-decisions.md); what Phases B and C now provide (see [PROGRESS](../PROGRESS.md)).

Ground rules carried over: do not rebuild vehicle management (improve `TrackedObject`, documents, service and expenses additively); reuse the licence invoice / GST / numbering / payment helpers without changing them; never move a licence seat or a financial record as a side effect; schema changes are additive and need owner approval before any production migration.

---

## 1. Phase D — Vehicle management

### 1.1 What exists (confirmed from code) and what Phases B/C added

| Area | Existing | Gap |
|---|---|---|
| Vehicle record | `TrackedObject` (type, vehicleType enum, plate, make, model, colour, speed limit, odometer offset, maintenance flag, customFields, isActive), CRUD `/objects` | VIN / chassis, engine no., year, fuel type, registration and purchase data, ownership, lifecycle (sold / scrapped) |
| Documents | `Document` with expiry reminders, files | none for Phase D (reuse) |
| Service | `ServiceReminder`, `ServiceRecord.cost` (Float, rupees) | cost unit differs from `Expense.amountPaise`; no link to expenses |
| Expenses | `Expense` (paise, kinds, vendor, photo) | not linked to service records (double-count risk in TCO) |
| Devices on vehicle | `DeviceAssignment` history | **Phase B/C now add** stock status, movement ledger, REPLACE flow and SIM per device |
| Tenant 360 view | none | **Phase C now adds** the read-only "Devices & SIMs" sheet on the vehicle list (`/asset-links/objects/:id`) — the first tab of a future vehicle page |
| Transfer | `TransferService.moveObject` moves the device seat and fuel seat with the vehicle (Super Admin), while the admin device move releases the seat | R-I2 / Q-05 still open; no preview of what moves |

### 1.2 Proposed design (unchanged from Phase A §3.5, refined)

1. **D1 migration (additive):** `VehicleProfile` 1:1 with `TrackedObject` (`objectId` PK, FK cascade): `vin`, `engineNumber`, `manufactureYear`, `fuelType`, `bodyType` (lookup code, QI-17), `registrationDate`, `registrationState`, `ownership`, `purchaseDate`, `purchasePricePaise`, `lifecycle` (ACTIVE / IN_WORKSHOP / SOLD / SCRAPPED), `lifecycleAt`. Plus nullable `ServiceRecord.costPaise` and `ServiceRecord.expenseId @unique` (FK SetNull). No change to `TrackedObject`.
   - Purge: `VehicleProfile` cascades with the object (it holds no money record); `ServiceRecord.expenseId` SetNull.
   - Rollback: `DROP TABLE "VehicleProfile"; ALTER TABLE "ServiceRecord" DROP COLUMN "costPaise", DROP COLUMN "expenseId";` (owner-approved; drops new data only).
2. **D2 API:** `GET/PUT /objects/:id/profile` under the existing `objects` permission and `objectScopeWhere` (tenant scope); `VEHICLE_BODY` lookup rows (coordinate with the seed owner; no enum change). Plate duplicates: warn only (QI-16 default A).
3. **D3 transfer preview:** `GET /admin/transfer/object/:id/preview` listing seats (device + fuel), documents, service records, expenses, SIM assignments and stock rows that would move or stay. **Read-only; the transfer itself is unchanged.** The UI shows it and requires confirmation. "Start fresh" copies `VehicleProfile` (one additive line in `OBJECT_COPY_FIELDS`, reviewed with the transfer owner).
4. **D4 vehicle 360 API:** one read-only aggregate per object: profile, devices & SIMs (reuse `AssetLinksService`), licence status (read-only), documents due, service due, last 90 days expenses, drivers. Tenant-scoped; QI-21 flag for SIM fields; never cost of SIM plans.
5. **D5 web:** vehicle detail page with tabs (Profile, Devices & SIMs, Documents, Service, Expenses, Drivers, Licence), opened from the existing Vehicles list (no new menu → no role-sync rollout).
6. **D6 TCO report:** a report type in the existing reports engine: expenses + service (costPaise, else cost×100, skipping service rows linked to an expense) per km, per vehicle and period.

### 1.3 Risks / open points
- R-I2 / QI-13: seat behaviour on transfer is inconsistent today; D3 only makes it visible. Changing it needs the licence workstream.
- `ServiceRecord.cost` Float → keep reading it as fallback; never rewrite historical rows.
- `seed.ts` is edited by another engineer: lookup rows must be coordinated.
- Estimate: **M** (≈ 6–8 dev-days incl. tests and UI).

---

## 2. Phase E — Invoice integration

### 2.1 Assessment
- The licence `Invoice` table cannot hold commercial invoices without altering constraints (`orderId @unique NOT NULL → LicenceOrder`, `paidAt NOT NULL`, single SAC / rate). **Do not modify it** (Phase A §4.1).
- Reusable as-is: `financialYear`, `formatInvoiceNumber`, the counter SQL pattern, `gstLine` / `gstBreakdown` / `taxKind`, `PlatformBillingSettings` (supplier), `BillingProfile` (buyer), PDF primitives, `MailerService`, `RazorpayClient` + signature checks, `credit-logic` planning, GST CSV export.
- Phases B/C now provide the line sources: `DeviceStock` (device sale: model, IMEI, serial, unit cost for margin), `SimPlan.pricePaise` (SIM / data line, **only once QI-3 is decided**), REPLACE movements (zero-value replacement or chargeable repair, QI-14).

### 2.2 Proposed design (Phase A §4, unchanged)
- **E1 shared:** `gstLineExclusive`, mixed-rate `gstBreakdownLines`, line kinds (DEVICE, SIM, INSTALLATION, SERVICE_AMC, OTHER), HSN/SAC defaults as configuration (QI-7), exhaustive tests (Σ lines = totals, rounding).
- **E2 migration (additive):** `DocumentCounter(issuerKey, series, fy)`, `CommercialInvoice` + `CommercialInvoiceLine` (snapshots of supplier / buyer; FK to `DeviceStock`/`SimCard` **SetNull** + IMEI / ICCID snapshot), `Payment`, `PaymentAllocation`, `PaymentIntent`, `CommercialCreditNote`, `Refund`; nullable settings columns (`salesInvoicePrefix`, `salesCreditNotePrefix`, `defaultPaymentTermsDays`). Add the new tables to `FINANCIAL_TABLES` so purge never deletes them (QI-20).
- **E3–E8:** drafts (no number) → issue (number in the counter transaction, frozen snapshot, PDF, e-mail) → payments / allocations → Razorpay intent with an additive webhook branch (licence orders keep priority; second capture alerts) → commercial credit notes (no seat code path) → GST CSV merged with the licence series.
- **E9 web:** Super Admin "Sales invoices" (new `sa_invoices` menu, superAdminOnly); customer "Other invoices" tab under Billing behind a setting (QI-21).
- **E10:** overdue reminders job shipped **off** (QI-9); overdue never locks licences or vehicles.

### 2.3 Hooks from inventory (designed, not built)
- "Create invoice draft" from a receipt-less dispatch: when a stock unit is assigned to a customer through Device Inventory, the stock drawer can offer "Draft device invoice" (pre-filled line from `DeviceStock` + model). Draft only; issuing stays an explicit invoice action.
- Replacement (REPLACE movement): optional chargeable line (repair / replacement fee) only if QI-14 says so; default zero-value.
- SIM renewals: a renewal can produce a draft SIM line when `SimPlan.pricePaise` is set (QI-3).

### 2.4 Blockers (from 01-owner-decisions)
QI-5 (numbering), QI-7 (HSN/SAC + rates), QI-12 (e-invoicing / e-way bill) block the first live number (E4). QI-20 (retention vs purge) blocks E2/E4 go-live. QI-3 blocks SIM lines; QI-9 the reminders job; QI-24 the overpayment path. Prerequisites R-17 / R-18 (licence workstream) before E5/E6.

Estimate: **L** (≈ 15–20 dev-days excluding CA sign-off), plus accountant review of HSN/SAC, rates and numbering.
