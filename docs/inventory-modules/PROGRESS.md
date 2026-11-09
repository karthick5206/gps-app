# Inventory Modules — Progress (Device Inventory UI, dashboard, replacement, SIM Phase C, tenant view)

**Branch:** `feature/inventory-management` (base: production v1.3.0 @ `07077b6`, which already contained Device Inventory Phase B). **Not pushed, not merged.**
**Date:** 2026-11-09. **Worktree:** `D:\Vibhav\gps-app\.claude\worktrees\agent-a7359be7fb096dcd4`.
Production (166.0.242.121 / port 4000), the production database, the main checkout and `apps/api/.env` were not touched. All database work ran on the scratch database `veetrax_inv2` (local WSL PostgreSQL, same credentials, only the database name changed), seeded with `SEED_DEMO=1`. The running app used API port 4420 (gateway ports 0, Valkey db 3) and web port 5179.

## 1. Commits

| Commit | Scope |
|---|---|
| `26f08e0` | Inventory API: `GET /inventory/dashboard`, `GET /inventory/replace/candidates`, `POST /inventory/replace`; licence-isolation spec extended; scratch-DB replacement + dashboard tests |
| `699715f` | SIM management Phase C: migration, shared statuses / transition table, `/api/sims`, tenant `/api/asset-links`, tests |
| `84f5cf4` | Web: tabbed Stock & Movements page (dashboard, stock with actions, ledger, receipts, locations, suppliers), SIM Cards page, tenant Devices & SIMs sheet, additive MasterPage props |
| last commit | Docs (this file, Phase D/E plan, screenshots, isolation probe script + output) |

## 2. Done

### 2.1 Device Inventory UI (B5/B7) — Platform → Stock & Movements (`sa_inventory`, Super Admin only)
- **Stock tab:** server-side search, sort, paging, column chooser, filters (location, model, supplier, assignment check), **status chips with counts**, CSV export (existing export rule), IMEI opens a **detail drawer**: stock facts, read-only customer / vehicle / licence (type + expiry), movement timeline (who, when, from → to, reason, reference, field diff).
- **Actions:** Receive stock (goods receipt: location, supplier, invoice no./date, model, unit cost, warranty, condition, pasted IMEI list with duplicate / invalid detection; new IMEIs go through the existing `AdminDevicesService.createInTx` path, no company, no seat), CSV import (**dry-run report first**, apply only after a clean check; template download), Change status (transition table; reason where required; optional location), Transfer (location; refused for units at a customer), Adjust (mandatory reason, field diff), Sync with assignment (when flagged), Replace on vehicle.
- **Movements / Receipts tabs:** read-only ledger (filters kind, location, date range; CSV) and receipt list.
- **Locations / Suppliers tabs:** CRUD with the existing MasterPage + FormDialog patterns (in-use rows cannot be deleted; deactivate).
- Phase 1 design tokens (soft badge tokens, chart colours from CSS variables), Light and Dark verified, phone width verified.

### 2.2 Inventory dashboard
Tiles (tracked / untracked, in stock, at customers, needs attention, assignment mismatches, stock value), donut by status, stacked daily movement chart (14 / 30 / 90 days, by kind), bars by location with value, model breakdown (in stock / at customers / needs attention), valuation by status (sum of recorded `unitCostPaise`; retired excluded; no accounting valuation, QI-23). Read-only, inventory tables only; status counts and value come from the same grouped query so they always agree.

### 2.3 Replacement flow
`POST /inventory/replace { objectId, newDeviceId, oldStatus (FAULTY | RETURNED | UNDER_REPAIR), returnLocationId?, reason, reference?, note? }`:
1. Read-only checks: the vehicle has a fitted unit; the replacement is active, **already in the vehicle's customer account** (put there via Device Inventory = the existing flow that applies the licence rules), not fitted elsewhere, not faulty / repair / returned / retired in stock.
2. Fitting through the **existing vehicle assignment flow**: `ObjectsService.update(ctx-as-company, objectId, { deviceId })` → `assignDevice` closes the old `DeviceAssignment` and opens the new one, with its own audit entry and cache invalidation.
3. Inventory record (`InventoryStockService.recordReplace`, one transaction): REPLACE movement for each unit (linked by reference), removed unit → chosen status + return location, fitted unit → status implied by its real assignment (ACTIVE), audit `stock_replace`. Devices without a stock row (legacy) still get the ledger entry.

**Licence seat behaviour (documented and tested):** the replacement itself changes **no seat**. `assignDevice` never calls the seat services; inventory never writes `Device` or `LicenceSeat`. Each device keeps the seat the existing rules gave it: the new unit took a seat when Device Inventory put it in the customer account (existing `ensureDevice`, 402 / override as today); the removed unit keeps its seat while it stays in the account. Freeing that seat is the existing Device Inventory move back to stock (`releaseDevice`, seat stays in the customer's pool). Moving a seat between devices does not exist and is not implied (QI-13 default A: explicit, audited action, licence workstream). Response always carries `seatsChanged: false`.
Known limitation: steps 2 and 3 are two transactions. If step 3 fails, the API returns 409 explaining that the vehicle fitting is done and the units must be synced / adjusted; the mismatch flag shows it.

### 2.4 SIM management Phase C — Platform → SIM Cards (`sa_sim_cards`, superAdminOnly)
- **Schema:** `SimProvider`, `SimPlan` (cost, optional customer price — QI-3 open), `SimCard` (ICCID unique + normalised, MSISDN unique, IMSI, status, ownership PLATFORM/PARTNER/CUSTOMER — QI-4, stock location, activated / renewal dates), `SimAssignment` (one open row per SIM and per device, partial UKs), `SimEvent` (append-only history), `SimUsage` (manual usage / cost entries, append-only).
- **Statuses (shared):** Available, Reserved, Active, Suspended, Expired, Deactivated, Damaged. Transition table (full 7×7 matrix tested): AVAILABLE → RESERVED/ACTIVE/DAMAGED/DEACTIVATED; RESERVED → AVAILABLE/ACTIVE/DAMAGED/DEACTIVATED; ACTIVE → SUSPENDED/EXPIRED/DEACTIVATED/DAMAGED; SUSPENDED → ACTIVE/EXPIRED/DEACTIVATED/DAMAGED; EXPIRED → ACTIVE/DEACTIVATED; DAMAGED → DEACTIVATED; DEACTIVATED terminal. Reason required for Suspended / Deactivated / Damaged; Deactivated / Damaged only when out of a device; only Available / Reserved / Active / Suspended SIMs can be fitted.
- **API `/api/sims`:** providers / plans CRUD; register; edit descriptive fields (diff recorded); status; assign / transfer (moving a SIM, or displacing the SIM already in the target device, records UNASSIGN events) / unassign; renew (expired → active); usage entries; per-SIM history, device history, usage; global history; summary; renewals report (overdue / due within N days — **report only, no outbound messages**); reconciliation (tracker `Device.iccid` / tenant `Device.simNumber` vs managed SIM, report only); CSV import with dry run (template, header aliases, in-file and DB duplicate checks); CSV export.
- **Device fields stay as they are:** SIM code never writes `Device` (`iccid`, `simNumber`, `simOperator` read-only), never `DeviceAssignment`, seats or invoices. (Phase A had proposed mirroring MSISDN into `Device.simNumber`; not done per this run's "read-only link" rule — open decision below.)
- **UI:** SIM list with summary tiles and status chips, filters (provider, plan, in device, renewal window, reconciliation), register / edit form, detail drawer (device, tracker ICCID, renewal countdown, plan cost, device history, usage table with total, event timeline), actions (status, fit / move, take out, renew, add usage), CSV import with dry-run report, renewals report tab, providers, plans, history.

### 2.5 Customer portal read-only view
`GET /api/asset-links/objects/:objectId` (`objects:view`) and `/asset-links/devices/:deviceId` (`devices:view`), scoped with the existing `objectScopeWhere` / `deviceScopeWhere` (own company; ASSIGNED roles only their branches / objects; shared vehicles excluded; Super Admin "all companies" mode honoured). Returns fitted device(s), model, existing SIM number, licence status / expiry, and — only when `INVENTORY_TENANT_SIM_VIEW=true` (QI-21 default A, **shipped off**) — the managed SIM's MSISDN, status and renewal date. Never cost, price, plan, provider or ICCID (static test + probe). Web: "Devices & SIMs" row action on Vehicles & Objects (rows with a device). No new tenant menu (no role-sync rollout).

### 2.6 Phase D / E
Assessment and design only: [phase-d-e/PLAN.md](phase-d-e/PLAN.md).

## 3. Migrations

| Migration | Content | Tested on |
|---|---|---|
| `20261109090000_device_inventory` | (Phase B, already in v1.3.0) | `veetrax_inv2` |
| `20261110100000_sim_management` | **New, additive only:** 6 tables, indexes, FKs (`SimAssignment`/`SimEvent` → Device **SET NULL**, `SimUsage` → SimCard RESTRICT, `SimCard.locationId` SET NULL), partial UKs `SimAssignment_open_sim_key` / `_open_device_key`, CHECKs on money / counters / period. No `ALTER`/`DROP` of existing objects. | `veetrax_inv2`: `prisma migrate deploy` OK; `prisma migrate diff` DB → schema: **No difference detected** |

Rollback (manual, owner-approved; loses SIM data only):
```sql
BEGIN;
DROP TABLE "SimUsage", "SimEvent", "SimAssignment", "SimCard", "SimPlan", "SimProvider";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261110100000_sim_management';
COMMIT;
```
Then revert `699715f` (and the SIM parts of `84f5cf4`). Production migration requires owner approval.

Purge interaction: SIM tables reference `Device` only by SET NULL FKs, so the catalogue-driven purge leaves SIM history intact (IMEI / ICCID snapshots in `deviceRef` / `iccidRef`); a SIM with usage entries cannot be deleted (RESTRICT + service guard).

## 4. Tests (actual results, 2026-11-09)

| Run | Result |
|---|---|
| `npx jest` (apps/api, no scratch DB) | **114 suites passed, 3 skipped; 1055 tests passed, 24 skipped** (1079) |
| `npx jest` with `INVENTORY_IT_DATABASE_URL=…/veetrax_inv2` | **116 suites passed, 1 skipped; 1074 passed, 5 skipped** (the skipped suite is the purge-financial integration suite, which needs its own env) |
| Inventory + SIM suites only (`src/inventory src/sims`, scratch DB) | **10 suites, 137 tests passed**, both parallel and `--runInBand` |
| `npm test` (apps/web, node --test) | **121 passed, 0 failed** (incl. new `inventory-format.test.ts`, 6 tests) |
| `npx tsc --noEmit` apps/api · `npx tsc -b --noEmit` apps/web · `npx tsc --noEmit` apps/mobile | clean |
| `npm run build` (apps/web) | OK |
| `scripts/inventory-isolation-probe.ts` against :4420 | **34/34 PASS** ([output](screenshots/isolation-probe-output.txt)) |

New / extended suites: `sims/sim-status.spec.ts` (62 tests incl. the full transition matrix, normalisation, renewal buckets, reconciliation, menu never granted to tenant roles, QI-21 flag), `sims/sim-csv.spec.ts`, `sims/licence-isolation.spec.ts` (static), `sims/sims.integration.spec.ts` (scratch DB), `inventory/replace.integration.spec.ts` (scratch DB + `dayKeys` unit), `inventory/licence-isolation.spec.ts` (extended: replacement uses only `ObjectsService.update`, REPLACE movements inside one transaction, dashboard read-only).

## 5. Licence-safety evidence

- **Static (every new operation):** inventory sources (incl. `replace.service.ts`, `dashboard.service.ts`) and SIM sources (incl. `asset-links.service.ts`) contain no seat service / `.licenceSeat.` access, no `Device` writes, no `DeviceAssignment` writes, no Transfer / Claim / Companies services; SIM sources also no `AdminDevicesService`, `ObjectsService`, invoice / order / billing access or raw SQL writes. The replacement's only cross-module write is `this.objects.update(asCompany, object.id, { deviceId: next.id })`.
- **Database (scratch):** before / after snapshots of all `LicenceSeat` rows and `Device.companyId / isActive` (SIM suite also `simNumber / simOperator / iccid` and all `DeviceAssignment` rows) are identical around: replacement (with both devices licensed and the old one fitted), refused replacements, every SIM operation (register, status, assign / transfer / displace / unassign, renew, damage, deactivate), SIM CSV import. Seat-service stubs record zero calls. Seats of both replaced devices still belong to the customer afterwards. (Snapshots cover every seeded row plus the suite's own rows; rows of other DB suites running in parallel are excluded and the `--runInBand` run gives the same result.)
- **HTTP probe:** tenant admins get 403 on every `/inventory/*` and `/sims/*` route tried (incl. replace and import), anonymous 401.

## 6. Tenant-isolation evidence
`sims.integration.spec.ts` (service level, company A vs a test company B): own vehicle / device readable; B's vehicle and device, A's device from B, platform stock devices and ASSIGNED-scope objects outside the user's list → 404; SIM fields hidden unless the flag is on; payload keys limited to `msisdn`, `status`, `renewalDueAt`. `scripts/inventory-isolation-probe.ts` (HTTP, modelled on `tenant-isolation-probe.ts`, refuses :4000; creates "Isolation Probe Co" on the scratch instance if needed): same checks end-to-end plus an `X-Company-Id` switch attempt by a tenant (404) — 34/34 PASS.

## 7. Screenshots (running app, scratch DB)
`docs/inventory-modules/screenshots/`: `01`/`01b` dashboard, `02` stock list, `03` status chip filter, `04` detail drawer with history, `05` receive stock, `06` CSV import dry-run report, `07` replace dialog, `08` ledger after replacement, `09` locations, `10` suppliers, `11` receipts, `12` replacement unit detail, `13` SIM list, `14` SIM drawer, `14b` move SIM dialog, `15` renewals report, `16` plans, `17` SIM import dry run, `18`–`20` dark theme, `21`–`22` phone width, `23`–`24` tenant Devices & SIMs, `25` tenant blocked from inventory. Demo data was created through the public API by a session seed script (not committed); the "System critical" banner is the scratch environment (no notifier / processor running).

## 8. Remaining
1. **B6 hooks** in Ship / Unship / Claim / admin move / Transfer / `assignDevice` so stock status follows the existing flows automatically (today: mismatch flag + Sync). Needs review by those flows' owners.
2. **Backfill apply** (Phase B §5) after owner approval — until then most production devices are "untracked" and the dashboard covers received stock only.
3. SIM: renewal reminder *job* (C5 sends nothing today, by design of this run), optional mirroring of MSISDN into `Device.simNumber` (decision), SIM column in Device Inventory.
4. Replacement: optional single-transaction variant (would need `assignDevice` exposed as a tx-level helper from `ObjectsService`).
5. i18n strings (hi / ta) for the new UI; partner stock view (Phase F, QI-1).
6. Phases D and E per [PLAN](phase-d-e/PLAN.md).

## 9. Risks
- Replacement is two transactions (fitting, then inventory record); failure leaves a visible mismatch, not a silent inconsistency.
- `INVENTORY_TENANT_SIM_VIEW` is an environment flag (no schema); production default must stay off until QI-21 is approved.
- MasterPage gained two optional props (`fixedParams`, `aboveTable`); all existing pages are unaffected (props default to undefined), but it is a shared component.
- Integration suites share one scratch DB; global snapshots exclude rows tagged by other parallel suites (`IT…`/`RP…`/`SM…`).

## 10. Open owner decisions (provisional defaults used, nothing commercial changed)
| Ref | Decision | What this run assumed |
|---|---|---|
| QI-13 | Seat on replacement / RMA | No seat moves; explicit seat action left to the licence workstream |
| QI-14 | Warranty / RMA commercial terms | REPLACE is zero-value; no invoice line |
| QI-15 | Retired / lost device | No automatic deactivation or seat release |
| QI-3 | SIM billing | `pricePaise` optional, unused |
| QI-4 | SIM ownership | PLATFORM / PARTNER / CUSTOMER stored, BYO tracking only |
| QI-21 | Tenant SIM visibility | Option A behind `INVENTORY_TENANT_SIM_VIEW` (off by default) |
| QI-23 | Valuation | Sum of recorded unit cost only |
| New | Mirror managed MSISDN into `Device.simNumber` on assign? | Not done (read-only link) |
| New | Separate `sa_sim_cards` menu vs extending `sa_device_inventory` | Separate menu (Phase A recommendation) |

## 11. Estimate for the rest
B6 hooks + backfill apply: 3–4 dev-days (+ owner approval). SIM reminder job, Device Inventory SIM column, i18n: 2–3 dev-days. Phase D: 6–8 dev-days. Phase E: 15–20 dev-days + accountant sign-off.
