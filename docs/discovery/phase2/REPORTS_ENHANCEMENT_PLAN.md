# Reports & Scheduled Reports — Enhancement Plan

**Status:** proposal for review. Nothing here is implemented.
Evidence: [VISUAL_ASSESSMENT.md §4.2–4.3](VISUAL_ASSESSMENT.md#42-reports--reportspagetsx-reporttabletsx-summarychartstsx-report-columnstsx), screenshots in [`../screenshots/phase2/`](../screenshots/phase2/). Mock-ups in [`mockups/`](mockups/) are **proposals, not the current application**.

Legend:
- **Data: Existing** means it can be built from data the API already returns or already stores; it is a web-only change, or an additive optional parameter at most.
- **Data: New backend** means it needs new aggregation, storage or endpoints.

---

## 1. How reports work today (Confirmed in code)

| Aspect | Today | Reference |
|---|---|---|
| Catalogue | **31 types** in 10 groups: Activity, Driving, Events, Geofences, Fuel, Fuel log, Sensors, Devices, Compliance, Staff attendance | [history.ts:97-129](../../../packages/shared/src/history.ts#L97-L129), [report-columns.tsx:684-717](../../../apps/web/src/features/reports/report-columns.tsx#L684-L717) |
| Selection UI | Vertical rail with group headings; select on phones. No search, favourites or recents | [02](../screenshots/phase2/02-reports-teal.png), [29c](../screenshots/phase2/29c-reports-mobile-type-picker.png) |
| Charts | **Only SUMMARY** (two hand-made SVG bar charts, not exported as reusable components) | [ReportsPage.tsx:291](../../../apps/web/src/features/reports/ReportsPage.tsx#L291), [SummaryCharts.tsx:67](../../../apps/web/src/features/reports/SummaryCharts.tsx#L67) |
| Charting library | None. All charts are hand-rolled SVG/CSS (`Donut`, `BarList`, `BarChart`, `DailyChart`, `FleetBar`) | [dashboard/charts.tsx](../../../apps/web/src/features/dashboard/charts.tsx) |
| Result table | Client sort; sticky header and totals footer; shows 200 rows then "Show more" adds 1,000 at a time; no virtualisation, column picker, search or grouping | [ReportTable.tsx:8-109](../../../apps/web/src/features/reports/ReportTable.tsx#L8-L109) |
| Drill-down | Only GEOFENCE_DISTANCE has a "View on map" link | [report-columns.tsx:78-89](../../../apps/web/src/features/reports/report-columns.tsx#L78-L89) |
| Limits | On screen ≤10,000 rows (totals cover all); files ≤50k rows (XLSX/CSV) or 5k (PDF); period ≤366 days (POSITIONS 7, GEOFENCE_DISTANCE 31) | `report-data.service.ts:52-53`, `report-files.ts:12` |
| Addresses | ≤500 lookups per run (1,500 for Positions), 20 s budget. With `GEOCODER=none` (the default) every location is a coordinate | `address-enricher.ts:39-42`, [24](../screenshots/phase2/24-reports-trips-result.png) |
| Exports | Server-side XLSX (teal header, frozen panes, autofilter, totals), PDF (A4 landscape 7.5 pt, no logo, **no charts**) and CSV (UTF-8 BOM) | `report-files.ts:71-243` |
| Run execution | `/reports/run` is synchronous inside the HTTP request | [ReportsPage.tsx:110](../../../apps/web/src/features/reports/ReportsPage.tsx#L110) |
| Report history | **Only scheduled runs are recorded** (ReportRun). Ad-hoc runs and exports leave no trace. RunsSheet opens only from a schedule's row action | [RunsSheet.tsx:27](../../../apps/web/src/features/reports/RunsSheet.tsx#L27), [ScheduledReportsPage.tsx:242](../../../apps/web/src/features/reports/ScheduledReportsPage.tsx#L242) |
| Schedules | Daily, weekly or monthly at HH:mm in the company time zone; covers the previous complete period; one file with all chosen reports; 1–50 recipients | `report-schedules.dto.ts:32-46`, `schedule-time.ts:39-40` |
| Schedule gaps | **Report options are not stored**, so schedules always use defaults (no alert-type filter, 30-min halt and so on). No preview or test-send ("Run now" emails everyone). Failures are visible only in the run sheet; nobody is notified | `report-schedules.service.ts:219-221,251-254` |
| Comparison | None (no period vs period) | — |

---

## 2. Report-by-report opportunities

"Viz" is the summary visual proposed for the report. ✔ = can be built from existing data; ✚ = needs new backend.

| Report | Today | Best summary visual | Advanced filters | Drill-down | Data |
|---|---|---|---|---|---|
| Summary | 2 bar charts | Add **per-vehicle / per-branch** toggle, utilisation % line, hover tooltips | Branch/vehicle split | Bar → day rows → History | ✔ |
| Consolidated | table | KPI strip + **ranked bars** (km, idle %, alerts) + utilisation scatter (km vs idle) | min km, has alerts | Vehicle → Summary for that vehicle | ✔ |
| Distance | table | Bars per period (same rows as Summary) | Group by | Period → Trips | ✔ |
| Engine hours | table | Stacked bar engine = running + idle; idle % line | idle % ≥ x | → Idling report | ✔ |
| Trips | table, coordinates | KPI strip (trips, km, avg trip, longest); **duration histogram**; trips per hour-of-day heat strip | min km / min duration / time-of-day window | **Row → History playback at trip start** | ✔ (geocoding is config) |
| Stops / Halts / Idling | table | KPI strip; duration histogram; top locations (by POI or rounded coordinates) | min duration exists; add POI/area | Row → History at stop | ✔ |
| Positions | table (1 vehicle, ≤7 days) | Speed-over-time line (as in the History playback bar) | speed > x, ignition, alarm only | Row → History at that instant | ✔ |
| **Over-speed** | table | KPI strip (episodes, time over limit, peak, vehicles); **episodes per day**; top vehicles by time over limit; peak-location list | min duration exists; add min excess km/h, road/zone limit | Row → History | ✔ |
| Continuous driving | table | Bars of longest driving span vs limit line | limit/break exist | Row → History span | ✔ |
| Driver activity | table | Ranked bars per driver (km, driving time, overspeed) | driver multi-select | Driver → Scorecard / Trips | ✔ |
| Ignition on/off | table | Gantt-style on/off timeline per vehicle | — | Segment → History | ✔ |
| Alerts | table + severity totals | Severity KPI strip; **alerts per day by severity**; type breakdown | event types exist; add severity, status (acknowledged) | Row → Alert detail / History | ✔ (per-day grouping can be done client-side over returned rows) |
| **Event summary** | table vehicle × type | **Heatmap vehicle × type** (rows sortable) | event types | Cell → Alerts report filtered | ✔ |
| Geofence visits / summary | table | Visits per geofence bars; dwell-time distribution | geofence multi-select | → History at entry | ✔ |
| Geofence out-to-in | table + link | Travel-time bars per pair | geofence pair | existing link | ✔ |
| POI visits | table | Visits per POI/category | category | → History | ✔ |
| Fuel (sensor) | per-day table | **Fuel level line + refill/drain markers**; km/L trend | — | Day → Fuel events | ✔ (daily rows) / ✚ for an intraday level line |
| Fuel refills & drains | table | Events on timeline; suspicious drains highlighted | min litres | → History at event | ✔ |
| Mileage (manual) | table | km/L and cost/km trend per vehicle | — | → Expense entry | ✔ |
| AC / Door, daily | table | AC-on hours per day; AC with engine off highlighted | — | Day → sessions | ✔ |
| Device status | table (current state) | Status distribution + "time without data" buckets | inactive minutes exists | → Device / Live | ✔ |
| Documents & services | table | Due-soon timeline (next 30/60/90 days) | type, status | → Document | ✔ |
| Attendance (5 reports) | tables | Present/late/absent stacked per day; attendance % trend | shift, branch | → employee day | ✔ |

**Cross-report opportunities:**
- **Period vs period** (for example these 7 days vs the previous 7). ✔ Two runs, diffed client-side. Server-side support would be ✚ but is optional.
- **Charts inside PDF and XLSX exports.** ✚ (server-side rendering).
- **Ad-hoc report history.** ✚ (log ad-hoc runs to ReportRun, or a lighter table).
- **Report presets** (saved scope, period and options). ✚ (new table). A browser-only version (localStorage) is ✔ but per device.

---

## 3. Proposals (before → after)

Each proposal lists: existing screen, problem, enhancement, benefit, components, backend/API impact, database impact, testing and priority.

### RP-1 Report catalogue: search, favourites, recents, descriptions
| | |
|---|---|
| **Existing screen** | [02-reports-teal](../screenshots/phase2/02-reports-teal.png), [29c phone picker](../screenshots/phase2/29c-reports-mobile-type-picker.png) |
| **Problem** | 31 types in a scrolling rail with names only. Users must know the vocabulary ("Halts" vs "Stops" vs "Idling"). On phones it's a 31-item select. |
| **Enhancement** | A search box (matches label, group and description keywords such as "speed" → Over-speed, Continuous driving), a ★ Favourites section, Recents (last 5 type+period), collapsible groups, and a one-line description on hover or below each item. On phones, a full-screen searchable sheet. See [mockup](mockups/mockup-reports-hub.png) ①. |
| **Benefit** | Faster discovery and fewer wrong reports, especially for new users. |
| **Components** | [ReportsPage.tsx](../../../apps/web/src/features/reports/ReportsPage.tsx) (rail), [report-columns.tsx](../../../apps/web/src/features/reports/report-columns.tsx) (catalogue: add `keywords`/`description`), i18n strings. |
| **Backend/API** | None. Data: Existing. |
| **Database** | None (favourites and recents in localStorage). Optional ✚ later: per-user preference row to sync across devices. |
| **Testing** | Unit test for the search matcher (node:test, like `option-label.test.ts`); keyboard navigation; i18n (hi/ta labels searchable); phone layout. |
| **Priority** | **High** (low effort, high frequency). |

### RP-2 Summary strip and a chart for every major report type
| | |
|---|---|
| **Existing screen** | [24 Trips](../screenshots/phase2/24-reports-trips-result.png), [25 Over-speed](../screenshots/phase2/25-reports-overspeed-result.png), [26 Event summary](../screenshots/phase2/26-reports-event-summary-result.png), [27 Consolidated](../screenshots/phase2/27-reports-consolidated-result.png) |
| **Problem** | Only Summary has visuals. Other reports open as 600-row tables with no totals at the top, so users export to Excel to see the shape of the data. |
| **Enhancement** | A per-type "insight" config: 3–4 KPI tiles plus one primary chart (see §2), rendered above the table. Start with Over-speed, Trips, Event summary (heatmap), Consolidated, Alerts, Engine hours and Fuel. Extract a small shared chart kit (BarChart, StackedBar, Heatmap, Histogram, Sparkline) from `SummaryCharts`/`dashboard/charts` rather than adding a dependency. See [mockup](mockups/mockup-reports-hub.png) ②④. |
| **Benefit** | Answers "how bad, where, who" in seconds without exporting. |
| **Components** | New `features/reports/insights/*`, refactor `SummaryCharts.tsx` and `dashboard/charts.tsx` into `components/charts/*`, `report-columns.tsx` (insight definition per type). |
| **Backend/API** | None for the listed types; KPIs are derived from returned rows and totals. Note the 10,000-row on-screen cap: totals cover all rows, but charts built from rows would not, so for capped runs either show a "chart based on first 10k rows" notice or add per-type aggregates to the response (✚ small, additive field). |
| **Database** | None. |
| **Testing** | Pure aggregation functions unit-tested per type; visual check light/dark at 1440 and 390; empty and capped results; accessibility (each chart has a text alternative or table toggle). |
| **Priority** | **High.** |

### RP-3 Drill-down from rows and charts
| | |
|---|---|
| **Existing screen** | [24 Trips](../screenshots/phase2/24-reports-trips-result.png) |
| **Problem** | No path from a trip, stop, over-speed episode or alert row to the map. Only the geofence out-to-in report links to History. |
| **Enhancement** | A "▶ Play in History" row action (opens `/history?object=…&from=…&to=…`, as the existing GEOFENCE_DISTANCE link does). Chart click filters the table (for example a day bar → rows of that day). Event summary heatmap cell → Alerts report pre-filtered. |
| **Benefit** | Investigation goes from report to evidence in one click. |
| **Components** | `report-columns.tsx` (reuse the link pattern at L78-89), `ReportTable.tsx` (row actions, filter chip), History page reading query params (check what `HistoryPage.tsx` already supports). |
| **Backend/API** | None. Data: Existing (rows carry objectId and timestamps). |
| **Database** | None. |
| **Testing** | Deep-link round trip (report → History shows the same window, in company time zone); permissions (History view missing → hide the action). |
| **Priority** | **High.** |

### RP-4 Time zone and place presentation
| | |
|---|---|
| **Existing screen** | [24 Trips](../screenshots/phase2/24-reports-trips-result.png): period "3–9 Nov", first row "02 Nov 04:30 pm" (viewer in Pacific time, company in Asia/Kolkata) |
| **Problem** | Periods are company calendar days but times render in the browser's zone, unlabelled. Locations show coordinates when no geocoder is configured (the default). |
| **Enhancement** | Render report timestamps in the **company time zone** (the same zone used for the period, the XLSX header and schedules) and label column headers "(IST)". Optionally add a toggle for "my time zone". Address fallback: nearest POI or geofence name when inside one (✔), otherwise coordinates with a map link. Operational recommendation: configure a self-hosted geocoder in production (Phase 1 §12). |
| **Benefit** | Removes a confusing, trust-eroding inconsistency; rows become readable. |
| **Components** | `report-format.ts` / `lib/format.ts` (time zone aware formatter), `report-columns.tsx`, the company tz from the session/company settings. |
| **Backend/API** | None for the time zone. POI/geofence name fallback ✚ small (the Stops report already resolves POI names; extend to trips' from/to). |
| **Database** | None. |
| **Testing** | Unit tests with a fixed browser TZ different from the company TZ (the existing `time-range.test.ts` pattern); DST-free IST plus a DST company zone. |
| **Priority** | **High.** |

### RP-5 Period comparison
| | |
|---|---|
| **Existing screen** | [20 Summary](../screenshots/phase2/20-reports-summary-result.png) (no comparison anywhere) |
| **Problem** | Users can't see whether this week is better or worse than last week without two exports. |
| **Enhancement** | "vs previous period" toggle: runs the same request for the preceding equal-length window, shows deltas on KPI tiles and a dashed "previous" series on the primary chart. See [mockup](mockups/mockup-reports-hub.png) ②. |
| **Benefit** | Turns reports into a performance-management tool. |
| **Components** | `ReportsPage.tsx` (second query), insight components (delta rendering). |
| **Backend/API** | None. Data: Existing (two calls). Watch the load: limit to types with aggregated sources (DailySummary/Trip/Alert), not Positions or Over-speed raw scans; or ✚ add a server-side `compare` flag later. |
| **Database** | None. |
| **Testing** | Window arithmetic (month lengths, "This month" partial vs previous full month: define the rule); performance on 20 and 2,000 vehicles. |
| **Priority** | **Medium.** |

### RP-6 Better result tables
| | |
|---|---|
| **Existing screen** | [24](../screenshots/phase2/24-reports-trips-result.png), [62](../screenshots/phase2/62-dms-this-month-table.png), [29b phone](../screenshots/phase2/29b-reports-mobile-result.png) |
| **Problem** | Wide tables truncate silently; no column chooser, in-result search or grouping; "Show more" paging up to 10,000 rows without virtualisation. |
| **Enhancement** | Column chooser (reuse the masters' `vt.columns.*` pattern), sticky first column, a right-edge fade showing more columns, in-result quick filter, optional "group by vehicle" with subtotals, virtualised rows, and card layout under 640 px. |
| **Benefit** | Usable on laptops and phones without exporting. |
| **Components** | `ReportTable.tsx` (consider TanStack Table, already a dependency, which masters use), `report-columns.tsx`. |
| **Backend/API** | None. |
| **Database** | None. |
| **Testing** | 10,000-row render performance; sort, filter and totals consistency; keyboard and screen-reader table semantics. |
| **Priority** | **Medium.** |

### RP-7 Exports that match the screen
| | |
|---|---|
| **Existing screen** | Excel/PDF/CSV buttons ([20](../screenshots/phase2/20-reports-summary-result.png)); PDF has no logo and no charts (code) |
| **Problem** | Exported PDFs are dense tables (7.5 pt) without the summary or charts users see on screen; no company logo even though Platform Settings stores one. |
| **Enhancement** | PDF: cover block with logo, period, time zone and filters; the KPI strip; the primary chart (server-rendered SVG in pdfmake); then the table. XLSX: add a "Summary" sheet with the KPIs and a native Excel chart (ExcelJS can't create charts natively; use a data sheet plus image, or leave the chart out of XLSX). Add an "export current filtered/sorted view" option. |
| **Benefit** | Shareable, professional output; fewer manual Excel steps. |
| **Components** | `apps/api/src/reports/report-files.ts`, shared insight aggregation (move to `packages/shared` so web and API compute identical KPIs). |
| **Backend/API** | ✚ moderate (server-side chart rendering in pdfmake SVG). No new endpoints. |
| **Database** | None. |
| **Testing** | Golden-file tests for PDF/XLSX structure; large exports (50k rows) memory; fonts for Hindi/Tamil in PDF (`apps/api/assets/fonts`). |
| **Priority** | **Medium.** |

### RP-8 Report history for ad-hoc runs
| | |
|---|---|
| **Existing screen** | None for ad-hoc runs; the run sheet exists only per schedule |
| **Problem** | Users re-enter scope and period to repeat a report; no audit of who exported what. |
| **Enhancement** | "My recent runs" panel (type, period, scope summary, rows, ⟳ Re-run, re-download if the file is retained). See [mockup](mockups/mockup-reports-hub.png) ⑥. A lightweight version (re-run only, from localStorage) needs no backend. |
| **Benefit** | Repeatability and accountability (who exported location data matters for privacy). |
| **Components** | `ReportsPage.tsx`, generalise `RunsSheet.tsx` (the API already lists a user's runs without scheduleId, `report-schedules.service.ts:158-165`). |
| **Backend/API** | ✚ log ad-hoc runs/exports (ReportRun row with `scheduleId` null), retention for stored files (Phase 1 flagged that ReportRun and its files have no retention). |
| **Database** | ✚ possibly a `source` column on ReportRun (SCHEDULED/ADHOC) and an index on (userId, startedAt). |
| **Testing** | Permission scoping (users see only their runs; admins see company runs?); retention job; no files stored for on-screen runs unless exported. |
| **Priority** | **Medium.** |

### RP-9 Scheduled reports usability
| | |
|---|---|
| **Existing screen** | [30 Add dialog](../screenshots/phase2/30-schedules-add-dialog.png), [31](../screenshots/phase2/31-schedules-report-picker-open.png), [31b](../screenshots/phase2/31b-schedules-add-dialog-bottom.png), [03 list](../screenshots/phase2/03-schedules-teal.png), [32 phone](../screenshots/phase2/32-schedules-mobile.png) |
| **Problem** | ① Options (alert types, halt minutes, overspeed min duration…) are silently dropped, so a schedule can differ from the on-screen report. ② No preview or test-send ("Run now" emails all recipients). ③ Failures are visible only in a sheet; nobody is told. ④ No "Schedule this" from a report result. ⑤ Phone list truncates. ⑥ The "Period" label says "used by the Summary report" but also applies to Distance and Engine hours. |
| **Enhancement** | Persist options per report type; a "Send test to me" button; a preview line ("Next: Mon 10 Nov 07:00 IST · covers 3–9 Nov"); failure notification to the owner (email or in-app alert) and a failed-status badge in the list; "Schedule this" on report results pre-filling the dialog ([mockup](mockups/mockup-reports-hub.png) ③); card list on phones; correct the label. |
| **Benefit** | Schedules become trustworthy; fewer support tickets ("the emailed report is different"). |
| **Components** | [ScheduledReportsPage.tsx](../../../apps/web/src/features/reports/ScheduledReportsPage.tsx), `ReportsPage.tsx`, `apps/api/src/report-schedules/*`. |
| **Backend/API** | ✚ `options` JSON on the schedule DTO and pass-through to generation; `POST /report-schedules/:id/test` (send only to the caller); failure notification via the notifier. |
| **Database** | ✚ `ReportSchedule.options Json @default("{}")` (additive migration). |
| **Testing** | Option round trip (UI → DB → generated file equals the on-screen run); scheduler slot claiming unchanged; test-send never emails other recipients; failure path. |
| **Priority** | **High** for ① and ②; Medium for the rest. |

### RP-10 Long-running reports
| | |
|---|---|
| **Existing screen** | [20b running](../screenshots/phase2/20b-reports-running-loading.png) |
| **Problem** | Run and Run-now are synchronous HTTP requests; large fleets or long periods risk timeouts (Phase 1 finding). |
| **Enhancement** | Background job with progress for runs above a size threshold; the result is delivered to the page or the "recent runs" list. |
| **Benefit** | Reliability at scale (the product targets 10,000+ vehicles). |
| **Components** | `reports.controller.ts`, a queue (Valkey streams already in the stack), `ReportsPage.tsx`. |
| **Backend/API** | ✚ significant. |
| **Database** | ✚ uses ReportRun (with RP-8). |
| **Testing** | Load test with the simulator at 2,000 devices; cancellation; concurrency limits. |
| **Priority** | **Medium** (Low for small fleets today). |

---

## 4. Summary matrix

| ID | Proposal | Data | Effort | Priority |
|---|---|---|---|---|
| RP-1 | Catalogue search, favourites, recents | Existing | S | High |
| RP-2 | KPI strip + chart per report type | Existing (small ✚ for capped runs) | M | High |
| RP-3 | Drill-down to History / filtered reports | Existing | S | High |
| RP-4 | Company-time-zone timestamps; place-name fallback | Existing (small ✚ for POI fallback) | S | High |
| RP-9 ①② | Schedule options persisted; test-send | ✚ additive | S–M | High |
| RP-5 | Period comparison | Existing (2 calls) | M | Medium |
| RP-6 | Table: columns, sticky, virtualisation, phone cards | Existing | M | Medium |
| RP-7 | PDF/XLSX with summary, chart and logo | ✚ | M | Medium |
| RP-8 | Ad-hoc report history | ✚ | M | Medium |
| RP-9 ③–⑥ | Schedule failure alerts, "Schedule this", phone list | ✚ / Existing | S–M | Medium |
| RP-10 | Background report jobs | ✚ | L | Medium |

Testing baseline for all report work: there are no web component tests today, only `node:test` helpers. Add pure-function tests for aggregations and formatters, API e2e for `/reports/run` per type with the seed and synthetic fixtures (the method used in this assessment is reusable), and a screenshot regression pass with the headless capture script used here.
