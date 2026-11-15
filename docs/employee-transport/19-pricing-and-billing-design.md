# 19 Pricing and billing: assessment and design

Status: **Design ready for review** (2026-11-15). This document is design only: no code, no schema change, no
production change. It answers the "Vehicle, Trip & Company Pricing Module" brief.

Implementation starts only after this design is reviewed and the owner decisions in §9.4 are taken.
**C1 (ETMS commercial / pricing) is still open in README §7.**

Paths are relative to the repo root. "schema" means `apps/api/prisma/schema.prisma` on `main` (v1.16.14).

---

## 1. Current capability assessment

### 1.1 What exists

| Area | What exists | Where | Usable for customer pricing? |
|---|---|---|---|
| Vendor billing (supplier side: what a tenant pays its cab vendors) | Vendors, rate cards with 6 models, add-ons, live monthly statement, adjustments. Rate cards are dated (`validFrom`/`validTo`) and scoped by branch and vehicle category | schema `TransportVendor` :4021, `TransportRateCard` :4052, `TransportStatementAdjustment` :4102; engine `packages/shared/src/transport-vendors.ts` (`RATE_MODELS` :13, `tripCharge` :194, `monthlyCharge` :254, `minimumTopUp` :265, `pickRateCard` :317); statement `apps/api/src/etms/vendors/vendors.ts` :374-502 | **Shapes yes, code no.** See the weaknesses below |
| Licence invoicing (platform → customer) | GST invoices with integer paise, a gap-free FY series, frozen supplier/buyer/lines snapshots, credit notes with their own series, a GST split, PDF, GST CSV, idempotent order claim | schema `Invoice` :1782, `InvoiceCounter` :1826, `CreditNote` :1835, `BillingProfile` :1700, `PlatformBillingSettings` :1656; `apps/api/src/licences/invoice-numbering.ts` :13-28, `invoices.service.ts` :120-222, `credit-notes.service.ts` :89-170, `credit-logic.ts`, `billing.service.ts` `fulfil` :331-388; `packages/shared/src/licences.ts` (`taxKind` :275, `gstLine` :297, `gstBreakdown` :306, `financialYear` :386, `formatInvoiceNumber` :393, `amountInWords` :374) | **Yes: the reference implementation** |
| Stock invoicing | A second invoice series (`StockCounter` key `"INV:<fy>"`), invoices issued from DONE docs, credit notes from returns, `paidPaise` | schema `StockInvoice` :2667, `StockCounter` :2701; `apps/api/src/stock/stock-invoices.service.ts` :45-135 | Pattern only |
| Customer ↔ provider relation | `TransportServiceAgreement`: DRAFT/PROPOSED/ACTIVE/SUSPENDED/ENDED, validity, approval by both sides, `version`; **no commercial terms** | schema :2964; `apps/api/src/etms/agreements/*` | **Anchor** (§3.1) |
| Dedicated vehicles | `TransportFleetAllocation`: agreement, vehicle, driver, validity. Informational only | schema :3992; `fleet-allocations.service.ts` :110-130 | Input for availability billing |
| Trip facts | `TransportTrip`: customer, agreement, serviceDate, `seatCapacity`/`occupiedSeats`. `PlannedTrip`: actual times, `distanceKm` (actual GPS). `RouteAssignment.distanceM` (planned). `TransportTripPassenger` outcomes | schema :3390, :2829 (:2857), ~:3815, :3450; tracker `planned-trips/tracker/evaluate.ts` :492, :629, :648 | **Yes** |
| GPS day km | `DailySummary.distanceKm` per object per local day; odometer derived from it | schema :1417; `summarizer/summarizer.ts` :344; `documents/reminder-logic.ts` :33 | Yes (availability excess km) |
| Bookings | `journey` COMMUTE / POINT_TO_POINT, `passengerCount`, `groupId`, idempotency. **No private/shared flag, no fare** | schema :3316-3385; `etms/dispatch/booking-rules.ts` :95-98 | Needs ride preference (pooling design) |
| Permissions | Menus × actions `view/create/edit/delete/export/command` (**no `approve`**), `requires.companyFeature` gating, `dataScope` COMPANY / ASSIGNED, `syncSystemRoleMenus` | `packages/shared/src/permissions.ts` :7, :18, :32, :94; `access/permission.guard.ts`; `access-rules.ts` :15, :68-87; `prisma/seed.ts` :583 | Yes, plus an `approve` action |
| Audit | `AuditService.record(ctx, {action, entity, entityId, before, after, details}, tx)` with field diffs | `apps/api/src/audit/audit.service.ts`; schema `AuditLog` :665 | Yes |
| Jobs | `@nestjs/schedule` in the api process; Valkey `SET NX PX` + Lua release + row CAS claim + env kill switch | `licences/licence-reminders.service.ts` :12-97; `report-schedules/report-scheduler.service.ts` :9-64 | Yes (billing runs) |
| Idempotency | `Idempotency-Key` + stable request hash + replay ledger | `etms/dispatch/e3-common.ts` :23-45 | Yes |
| Reports / export | XLSX / CSV / PDF rendering, CSV formula guard | `reports/report-files.ts`; `common/csv.ts` | Yes |
| Purge guard | `FINANCIAL_TABLES` are never purged | `apps/api/src/purge/financial-guard.ts` | Register the new tables |

### 1.2 Weaknesses of the existing money code (do not copy)

- **Vendor billing:**
  - Money is **Float rupees** rounded with `Math.round(x*100)/100` (`vendors.ts` :435); `gstPct` and adjustment `amount` are Float.
  - INR is hard-coded.
  - Nothing is stored, so a rate edit changes past months.
  - Vehicle links have no history: `setAssets` re-creates them (`vendors.ts` :278-283).
  - `take: 20_000` silently caps the trips counted.
  - GST is a single total with no split.
  - There is no branch data scope.
- **Licence/stock invoicing:**
  - Paise are stored as Postgres `int4`, which caps a field at about ₹2.1 crore.
  - GST rates are Float, prices are GST-inclusive, there is one platform-wide rate, and no currency column.
  - Issued invoices are immutable only by convention (no trigger).
  - Stock docs stay editable after invoicing.
  - There is no payment ledger (`paidPaise` is overwritten).
- **No `@db.Decimal` and no decimal library** anywhere. No lint rule against floats for money.

---

## 2. Gap analysis

| Brief requirement | Status | Gap |
|---|---|---|
| A distance pricing (base, per km, minimum charge, minimum km, waiting, toll/parking, extra stop, night/peak) | Vendor engine has KM / SLAB, night, waiting, dead km | Customer side: exact money, extra stop, peak, toll pass-through, all as components |
| B fixed availability (daily/weekly/monthly, included km/h, excess, overtime, holiday, replacement) | Vendor MONTHLY (fee, included km, extra km, prorate, `billIdle`) | Daily/weekly, included hours, overtime, holiday, downtime, replacement, suspension, stored periods |
| C hourly/shift | Vendor PACKAGE (hours + km) | Minimum hours, waiting, cancellation, extension, shift-bound reservation |
| D fixed trip | Vendor TRIP | Route/service definition, included km, adjustment rule |
| E hybrid, no double charge | — | Coverage model (§5.5) |
| Company / vehicle / trip levels, precedence | Vendor `pickRateCard` specificity | Contract → vehicle override (when permitted) → trip override (with permission) → company default; explicit failure otherwise |
| Contract status Draft → Pending → Active → Suspended → Expired, approval | Agreement dual approval (data access only) | Commercial contract lifecycle + maker-checker |
| Trip price retained per trip, history unchanged | — | Immutable `TripPriceSnapshot` |
| Distance sources kept separate, review on missing GPS | `PlannedTrip.distanceKm`, `RouteAssignment.distanceM`, `DailySummary` | Billable-distance resolution + GPS quality + review queue |
| Availability billing independent of trips | — | `AvailabilityBillingPeriod` + billing run |
| On-demand shared / private / flexible fares, upfront disclosure | No ride preference, no fares | Quote API, allocation methods; depends on the pooling design's booking preference |
| Cost vs price, margin hidden | `Expense`, vendor statement (cost) | Cost records, margin reports, `pricing_costs` menu |
| Invoices: consolidated, branch, lines, tax, credit notes, payments, no duplicates, immutable | Licence stack (single global series, inclusive GST) | Per-supplier series, exclusive tax, lines referencing sources, DB immutability, payment ledger |
| Contract currency, jurisdictional tax | INR / GST only | Currency per contract (ISO 4217), tax profiles + effective-dated rates |
| Pricing UI | Vendor billing pages | New Pricing area |
| Permissions & audit | Menus, audit | `approve` action, new menus, field-level cost hiding, branch scope |

---

## 3. Proposed domain model

Naming: Prisma models use the `Pricing*` / `Billing*` prefix. Money fields end in `Minor` and are `BigInt` (§5.1).
Rates end in `Rate` and are `Decimal @db.Decimal(20,6)`. Distances are `Int` metres, durations `Int` seconds,
dates `@db.Date`, times `@db.Timestamptz(3)`. Every table has `companyId` (the supplier tenant that owns and issues).

### 3.1 Commercial anchor: a new contract, linked to the agreement

**Decision:** a new `PricingContract`, optionally linked to `TransportServiceAgreement`.

**Why not put the terms on the agreement:**
1. The agreement governs **data access** (grants, data profile), approved by both companies. Rate revisions happen more
   often, need their own versions and an internal maker-checker, and must not re-open data-access approval.
2. Corporate-managed ETMS has **no agreement row** (provider = customer), yet the brief needs pricing there too: internal
   charge-back per branch, or the tenant billing its own clients.
3. One agreement can carry successive contracts (renewals, re-pricing) with non-overlapping validity.

**Rule:** when `agreementId` is set, the contract's customer must equal the agreement's customer, and the agreement must
be ACTIVE when the contract is activated. Suspending or ending the agreement suspends billing (no new trip pricing).

### 3.2 Entities

| Model | Key fields | Notes |
|---|---|---|
| `PricingContract` | id, companyId (supplier), customerCompanyId? (null = internal / corporate-managed), customerName snapshot, agreementId?, name, reference, currency (ISO 4217 code), billingFrequency (TRIP / DAILY / WEEKLY / MONTHLY), paymentTermsDays, taxProfileId, branchIds[] (empty = all), status (DRAFT / PENDING_APPROVAL / ACTIVE / SUSPENDED / EXPIRED), allowVehicleOverrides bool, allowTripOverrides bool, distanceSource (§5.4), onMissingGps (REVIEW / USE_PLANNED / USE_AGREED), roundingMode (HALF_UP default / HALF_EVEN), version, submittedById/At, approvedById/At, suspendedAt/Reason, createdById | Header; the terms live in versions |
| `PricingContractVersion` | id, contractId, versionNo, validFrom, validTo?, status (DRAFT / PENDING_APPROVAL / ACTIVE / SUPERSEDED / REJECTED), components (relation), policies Json (waiting, cancellation, overtime, holiday, replacement), submittedBy/At, approvedBy/At, rejectReason, supersedesId? | **Effective-dated.** Raw-SQL `EXCLUDE USING gist (contractId WITH =, daterange(validFrom, coalesce(validTo,'infinity'),'[)') WITH &&) WHERE status = 'ACTIVE'`. An ACTIVE version is immutable (trigger); a change means a new version |
| `PricingComponent` | id, versionId, kind (§5.2: BASE_FARE, PER_KM, SLAB_KM, MIN_TRIP_CHARGE, MIN_BILLABLE_KM, WAITING, EXTRA_STOP, TOLL_PARKING_PASSTHROUGH, NIGHT_SURCHARGE, PEAK_SURCHARGE, FIXED_TRIP, HOURLY, MIN_HOURS, AVAILABILITY_FEE, INCLUDED_KM, INCLUDED_HOURS, EXCESS_KM, EXCESS_HOUR, OVERTIME, HOLIDAY, CANCELLATION, SEAT, MIN_GUARANTEE, DISCOUNT), scope Json (vehicleCategory?, seats range?, branchIds?, journey?, ridePreference?, serviceType?, routeId?), params Json (typed per kind, rates as decimal strings), covers[] (§5.5), sortOrder | Rules / components of one version |
| `PricingVehicleRate` | id, contractId, objectId, validFrom, validTo?, model override?, componentOverrides Json, capacity / category snapshot, status (as contract versions), approvedBy/At | **Allowed only if `contract.allowVehicleOverrides`** (server-enforced; a create on a prohibiting contract is 409 `VEHICLE_OVERRIDE_NOT_PERMITTED`). Same exclusion constraint per (contract, objectId) |
| `PricingVehicleAssignment` | id, contractId, objectId, driverId?, fleetAllocationId?, validFrom, validTo?, operatingHours Json, replacesAssignmentId?, replacementBilling (ORIGINAL / SEPARATE), status | Dedicated vehicles for availability billing. Optional link to `TransportFleetAllocation` |
| `PricingDowntime` | id, assignmentId, from, to, kind (BREAKDOWN / MAINTENANCE / SUSPENSION / HOLIDAY / NON_OPERATING), billable bool, reason, createdById | Feeds proration |
| `PricingCalendar` | id, companyId, name, dates (holidays, non-operating weekdays) | Referenced by contract policies |
| `TripPriceSnapshot` | id, companyId, transportTripId, bookingId?, passengerId? (shared-ride allocation), contractId, contractVersionId, vehicleRateId?, customerCompanyId, branchId?, objectId, currency, pricingModel, ridePreference?, plannedDistanceM?, gpsDistanceM?, agreedDistanceM?, manualDistanceM?, billableDistanceM, distanceSource, gpsQuality (OK / MISSING / LOW_COVERAGE / UNAVAILABLE), plannedDurationS?, actualDurationS?, waitingS?, extraStops, lines Json (component → quantity, rate, amountMinor, basis text), subtotalMinor, availabilityAllocationMinor?, discountMinor, taxLines Json, taxMinor, totalMinor, status (ESTIMATE / PRICED / NEEDS_REVIEW / COVERED / VOID), isCurrent bool, supersedesId?, reason?, overrideBy/At/Reason/approval, calculatedAt, engineVersion | **Append-only** (trigger: no UPDATE except `isCurrent` → false when superseded; no DELETE). Partial unique `(transportTripId, coalesce(passengerId,''))` WHERE isCurrent. An invoice line points to one snapshot id, so later recalculations never touch invoiced amounts |
| `AvailabilityBillingPeriod` | id, companyId, contractId, versionId, assignmentId, periodStart, periodEnd, frequency, attachedDays, billableDays, downtimeDays, includedKm, usedKm (GPS / trips per contract), excessKm, includedHours, usedHours, excessHours, overtimeHours, holidayDays, lines Json, subtotalMinor, taxMinor, totalMinor, status (OPEN / CLOSED / NEEDS_REVIEW / INVOICED / VOID), calculatedAt | Unique (assignmentId, periodStart, frequency). Charged even with zero trips if the contract says so |
| `BillingRun` | id, companyId, contractId, kind (TRIP_PRICING / AVAILABILITY_CLOSE / INVOICE), periodStart, periodEnd, status (CLAIMED / RUNNING / DONE / FAILED), claimedBy, startedAt, finishedAt, stats Json, error | **Unique (companyId, contractId, kind, periodStart).** This row is the idempotency claim (§5.8) |
| `BillingCounter` | key (e.g. `CINV:<companyId>:<fy>`, `CCN:<companyId>:<fy>`), lastSeq | Same row-lock upsert as `invoice-numbering.ts` :13-28 |
| `BillingSupplierProfile` | companyId (+ branchId? per owner decision), legalName, address, taxRegime (IN_GST / US_SALES_TAX / NONE / OTHER), taxRegistration (GSTIN etc.), stateCode / region, invoicePrefix, creditNotePrefix, fiscalYearStartMonth, bank / UPI details, logo file | The supplier side of invoices (Company/Branch have no GSTIN today). The buyer side reuses `BillingProfile` (schema :1700) for customer companies, or a snapshot for internal / branch billing |
| `TaxProfile` / `TaxRate` | TaxProfile: companyId, jurisdiction, regime, code. TaxRate: profileId, taxCode (e.g. GST_18, SAC-specific), ratePpm (Int, parts per million) or Decimal, components (CGST/SGST/UTGST/IGST rule), validFrom, validTo | Effective-dated. Invoices snapshot the applied rate |
| `CustomerInvoice` | id, companyId (supplier), number (unique per company), fy, seq, contractId?, customerCompanyId?, branchId? (branch invoice) / consolidated flag, periodStart, periodEnd, currency, supplier Json, buyer Json, taxKind, subtotalMinor, discountMinor, taxLines Json, taxMinor, totalMinor, status (DRAFT / ISSUED / CANCELLED_DRAFT), issuedAt, issuedById, dueDate, pdfFile, idempotencyKey | Unique (companyId, fy, seq), (companyId, idempotencyKey). **Trigger:** once ISSUED, no UPDATE of money/party/lines columns and no DELETE |
| `CustomerInvoiceLine` | id, invoiceId, sourceType (TRIP_SNAPSHOT / AVAILABILITY_PERIOD / ADJUSTMENT / MANUAL), sourceId, description, quantity Decimal, unit, rate Decimal, amountMinor, discountMinor, taxCode, taxMinor, totalMinor, branchId?, serviceDate? | **Partial unique (sourceType, sourceId)** over lines of non-cancelled invoices: a trip or period can never be invoiced twice |
| `BillingAdjustment` | id, companyId, contractId, invoiceId?, kind (CREDIT / DEBIT / DISTANCE_CORRECTION / PRICE_OVERRIDE / WAIVER), amountMinor (signed), reason, status (DRAFT / PENDING_APPROVAL / APPROVED / REJECTED / APPLIED), requestedBy, approvedBy | Maker-checker |
| `CustomerCreditNote` | id, companyId, number, fy, seq, invoiceId, lines Json, totals (Minor), reason, issuedAt/By | Own series `CCN:<companyId>:<fy>`. Remaining creditable = invoice total − sum of credit notes (row lock, as in `credit-notes.service.ts` :89-170) |
| `BillingPayment` | id, companyId, invoiceId, amountMinor, currency, receivedAt, method, reference, recordedById, reversedById?, reversalOf? | **Ledger**, append-only. The invoice payment status (UNPAID / PART / PAID / OVERPAID) is derived, never stored as the truth |
| `OperatingCostRecord` | id, companyId, objectId?, driverId?, transportTripId?, date, category (DRIVER / FUEL / ENERGY / MAINTENANCE / TOLL / PARKING / VEHICLE / OTHER), amountMinor, currency, source (VENDOR_STATEMENT / EXPENSE / MANUAL / IMPORT), sourceRef | Internal cost, readable only with `pricing_costs:view` |
| Audit | `AuditService.record` with entity `pricing_contract`, `pricing_contract_version`, `pricing_vehicle_rate`, `trip_price_snapshot`, `billing_adjustment`, `customer_invoice`, `customer_credit_note`, `billing_payment` | Every override carries actor, time, reason, before, after and approval status (audit row + the snapshot's own override fields) |

**Reused, not duplicated:** `Company`, `Branch`, `TrackedObject`, `TransportVehicleProfile` (category, seats),
`Driver`, `TransportTrip` / `PlannedTrip` / `TransportTripPassenger`, `TransportBooking`, `RouteAssignment`,
`DailySummary`, `BillingProfile`, `TransportServiceAgreement`, `TransportFleetAllocation`, `AuditLog`. The licence
`Invoice` table stays the platform's own series; customer invoices are a separate series per supplier tenant.

---

## 4. API contract

All routes go under `/api/pricing`. They require the `pricing` company feature (new, in `COMPANY_FEATURES`,
`packages/shared/src/api.ts` :72) and the menu permission shown. Lists follow the existing paging and filter style.
Writes use `expectedVersion` (CAS) and an `Idempotency-Key` where noted.

| Method + path | Permission | Purpose |
|---|---|---|
| `GET /contracts`, `GET /contracts/:id` | `pricing_contracts:view` | List / detail (versions, components, vehicles, branches) |
| `POST /contracts` | `pricing_contracts:create` | New DRAFT contract + version 1 |
| `PATCH /contracts/:id` | `pricing_contracts:edit` | Header fields while DRAFT (policies via versions) |
| `POST /contracts/:id/versions` | `pricing_contracts:edit` | New DRAFT version (copy of current) for a re-price |
| `PUT /contracts/:id/versions/:v/components` | `pricing_contracts:edit` | Replace the components of a DRAFT version |
| `POST /contracts/:id/versions/:v/submit` | `pricing_contracts:edit` | DRAFT → PENDING_APPROVAL |
| `POST /contracts/:id/versions/:v/approve` · `/reject` | `pricing_contracts:approve` | Maker ≠ checker. Activates the version (exclusion constraint) and supersedes the previous one at validFrom |
| `POST /contracts/:id/suspend` · `/resume` · `/expire` | `pricing_contracts:approve` | Lifecycle (reason required) |
| `POST /contracts/:id/preview` | `pricing_contracts:view` | **Sample calculation**: body = a hypothetical trip / period, returns the full line breakdown. Nothing is stored |
| `GET/POST/PATCH /contracts/:id/vehicle-rates` | `pricing_vehicle_rates:*`, approve for activation | Refused when overrides are not permitted |
| `GET/POST/PATCH /contracts/:id/vehicles` | `pricing_contracts:edit` | Dedicated vehicle assignments, replacement, downtime |
| `GET /trip-charges?from&to&status&branchId&customer` | `pricing_trip_charges:view` | Trip price list (review queue = `status=NEEDS_REVIEW`) |
| `GET /trip-charges/:tripId` | `pricing_trip_charges:view` | Current snapshot + history + audit |
| `POST /trip-charges/:tripId/recalculate` | `pricing_trip_charges:edit` | New snapshot (refused once invoiced; use an adjustment instead) |
| `POST /trip-charges/:tripId/billable-distance` | `pricing_trip_charges:edit` | Manual distance + reason → new snapshot |
| `POST /trip-charges/:tripId/override` | `pricing_trip_charges:command` (+ approve when the contract requires it) | Negotiated trip price + reason → PENDING or new snapshot |
| `GET /availability?period&contract` · `POST /availability/close` | `pricing_availability:view` · `:command` + Idempotency-Key | Periods; close a period (BillingRun claim) |
| `POST /quotes` | `etms` passenger / desk booking rights (no pricing menu) | On-demand **upfront quote**: amount or pricing basis, `quoteId`, expiry; stored hash referenced by the booking |
| `GET /invoices`, `GET /invoices/:id`, `GET /invoices/:id/pdf` | `pricing_invoices:view` | |
| `POST /invoices/generate` | `pricing_invoices:create` + Idempotency-Key | DRAFT invoices for (contract, period[, branch]) from un-invoiced snapshots and periods |
| `POST /invoices/:id/issue` | `pricing_invoices:command` | Assigns the number (gap-free), freezes snapshots, renders the PDF |
| `DELETE /invoices/:id` | `pricing_invoices:delete` | DRAFT only |
| `POST /invoices/:id/credit-notes` | `pricing_adjustments:approve` | Partial or full credit |
| `GET/POST /adjustments`, `POST /adjustments/:id/approve` | `pricing_adjustments:view/create/approve` | Maker-checker |
| `GET/POST /invoices/:id/payments`, `POST /payments/:id/reverse` | `pricing_invoices:edit` | Payment ledger |
| `GET /reports/:type?format=csv|xlsx|pdf` | `pricing_reports:view/export`; cost/margin columns need `pricing_costs:view` | Revenue, trips, availability, branch, ageing; margin |
| `GET/POST /costs` | `pricing_costs:view/create` | Operating cost records |
| `GET/PUT /settings/supplier`, `/settings/tax-profiles` | `pricing_contracts:approve` (company-admin level) | Supplier legal / tax / numbering settings |

**Error codes (new):** `CONTRACT_OVERLAP`, `CONTRACT_NOT_ACTIVE`, `NO_APPLICABLE_PRICING` (with the reason), `VEHICLE_OVERRIDE_NOT_PERMITTED`,
`TRIP_OVERRIDE_NOT_PERMITTED`, `MAKER_CHECKER_SAME_USER`, `ALREADY_INVOICED`, `INVOICE_ISSUED_IMMUTABLE`, `BILLING_RUN_IN_PROGRESS`,
`CURRENCY_MISMATCH`, `TAX_PROFILE_MISSING`, `GPS_DISTANCE_REVIEW`.

---

## 5. Pricing calculation design

### 5.1 Money representation (decision)

**Decision:** amounts are **`BigInt` minor units**. Rates are **`Decimal(20,6)` in the database, held as `bigint`
micro-units in the engine.** There is **no decimal library and no float anywhere in the money path.**

**Why:**
- **Exact arithmetic without a dependency.**
  - A per-km rate of ₹12.375 is `12_375_000` micro-rupees.
  - Distance is integer metres.
  - Charge = `rateMicro × metres / 1000`, then a single rounded conversion to minor units (§5.3).
  - JS `bigint` is native and exact. `Decimal` columns keep SQL readable for finance; the API carries rates as decimal strings.
- **No int4 ceiling.** `BigInt` avoids the ~₹2.1 crore cap of today's `Int` paise.
- **Multi-currency.** Minor-unit exponents come from an ISO 4217 table in `packages/shared/src/pricing/currency.ts`
  (INR 2, USD 2, EUR 2, AED 2, JPY 0, KWD 3, …).
  - Every amount travels with its currency.
  - The engine refuses to mix currencies (`CURRENCY_MISMATCH`).
  - No currency is hard-coded: a contract must name one.
- **Rejected alternatives:**
  - Prisma `Decimal` + decimal.js end to end: a new dependency and slower, for no extra exactness at these scales.
  - Keeping `Int` paise: overflow and fractional-rate loss.

### 5.2 Engine (pure, `packages/shared/src/pricing/`)

`price(input) → {lines[], subtotalMinor, discountMinor, taxLines[], taxMinor, totalMinor, status, issues[]}`.

- **Input:** contract version components (resolved by precedence), trip or period facts, tax rates, currency, rounding mode.
- **Output:** every line explains itself (`basis`, e.g. "25.0 km × ₹2.000000/km").
- The shapes reuse the vendor rate-engine concepts (`transport-vendors.ts` :26-69). The vendor code itself stays
  untouched (optional later port, §7).

**Component evaluation order** (deterministic):

1. **Coverage check (§5.5).** If the trip is fully covered → status COVERED, total 0, line "covered by availability contract".
2. **Base charge by model:**
   - **Distance:** BASE_FARE + PER_KM or SLAB_KM on billable km. Then `max(MIN_BILLABLE_KM, km)` applied to the
     distance, and `max(MIN_TRIP_CHARGE, charge)`.
   - **Fixed trip:** FIXED_TRIP. Actual distance changes nothing unless an `INCLUDED_KM` + `EXCESS_KM` adjustment rule is configured.
   - **Hourly:** HOURLY × `max(MIN_HOURS, billable hours)`. Billable hours use reserved or actual time per the policy,
     rounded up to the policy's increment. Plus EXCESS_KM over INCLUDED_KM.
   - **Availability:** AVAILABILITY_FEE per period.
3. **Add-ons:**
   - WAITING: free minutes, then a rate per increment.
   - EXTRA_STOP: stops beyond those included.
   - NIGHT_SURCHARGE / PEAK_SURCHARGE: % or fixed, on configured time bands.
   - TOLL_PARKING_PASSTHROUGH: actual amounts, tax per its own code.
   - SEAT: per passenger.
   - CANCELLATION: per the policy and timing.
4. **Discounts:** contract or promotional; never below zero.
5. **Tax (§5.6):** on the taxable lines.
6. **Rounding (§5.3)**, then the totals.

**Precedence (§5.7) is resolved before the engine runs; the engine never falls back silently.**

### 5.3 Rounding

- **Calculation:** in micro-units.
- **Each line:** converted to minor units once, with the contract's `roundingMode` (default HALF_UP; HALF_EVEN optional).
- **Totals:** the sum of the rounded lines. Totals are never re-derived from unrounded values, so the PDF always adds up.
- **Tax:** computed per line, then rounded. For India the odd paisa goes to CGST, as `gstLine` (`licences.ts` :297) does today.
- **Proration:** `fee × billableDays / periodDays`, computed in micro-units and rounded once at the period line.

### 5.4 Distance and duration resolution

**Distances**

| Value | Source |
|---|---|
| planned | `RouteAssignment.distanceM` (E4) or the trip's route path length (`reports/trip-performance.ts` :91 `plannedKmOf`) |
| gps | `PlannedTrip.distanceKm` × 1000 (tracker, while moving) |
| agreed | The contract component's fixed route distance |
| manual | Dispatcher-approved value with a reason |

**Contract `distanceSource`:** GPS / PLANNED / AGREED / MANUAL_APPROVED.

**GPS quality**
- **MISSING:** `distanceKm` is null.
- **LOW_COVERAGE:** a long offline gap during the trip (from position gaps, or `DailySummary.offlineSec` in the trip window
  above a threshold), or GPS < x % of planned, or > y × planned. Thresholds are set in the contract policy.

**When the source is GPS and quality is not OK, apply `onMissingGps`:**
- **REVIEW (default):** status NEEDS_REVIEW; no billable value; the snapshot is excluded from invoicing until resolved.
- **USE_PLANNED / USE_AGREED:** price on that value; the line basis says so.

**Never 0 km, never arbitrary.**

**Durations:** planned from `PlannedTrip.plannedStart/End`, actual from `actualStart/End`. Waiting = actual − planned
beyond free minutes, or stop-level dwell when available.

### 5.5 Hybrid: preventing double charging (coverage matrix)

Each component declares what it `covers`: `VEHICLE_TIME`, `KM_INCLUDED`, `HOURS_INCLUDED`, `TRIPS` (by scope: vehicle
assignment, branch, service type).

| Usage | Availability component covers TRIPS | Covers only VEHICLE_TIME + KM_INCLUDED | No availability component |
|---|---|---|---|
| Trip on a dedicated vehicle within contract hours | Trip snapshot COVERED (0). km counts toward the period's included km | Trip priced per trip **only if** the contract sets `alsoChargeTrips` (explicit hybrid). km still counts toward included km | Trip priced per trip |
| km beyond included | Excess billed **once** at period close (`AvailabilityBillingPeriod.excessKm`), never per trip | Same | Per trip only |
| Trip outside operating hours | OVERTIME on the period | OVERTIME on the period | Per trip |

**Validation at approval:** a version whose components would charge the same usage twice (e.g. TRIPS covered and
PER_KM in the same scope without `alsoChargeTrips`) is refused, with a clear message.

### 5.6 Tax

- **Separate from base pricing.**
  - `TaxProfile` comes from the contract; `TaxRate` is effective-dated by service date (or invoice date per the regime
    setting).
  - Prices are **tax-exclusive** in contracts. A new `gstLineExclusive` sits next to the existing inclusive helpers in
    `licences.ts`.
- **India GST:**
  - `taxKind` gives CGST+SGST, CGST+UTGST or IGST from the supplier and buyer state codes (`licences.ts` :275).
  - A SAC per component is configurable.
  - Toll/parking pass-through can be exempt.
- **Other regimes:**
  - NONE.
  - US sales tax: a single or composite rate per jurisdiction, configured; no automatic lookup.
- **No rate is assumed.** Missing configuration = `TAX_PROFILE_MISSING`, and nothing is issued.
- **History is safe:** invoices snapshot the applied rates (`taxLines`), so rate updates never rewrite history.

### 5.7 Precedence

| Order | Source | Condition |
|---|---|---|
| 1 | Active contract version covering (customer, branch, service date, scope) | Required. None → `NO_APPLICABLE_PRICING` (trip shows "no contract", never priced from another customer's rate) |
| 2 | `PricingVehicleRate` for the vehicle | Only if `allowVehicleOverrides` and the rate is ACTIVE for the date; else ignored **with an issue line** when one exists but is not permitted |
| 3 | Trip-specific negotiated override | Only with `pricing_trip_charges:command`, a reason, and (if the contract requires it) approval. Recorded on the snapshot + audit |
| 4 | Company default contract (`PricingContract.isDefault`, one per company, customer null) | Only when no customer contract exists **and** the default's scope explicitly includes this customer type. The snapshot's basis names the default |

If several contracts match, the most specific scope wins: branch + category > branch > category > none. A tie →
`NO_APPLICABLE_PRICING` (ambiguous); never "latest wins".

### 5.8 Billing runs, idempotency, immutability

**Trip pricing**
- When a trip settles (`etms/dispatch/trip-settle.ts`, COMPLETED / INCOMPLETE), an outbox event (`OutboxEvent`,
  schema :3630) → pricing worker creates an ESTIMATE / PRICED snapshot.
- An ESTIMATE is also created at publish time from planned values.
- Re-pricing creates a new snapshot. Invoiced snapshots are frozen.

**Period close / invoice generation** (scheduled in the api process, licence-reminders pattern):
1. Valkey lock `vt:pricing:billing:lock` + kill switch `BILLING_JOB=off`.
2. **Claim:** `INSERT BillingRun … ON CONFLICT DO NOTHING`, plus a CAS on status.
3. Compute.
4. Write the periods and DRAFT invoices in one transaction.
5. **Manual generation** uses the same claim + `Idempotency-Key`.
6. The partial unique index on invoice lines `(sourceType, sourceId)` is the last guard: a second run cannot invoice
   the same trip or period.

**Issue**
- A row lock on the invoice → number from `BillingCounter` in the same transaction → snapshot of supplier, buyer,
  lines and tax → status ISSUED → PDF rendered after commit and stored (`var/pricing-invoices/<companyId>/<fy>/`).
- **Immutability trigger:** UPDATE or DELETE on an ISSUED invoice or its lines raises; only the pdfFile / emailedAt
  columns stay writable.
- Corrections go through credit notes or adjustments only.

### 5.9 On-demand rides

| Preference | Allowed fare methods | Rule |
|---|---|---|
| PRIVATE | Vehicle trip price (distance / time / fixed) for the booking | **Never a shared fare.** The engine refuses shared methods for PRIVATE |
| SHARED | `OWN_FARE` (each passenger on their own direct distance × shared rate or a discount %), `DISTANCE_SHARE` (vehicle trip cost allocated by passenger-km on board), `FIXED_PER_PASSENGER`, `CONTRACT_RULE` | `EQUAL_SPLIT` only if explicitly configured. Per-passenger snapshots (`passengerId`) |
| FLEXIBLE | Quote shows the shared price and the private price (or the basis); final = the method of the service actually delivered | Labelled shared if co-riders were on board (same semantic as the pooling design) |

**Upfront disclosure:**
- The booking flow calls `POST /pricing/quotes` before confirmation when the contract's service requires disclosure.
- The booking stores `quoteId` + `quoteHash`. The final price ≤ quote, except components the quote names as variable
  (waiting, extra stops, toll).

**Dependency:** the pooling design's ride preference field.

### 5.10 Cost versus price

- `OperatingCostRecord` sources: vendor statements (the existing vendor billing is the cost side), `Expense`
  (`amountPaise`, schema :1398), manual entries and imports.
- Margin = revenue (snapshots + periods, by date) − cost (records, by date), per vehicle / day / trip.
- **Visibility:**
  - Every cost / margin field is projected out unless the caller has `pricing_costs:view`.
  - The projection follows `etms/people/people-access.ts` :31-90.
  - Customer and dispatcher roles never see cost.

---

## 6. UI workflow

**Navigation.** A new menu group **Pricing** (`MenuGroup` + `GROUP_ORDER` in `apps/web/src/features/shell/nav.ts`),
gated by the `pricing` feature.

| Menu | Key | Contents |
|---|---|---|
| Pricing Dashboard | `pricing` | Revenue this period, trips priced / needing review, open invoices and ageing, contracts expiring. Margin tile only with `pricing_costs` |
| Company Contracts | `pricing_contracts` | List, then the contract screen (below) |
| Vehicle Rates | `pricing_vehicle_rates` | Vehicle, current contract, model, rates, included km/h, effective period, override permitted yes/no |
| Pricing Rules | (part of contracts) | Component library and templates per version |
| Trip Charges | `pricing_trip_charges` | Table with filters and a review queue; trip detail with the breakdown |
| Availability Billing | `pricing_availability` | Periods per dedicated vehicle: attached / billable / downtime days, included vs used km/h, excess, close period |
| Invoices | `pricing_invoices` | Generate (contract, period, branch / consolidated), drafts, issue, PDF, payments, credit notes |
| Adjustments | `pricing_adjustments` | Requests, approval queue |
| Pricing Reports | `pricing_reports` | Revenue, per km, per trip, per vehicle/day, utilisation, branch; margin columns only with `pricing_costs` |

**Contract screen**
- Header: customer, reference, currency, validity, branches, billing frequency, payment terms, tax profile, policies.
- Version tabs with component cards: model presets for Distance / Fixed availability / Hourly / Fixed trip / Hybrid,
  which prefill the components.
- Dedicated vehicles and replacements.
- **Sample calculation panel:** enter km / hours / stops / waiting / night → live breakdown via `/preview`.
- Submit for approval, then the approver sees a diff against the active version → Approve / Reject.
- Suspend / Resume.
- History drawer (audit).

**Trip pricing breakdown**
- Distances side by side: planned, GPS, agreed, manual, billable (with source).
- Durations; each line with its basis; discounts; tax lines; estimate vs final.
- Snapshot history; override / distance actions (with permission), each with a mandatory reason.

All strings get en / hi / ta entries (i18n extract). Money is formatted with the contract currency (`Intl.NumberFormat`,
never "₹" hard-coded).

---

## 7. Migration plan

1. **`2026xxxx_pricing_core`** (additive only):
   - all §3 tables;
   - `btree_gist` (already used by the booking exclusion, `20261121090000_etms_booking_journey`) for the version and
     vehicle-rate exclusion constraints;
   - partial unique indexes (current snapshot; invoice line source);
   - immutability triggers on ACTIVE contract versions, `TripPriceSnapshot`, issued `CustomerInvoice` / lines,
     `CustomerCreditNote`, `BillingPayment`.
2. **Permissions:**
   - new menus in `MENU_KEYS` / `MENUS`;
   - new `approve` action in `ACTIONS` (§9.3), with roles UI support;
   - `syncSystemRoleMenus` adds the menus to existing system roles without changing their grants;
   - a new "Billing admin" role template.
3. **Feature flag** `pricing` in `COMPANY_FEATURES`, **off by default**.
4. **Purge:** add every new table to `FINANCIAL_TABLES` (`purge/financial-guard.ts`). Retention: contract life + 7 years
   (doc 15 §3.1 / §10).
5. **No change** to licence or stock invoicing, or to vendor billing.
   - Optional later step: port the vendor engine to the shared money engine and convert Float rupees to minor units
     with an audited one-off migration.
6. **Rehearsal:**
   - `prisma migrate deploy` on a scratch `*_test` database (CI pattern, `.github/workflows/ci.yml` :36-90) and on a
     copy of production data before release.
   - Down path: the tables are new, so a rollback = feature off. No destructive migration.

---

## 8. Test plan (risk-based)

**Policy** (owner, 2026-11-15): focused tests on money, isolation, authorisation, duplicate billing, immutability and
historical prices. One end-to-end workflow; no load tests. Pass / skip / not verified is reported separately.

| # | Acceptance scenario | Level |
|---|---|---|
| 1 | Per-km trip pricing | Unit (engine) + E2E |
| 2 | Fixed-price trip keeps the agreed price | Unit |
| 3 | Hourly minimum hours | Unit |
| 4 | Daily availability charged with zero trips | Unit + DB (period close) |
| 5 | Monthly partial period proration | Unit |
| 6 | Included km and excess rate | Unit + DB |
| 7 | Hybrid: no double charge (coverage) | Unit + approval validation |
| 8 | Vehicle rate obeys override permission | DB (409) |
| 9 | Trip override needs permission + reason | DB (403 / 400) + audit row |
| 10 | Historical trip price unchanged after a rate update | DB (new version, old snapshot intact) |
| 11 | Shared-ride individual charges | Unit (each allocation method) |
| 12 | Private stays private-priced | Unit (refusal) |
| 13 | Missing GPS → review policy | Unit + DB |
| 14 | Duplicate billing job → no duplicate charges | DB (two concurrent runs; unique index) |
| 15 | Issued invoice immutable | DB (trigger) |
| 16 | Adjustments / credit notes audited | DB |
| 17 | Currency and tax applied | Unit (INR GST split, USD, JPY exponent, KWD 3 decimals; mismatch refused) |
| 18 | Company and branch isolation | Isolation matrix entries (`etms/testing/isolation-matrix*.ts`) for every `/api/pricing` route |
| 19 | Unauthorised users cannot view or modify; cost hidden | Isolation matrix + projection unit test |
| 20 | Unit / integration / E2E coverage | Engine units; DB tests per workstream; one E2E: contract → approve → trip settles → snapshot → close period → generate → issue → credit note → payment |

**Engine units cover:**
- property-style checks: sum of lines = total;
- rounding modes;
- bigint overflow guard (inputs bounded by validation).

---

## 9. Phased implementation plan

### 9.1 Workstreams (parallel, with file ownership)

| WS | Scope | Owns (files) | Depends on |
|---|---|---|---|
| **P0** Foundations | Schema + migration + triggers + `COMPANY_FEATURES` + menus + `approve` action + purge registration | `apps/api/prisma/*`, `packages/shared/src/permissions.ts`, `api.ts`, `purge/financial-guard.ts`, `apps/web/src/features/shell/nav.ts` (menu icons), roles UI action | Design approval, §9.4 decisions |
| **P1** Money & engine | `money.ts`, `currency.ts`, `engine.ts`, `tax.ts`, `fare-allocation.ts`, `coverage.ts` + unit tests | `packages/shared/src/pricing/*` | None (can start with P0) |
| **P2** Contracts & vehicle rates | Contract / version / component / vehicle-rate / assignment / downtime APIs, approval, preview, supplier and tax settings | `apps/api/src/pricing/contracts/*`, `settings/*` | P0, P1 |
| **P3** Trip pricing | Settle hook (outbox consumer), distance resolution, GPS quality, review queue, overrides, recalculation | `apps/api/src/pricing/trips/*` (+ a 1-line hook in `trip-settle.ts`) | P0–P2 |
| **P4** Availability & runs | Period computation, BillingRun claim, scheduler, close endpoint | `apps/api/src/pricing/availability/*`, `pricing/jobs/*` | P0–P2 |
| **P5** Invoicing | Generate, numbering, issue, PDF (reuse the pdfmake layout from `licences/invoice-pdf.ts`), credit notes, adjustments, payments ledger | `apps/api/src/pricing/invoices/*` | P3, P4 |
| **P6** Web | The Pricing area (§6) | `apps/web/src/features/pricing/*`, router entries | API contracts (can stub from shared types early) |
| **P7** Reports, costs, margin | Reports, cost records, projections | `apps/api/src/pricing/reports/*`, `costs/*` | P3–P5 |
| **P8** On-demand quotes | Quote API + booking link + shared / private allocation | `apps/api/src/pricing/quotes/*`, booking hook | Pooling design (ride preference) |
| **QA / Sec** | Independent review per WS (money correctness, isolation, authz, immutability, idempotency) | Read-only | Each WS |

**Suggested order:**
- Wave 1: P0 ∥ P1.
- Wave 2: P2 ∥ P6 (stubs).
- Wave 3: P3 ∥ P4.
- Wave 4: P5 ∥ P7.
- Then P8 with the pooling work.

### 9.2 Release gates

1. Design reviewed and §9.4 decisions taken.
2. Per workstream: tsc, focused tests passed, QA + security review passed.
3. Migration rehearsed on a scratch database and on a production copy.
4. Backup taken.
5. Deployed with the feature **off**.
6. Smoke test on one internal contract.
7. Owner approval to switch on per company.

The production deploy needs explicit release approval (working agreement). No paid infrastructure.

### 9.3 Decisions taken in this design (reversible at review)

| Topic | Decision |
|---|---|
| Money | `BigInt` minor units for amounts; `Decimal(20,6)` rates as bigint micro in the engine; no floats; ISO 4217 exponents |
| Commercial anchor | New `PricingContract` (+ versions), optional link to `TransportServiceAgreement` |
| Invoice numbering | Gap-free per supplier company and fiscal year, key `CINV:<companyId>:<fy>` (credit notes `CCN:…`), format `<prefix>/<fy>/<seq:4+>` |
| Approval | New permission action **`approve`** (not `command`, so approve can be granted without command rights), plus **maker ≠ checker** enforced server-side |
| Immutability | DB triggers + append-only snapshots + credit notes; no edit of issued documents |
| Tax | Contract tax profile + effective-dated rates; exclusive pricing; India GST split reused |
| Cost hiding | Separate `pricing_costs` menu; server-side projection |
| Branch scope | ASSIGNED users see contracts / trips / periods / invoices of their branches only; consolidated invoices need COMPANY scope |

### 9.4 Owner decisions needed

1. **C1:** approve ETMS commercial pricing as a product capability (README §7).
2. **Who bills whom:** operator → customer only, or also internal charge-back in corporate-managed mode (customer null)?
3. **Supplier tax registration:** per company, or per branch (multiple GSTINs / states)?
4. **Fiscal year start and invoice number format** per supplier (India April; others January?), and the prefix rules.
5. **Maker-checker strictness:** may a single-admin company self-approve (audited), or are two users always required?
6. **Currencies and tax regimes for launch:** INR + GST only, or also USD / sales tax?
7. **Default rounding** (HALF_UP vs HALF_EVEN) and default `onMissingGps` (REVIEW recommended).
8. **Customer visibility:** may customer companies view the invoices issued to them in VeeTrax?
9. **Vendor statements as the operating-cost source**, and whether vendor billing is later ported to the exact-money engine.
10. **Holiday calendars:** per company or per branch.
11. **Out of scope unless requested:** e-invoicing (IRN), TDS, payment gateway collection for customer invoices.
