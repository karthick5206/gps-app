# 03 — Report Inventory

Branch `feature/modernization-phase0` · baseline `main@17a2e63` · 2026-11-09 · **Phase 0: no code changed.**

**Status labels used in this document:**
- **Verified**: implemented and verified. The code path was read **and** the report was run on the isolated assessment instance (synthetic data, screenshot evidence).
- **Implemented, not verified**: the code was read but the report was not run.
- Labels for anything partial, missing or defective are stated per row.

**Sources:**
- Catalogue: [packages/shared/src/history.ts:97-129](../../packages/shared/src/history.ts#L97-L129).
- UI definitions: [apps/web/src/features/reports/report-columns.tsx:684-717](../../apps/web/src/features/reports/report-columns.tsx#L684-L717).
- Data: `apps/api/src/reports/report-data.service.ts` (RDS) and `report-queries.ts` (RQ).
- Detailed write-ups: [Phase 2 Reports plan](../discovery/phase2/REPORTS_ENHANCEMENT_PLAN.md).

## 1. Rules that apply to every report (Confirmed)
| Rule | Value | Evidence |
|---|---|---|
| Report types | 31 in 10 UI groups | history.ts:97-129 |
| Scope | branches / vehicle groups / vehicles; empty = everything the user can access (data scope enforced server-side) | Phase 1 [02 §5](../discovery/02-architecture-and-platform.md#5-authorization-model); tenant probe §4 below |
| Period | `from`/`to` as `YYYY-MM-DD`, interpreted in the **company** time zone; ≤366 days (POSITIONS 7, GEOFENCE_DISTANCE 31) | `reports.dto.ts:23-24`, RDS:53,78 |
| On-screen limit | 10,000 rows (totals still cover all rows) | RDS:52 |
| File limits | XLSX/CSV 50,000 rows, PDF 5,000 | `report-files.ts:12` |
| Formats | XLSX, PDF, CSV for all 31 (server-side) | `reports.controller.ts:33-43`, ReportsPage.tsx:47-51 |
| Schedulable | all except POSITIONS | `report-schedules.dto.ts:25` |
| Permissions | `reports:view` to run, `reports:export` to download; attendance reports also need `attendance:view` | `reports.controller.ts:14,33`, RDS:278 |
| Shared vehicles | only a subset of types | `packages/shared/src/vehicle-shares.ts:27`, RDS:138 |
| On-screen charts | **SUMMARY only** | ReportsPage.tsx:291 |
| Drill-down | **GEOFENCE_DISTANCE only** ("View on map") | report-columns.tsx:78-89 |
| Ad-hoc run history | **Missing**: only scheduled runs are recorded | `reports.controller.ts`, RunsSheet.tsx:27 |

## 2. Catalogue
| # | Key | Label · group | Source | Options beyond scope + period | Status |
|---|---|---|---|---|---|
| 1 | SUMMARY | Summary · Activity | DailySummary | Group by day/week/month | **Verified** ([20](../discovery/screenshots/phase2/20-reports-summary-result.png)) |
| 2 | CONSOLIDATED | Consolidated · Activity | DailySummary + Alert + GeofenceVisit | — | **Verified** ([27](../discovery/screenshots/phase2/27-reports-consolidated-result.png)) |
| 3 | DISTANCE | Distance · Activity | DailySummary | Group by | Implemented, not verified |
| 4 | ENGINE_HOURS | Engine hours · Activity | DailySummary | Group by | Implemented, not verified |
| 5 | TRIPS | Trips · Activity | Trip | — | **Verified** ([24](../discovery/screenshots/phase2/24-reports-trips-result.png)); **defective presentation**, see D-1 |
| 6 | STOPS | Stops · Activity | Stop + POI | min duration | Implemented, not verified |
| 7 | HALT | Halts · Activity | Stop (ignition off) | min duration (default 30) | Implemented, not verified |
| 8 | POSITIONS | Positions · Activity | Position (1 vehicle, ≤7 d) | — | **Verified** ([24b](../discovery/screenshots/phase2/24b-reports-positions-result.png)) |
| 9 | IDLE | Idling · Driving | Stop (ignition on) | min duration | Implemented, not verified |
| 10 | OVERSPEED | Over-speed · Driving | Position (raw scan) | ignore < N s (default 10) | **Verified** ([25](../discovery/screenshots/phase2/25-reports-overspeed-result.png)) |
| 11 | CONTINUOUS_DRIVING | Continuous driving · Driving | Trip | driving limit / break | Implemented, not verified |
| 12 | DRIVERS | Driver activity · Driving | DriverAssignment + Trip + Alert | — | Implemented, not verified |
| 13 | IGNITION | Ignition on/off · Driving | Position | — | Implemented, not verified |
| 14 | ALERTS | Alerts · Events | Alert | event types | **Verified** ([26b](../discovery/screenshots/phase2/26b-reports-alerts-result.png)) |
| 15 | EVENT_SUMMARY | Event summary · Events | Alert | event types | **Verified** ([26](../discovery/screenshots/phase2/26-reports-event-summary-result.png)) |
| 16 | GEOFENCE_VISITS | Geofence visits · Geofences | GeofenceVisit | — | Implemented, not verified |
| 17 | GEOFENCE_SUMMARY | Geofence summary · Geofences | GeofenceVisit | — | Implemented, not verified |
| 18 | GEOFENCE_DISTANCE | Geofence out-to-in distance · Geofences | GeofenceVisit + Position | — (≤31 d) | Implemented, not verified |
| 19 | POI_VISITS | POI visits · Geofences | Poi + Stop | — | Implemented, not verified |
| 20 | FUEL | Fuel (sensor) · Fuel | FuelConfig/Position/DailySummary/FuelEvent | — | Implemented, not verified (needs fuel-sensor data) |
| 21 | FUEL_EVENTS | Refills & drains · Fuel | FuelEvent | — | Implemented, not verified |
| 22 | MILEAGE | Mileage (manual) · Fuel log | Expense fill-ups | — | Implemented, not verified |
| 23 | AC_DOOR | AC / Door · Sensors | IoSession | — | Implemented, not verified |
| 24 | AC_DOOR_DAILY | AC / Door daily · Sensors | IoSession | — | Implemented, not verified |
| 25 | DEVICE_STATUS | Device status · Devices | DeviceAssignment + latest Position | inactive after N min | Implemented, not verified. **Ignores the period** (current state) |
| 26 | DOCUMENTS | Documents & services · Compliance | Document, Driver, ServiceReminder | — | Implemented, not verified. **Ignores the period** |
| 27 | ATTENDANCE_DAILY | Daily attendance · Staff attendance | Attendance | — | Implemented, not verified |
| 28 | ATTENDANCE_SUMMARY | Attendance summary | Attendance | — | Implemented, not verified |
| 29 | ATTENDANCE_PAYROLL | Payroll | Attendance | — | Implemented, not verified. **Payroll rules must not change** (§5.8) |
| 30 | ATTENDANCE_OUTINGS | Time outside | AttendanceOuting | — | Implemented, not verified |
| 31 | ATTENDANCE_CORRECTIONS | Attendance corrections | AttendanceDay | — | Implemented, not verified |

## 3. Overlaps, duplicates and gaps
| Type | Item | Assessment | Status label |
|---|---|---|---|
| Overlap | DISTANCE and ENGINE_HOURS are column subsets of SUMMARY (same rows) | Not harmful; users may not know which to pick. Keep (customers may schedule them); clarify descriptions | Requires product-owner decision (keep / alias) |
| Overlap | STOPS vs HALT vs IDLE: one Stop source filtered by ignition | Distinct meanings (all stops / engine-off stops / engine-on stops); names are not self-explanatory | Keep; add descriptions |
| Duplicate surface | CONSOLIDATED report = Dashboard **Compare** tab data | Two UIs over one query; Compare has no XLSX | Deprecated/duplicate surface; consolidate UI only |
| Duplicate surface | DMS page CSV vs no DMS report type | DMS counts are exportable only from the DMS page | Gap |
| Gap | No **Driver score** report (the scorecard page has no export) | | Missing |
| Gap | No **DMS/ADAS event** report type (Driver events page exists) | | Missing (as report) |
| Gap | No customer-facing **licence/renewal** report | Billing pages exist (see 00 §licensing) | Missing |
| Gap | No **user activity / audit** report for customers (Audit Log page exists, export permission exists) | | Requires product-owner decision |
| Defect | **D-1: time zone presentation.** Period is resolved in the company TZ; row timestamps render in the browser TZ without a label (viewer in PST saw "02 Nov 04:30 pm" in a "3–9 Nov" report) | [24](../discovery/screenshots/phase2/24-reports-trips-result.png) | **Defective** (presentation) |
| Defect | **D-2: scheduled reports drop report options** (alert types, halt minutes, overspeed duration…) and always use defaults | `report-schedules.service.ts:219-221` | **Defective** |
| Defect | **D-3:** Schedule form says the period is "used by the Summary report" but it also applies to DISTANCE and ENGINE_HOURS | ScheduledReportsPage.tsx:127 | Defective (copy) |
| Risk | Run and Run-now are synchronous HTTP requests | ReportsPage.tsx:110, service:152-156 | Partially implemented (no async jobs) |
| Risk | Report files and ReportRun rows have no retention | Phase 1 [11](../discovery/11-database.md) | Missing |

## 4. Report data isolation (verified on the isolated instance, 2026-11-09)
A second tenant ("Beta Transport (assessment)") was created through the Super Admin API. Its admin ran `POST /api/reports/run {type:TRIPS, scope.objectIds:[<Demo Logistics vehicle>]}` and got **200 with `rows: []`**. The same request by the Demo admin returned that vehicle's trips. Foreign IDs are silently filtered out, not rejected. That is acceptable, but should be covered by an automated test (see [09-test-strategy.md](09-test-strategy.md)).

## 5. Performance baseline (isolated instance; 20 vehicles, ~302k positions, 896 trips; median of 5)
| Call | Median |
|---|---|
| SUMMARY, 7 days, whole fleet | 19 ms |
| TRIPS, 7 days, whole fleet (640 rows) | 37 ms |
| OVERSPEED, 7 days, whole fleet (raw Position scan) | 66 ms |
| Export TRIPS XLSX, 7 days | 95 ms |

These are **small-fleet baselines only**. They must be re-measured at 2,000 simulated devices (`npm run sim:register -- --count 2000`) before any performance claim is made (assignment §16).
