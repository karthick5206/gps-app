# Reports & Analytics — report-by-report assessment

Branch `feature/reports-analytics` (base production v1.3.0 @ 07077b6) · 2026-11-09.
Sources: `packages/shared/src/history.ts` (catalogue), `apps/web/src/features/reports/report-columns.tsx` (UI columns),
`apps/api/src/reports/*` (data, totals, exports), [REPORTS_ENHANCEMENT_PLAN](../discovery/phase2/REPORTS_ENHANCEMENT_PLAN.md),
[03-report-inventory](../modernization/03-report-inventory.md).

**Legend.** Data ✔ = buildable from rows/totals the API already returns. ✚ = needs backend (listed in §3).
**B1** = delivered in batch 1 (this branch). Every report's rows, totals, limits and export content are unchanged:
proven by the golden test (`apps/api/src/reports/reports-golden.int.spec.ts`, 47 type/option variants, see PROGRESS.md).

## 0. Cross-cutting findings

| # | Finding | Status |
|---|---|---|
| D-1 | Row timestamps rendered in the **browser** zone, unlabelled, while periods/exports/schedules use the **company** zone (a "3–9 Nov" Trips report started "02 Nov 04:30 pm") | **Fixed B1**: cells in company zone, headers "Start (IST)", result header "Times in IST (Asia/Kolkata)", presets and "today" on company days. Exports already use the company zone (`report-columns.ts` `localTime(…, tz)`, period line in `report-files.ts`): verified, unchanged |
| D-2 | Scheduled reports dropped report options | **Fixed B1**: `ReportSchedule.options` JSONB (additive), validated like on-screen runs, passed per type; schedules without options send none (unit-tested). E2E on the scratch API: a schedule with ALERTS=[OVERSPEED] emailed 5 alerts vs 31 unfiltered for 8 Nov |
| D-3 | "Summary grouping · Used by the Summary report" copy | **Fixed B1**: "Group rows by · Used by the Summary, Distance and Engine hours reports" |
| — | 10,000-row on-screen cap: totals cover all rows, row-based charts do not | B1: KPI values from API totals; charts show "based on the first N of M rows"; row-derived KPIs marked `*` |
| — | Location column shows coordinates when `GEOCODER=none` | Config (self-hosted geocoder); POI/geofence-name fallback is ✚ (§3) |
| — | Run / Run-now synchronous | RP-10, batch 4 |

## 1. The 31 report types

| # | Type | Output · Source | Issues | Proposed (viz / KPIs / filters / drill-down / export) | Data | B1 |
|---|---|---|---|---|---|---|
| 1 | SUMMARY | vehicle × period; totals `summaryTotals` · DailySummary | Charts not interactive; no per-vehicle view | KPIs distance/running/idle/trips/utilisation/vehicles; period bars click-to-filter; distance-by-vehicle ranking; later branch split, period compare (RP-5) | ✔ | **KPIs + clickable charts + ranking** |
| 2 | CONSOLIDATED | 1 row/vehicle, alerts, geofence visits · DailySummary+Alert+GeofenceVisit | Same query as Dashboard Compare | KPIs vehicles(active)/km/running/idle %/alerts/overspeed; ranked km and alerts; vehicle → filter; later km-vs-idle scatter | ✔ | **KPIs + 2 ranked charts** |
| 3 | DISTANCE | vehicle × period km, trips, running, offline · DailySummary | Column subset of SUMMARY | Period bars (kit reuse); clearer description | ✔ | search/descriptions |
| 4 | ENGINE_HOURS | engine/running/idle/idle % · DailySummary | Subset of SUMMARY + idle % | KPIs engine/running/idle/idle %; stacked running+idle per period; idle ranking; → Idling | ✔ | **KPIs + stacked bars + ranking** |
| 5 | TRIPS | trips; totals count/km/duration/idle/max · Trip | D-1; coordinates; no path to map | KPIs trips/km/driving/avg/longest*/top speed; trips per day (km in tooltip); km by vehicle; **Play in History**; later duration histogram, hour-of-day strip, min km/duration filters | ✔ | **all but histogram/filters** |
| 6 | STOPS | parked/idle stops, POI · Stop+Poi | Stops/Halts/Idling names unclear | KPIs, duration histogram, top locations (batch 2); **Play in History** | ✔ | drill-down, keywords |
| 7 | HALT | engine-off stops ≥ N min (30) · Stop | as Stops | as Stops | ✔ | drill-down |
| 8 | POSITIONS | raw points, 1 vehicle ≤ 7 d · Position | Not schedulable (by design) | Speed-over-time line; row → History instant; speed/alarm filters | ✔ | — |
| 9 | IDLE | engine-on stops · Stop | Empty in fixture | KPIs idle time; top idlers; fuel-waste estimate ✚ | ✔ / ✚ | drill-down |
| 10 | OVERSPEED | episodes; totals count/duration/max · Position scan | Heavy raw scan for long ranges | KPIs episodes/time over/peak/avg episode/vehicles*; episodes per day; time over limit by vehicle; **Play in History** (±2 min); later min-excess filter, peak locations | ✔ | **KPIs + 2 charts + drill-down** |
| 11 | CONTINUOUS_DRIVING | stretches without break · Trip | Empty in fixture | Longest stretch vs limit; **Play in History** | ✔ | drill-down |
| 12 | DRIVERS | per driver km/driving/overspeed · DriverAssignment+Trip+Alert | No link to scorecard | Ranked bars per driver; → scorecard | ✔ | — |
| 13 | IGNITION | every change + previous state · Position | Long tables | On/off Gantt per vehicle; **Play in History** (±15 min) | ✔ | drill-down |
| 14 | ALERTS | alerts + severity totals · Alert | No severity/status filter | KPIs total/critical/warning/info/vehicles*; per-day stacked by severity; by-type ranking (click → filter); **Play in History** (±15 min); severity/ack filters ✚ small | ✔ | **KPIs + 2 charts + drill-down** |
| 15 | EVENT_SUMMARY | vehicle × type counts · Alert | Hard to scan | **Heatmap vehicle × type** (25 × 12 busiest + totals), cell → table filter; later cell → Alerts pre-filtered | ✔ | **KPIs + heatmap + filter** |
| 16 | GEOFENCE_VISITS | entries/exits · GeofenceVisit | — | Visits per geofence; dwell distribution; **Play in History** | ✔ | drill-down |
| 17 | GEOFENCE_SUMMARY | visits/time per vehicle × geofence · GeofenceVisit | Open visits counted to DB `now()` (time-dependent) | Bars per geofence | ✔ | — |
| 18 | GEOFENCE_DISTANCE | out-to-in trips + map link · GeofenceVisit+Position | Only drill-down before B1 | Travel-time bars per pair | ✔ | link pattern reused |
| 19 | POI_VISITS | arrivals/departures · Poi+Stop | Empty in fixture | Visits per POI/category; → History | ✔ | — |
| 20 | FUEL | per vehicle/day · FuelConfig/Position/FuelEvent | Needs sensor data | Daily level and km/L trend ✔; intraday level line ✚ | ✔ / ✚ | — |
| 21 | FUEL_EVENTS | refills/drains · FuelEvent | — | Timeline, suspicious drains; → History | ✔ | — |
| 22 | MILEAGE | full-tank runs · Expense | Separate from FUEL by design | km/L and cost/km trend | ✔ | — |
| 23 | AC_DOOR | IO sessions · IoSession | — | Timeline; AC with engine off highlighted | ✔ | — |
| 24 | AC_DOOR_DAILY | per day totals · IoSession | — | AC-on hours per day | ✔ | — |
| 25 | DEVICE_STATUS | current state (ignores period) · DeviceAssignment+Position | Date inputs shown but ignored | Status distribution + time-without-data buckets; hide dates for this type | ✔ | — |
| 26 | DOCUMENTS | status today (ignores period) · Document/ServiceReminder | Period ignored | Due-soon timeline 30/60/90 d | ✔ | — |
| 27 | ATTENDANCE_DAILY | person × day · Attendance | 24 columns | Present/late/absent per day | ✔ | column chooser |
| 28 | ATTENDANCE_SUMMARY | person × period | — | Attendance % ranking | ✔ | — |
| 29 | ATTENDANCE_PAYROLL | payable/LOP days | **Payroll rules must not change** | Display only | ✔ | — |
| 30 | ATTENDANCE_OUTINGS | time outside | — | Minutes outside by person | ✔ | — |
| 31 | ATTENDANCE_CORRECTIONS | manual changes | — | — (audit table) | ✔ | — |

All 31 types also get in B1: catalogue search/favourites/recents/descriptions, company-zone timestamps, sticky first
column, column chooser, quick filter, phone card layout, shared date presets and "Schedule this" (not POSITIONS).

## 2. Duplicates and overlaps (nothing removed)

| Overlap | Assessment | Recommendation |
|---|---|---|
| DISTANCE, ENGINE_HOURS ⊂ SUMMARY | Customers may already schedule them | Keep; search keywords and descriptions explain; aliasing is an owner decision |
| STOPS / HALT / IDLE (one Stop source, ignition filter) | Distinct meanings | Keep; keywords ("parking", "engine on") |
| CONSOLIDATED vs Dashboard Compare | Same query, two UIs, Compare has no export | Later: Compare links to the report |
| FUEL vs MILEAGE | Sensor vs manual | Keep |
| ALERTS vs EVENT_SUMMARY | Rows vs counts | Keep; heatmap cell → filtered Alerts (batch 2) |

## 3. Needs backend (✚) — documented, not faked

| Item | Why | Size |
|---|---|---|
| Per-type aggregates in `/reports/run` for capped runs | Exact charts beyond 10,000 rows (B1 shows a notice) | S, additive field |
| PDF/XLSX with KPI block, chart, logo, filters (RP-7) | **Done B2** (`summary` flag on `/reports/export`); per-company logo still ✚ (platform logo used) | — |
| Trip from/to as POI or geofence name | Readable rows without a geocoder | S |
| Ad-hoc run history and export audit (RP-8) | ReportRun `source` column, retention | M |
| Test-send to me, failure notification (RP-9) | `POST /report-schedules/:id/test`, notifier | S–M |
| Background report jobs (RP-10) | Valkey streams | L |
| Fuel intraday level line | Position-level fuel series | M |
| Idle fuel-waste estimate | Idle litres/hour per model (new master field) | S |
| Presets/favourites synced across devices | Preference table (B1 keeps them per browser) | S |
| Alerts severity/status filter | `ReportOptions.severities/statuses` (additive) | S |

## 4. Useful missing reports / analytics

| Proposal | Data requirement | Available? |
|---|---|---|
| Driver score report (scorecard has no export) | driver-scores output per period | ✔, needs report type |
| DMS / ADAS events report | DriverEvent | ✔ |
| Utilisation and idle trend over weeks | DailySummary | ✔ |
| Period vs period (RP-5) | two runs, client diff | ✔ |
| Night / time-window driving | Trip + time windows | ✔ |
| Geofence dwell SLA (late/early at site) | Visits + targets per geofence | ✔ / small ✚ for targets |
| Cost per km (fuel + expenses) | Expense + DailySummary | ✔ |
| Licence / renewal report for customers | LicenceSeat / billing | ✔, owner decision |
| User activity / audit export | AuditLog | ✔, owner decision (privacy) |

## 5. Batches

- **Batch 1 (this branch):** RP-1, D-1, RP-2 (7 types), RP-3, RP-6 (no virtualisation/grouping), date presets, D-2, D-3, "Schedule this".
- **Batch 2 (done, see PROGRESS.md):** exports (PDF summary/logo/KPI/chart, XLSX Summary sheet, "export filtered view"); insights for Stops/Halts/Idling, Geofences, Fuel, Drivers; heatmap → Alerts; histograms.
- **Batch 3:** period comparison, report presets, ad-hoc history ✚, test-send + failure alerts ✚, alerts severity filter ✚.
- **Batch 4:** background jobs (RP-10), per-type aggregates for capped runs, virtualised table / group-by.
