# Reports & Analytics — progress

Branch **`feature/reports-analytics`** (base production v1.3.0 @ 07077b6, `uiRefresh` on). Not pushed. Batch 1 is merged into `release/1.5`; batch 2 is on this branch only.
Worktree: `D:\Vibhav\gps-app\.claude\worktrees\agent-a3a2b4009d061540c`. Assessment: [REPORT_ASSESSMENT.md](REPORT_ASSESSMENT.md).

## Batch 2 (2026-11-09)

| Item | What | Where |
|---|---|---|
| Shared insights | The KPI/chart builder moved from the web to `@veetracer/shared` (`report-insights.ts`). The page and the exports now use the same code, so a PDF/XLSX shows the figures the screen shows. The web `insights.ts` re-exports it under the old names, and the batch-1 tests pass unchanged | `packages/shared/src/report-insights.ts` |
| New insights | KPIs and charts for **Stops / Halts / Idling** (count, time, average, longest*, vehicles*, idle stops*; duration histogram split parked/idle; time by vehicle; top places by POI or address), **Geofence visits** (visits, time inside, average completed visit*, still inside*; visits by geofence; dwell histogram; entries per day), **Geofence summary** (time inside by geofence, visits by vehicle), **Geofence out-to-in** (distance by pair, travel-time histogram, not arrived yet*), **Fuel (sensor)** (consumed, distance, fleet km/L, refilled, drained; consumed per day with refilled/drained in the tooltip; consumed and drained by vehicle), **Fuel refills & drains** (refills/drains per day, drained by vehicle), **Driver activity** (distance, driving time and overspeed by driver). Values come from API totals where the report has them. Row-derived values are marked `*` when the run was capped. Formulas reuse the server's: the km/L rule is the same as `fuel-report.ts` | `report-insights.ts`, `ReportInsights.tsx` |
| Duration histograms | Buckets <5 min, 5–15, 15–30, 30–60 min, 1–2, 2–4, 4–8 h, 8 h+. Empty buckets at the ends are trimmed, and rows without a duration (open visits, not-yet-arrived stretches) are counted and labelled. Shown on Trips, Stops/Halts/Idling, Geofence visits and Geofence out-to-in. Clicking a bar filters the table to that bucket ("Duration: 15–30 min" chip) | same |
| New chart filters | Geofence, driver, place (POI/address), geofence pair and duration bucket, with the same chip and highlight behaviour as batch 1 | `rowMatches`, `rankedFilter` |
| Heatmap → Alerts | Selecting an Event summary cell keeps the batch-1 table filter. It also shows "Bus 07 · Overspeed: 33 events" with **Open in Alerts report**, which opens a new tab at `/reports?type=ALERTS&vehicle=…&alertType=…&from=…&to=…&run=1`. That tab runs the Alerts report filtered on the server to that vehicle, type and days. Verified: 33 alerts, matching the cell. URL values are validated before use (UUID, alert-code, date patterns) | `report-link.ts`, `ReportsPage.tsx` |
| PDF cover (RP-7) | Page 1 shows the logo, company, report title, period, time zone (`Asia/Kolkata (GMT+05:30)`), the selection (branches, groups and vehicles by name, grouping, report options such as "Minimum duration: 45 min" or "Alert types: Overspeed", filtered view), row count and generation time. Then a KPI block and up to three charts in one row (vector SVG), or the vehicle × type heatmap as a shaded table. Partial-data notes appear when the file holds fewer rows than matched. The table starts on page 2 and is unchanged | `report-summary.ts`, `report-files.ts` |
| XLSX Summary sheet | First sheet **Summary**, followed by the unchanged report sheet. It holds the logo (PNG/JPEG only), the same cover facts and filters, then **Key figures** (Figure, Value as a typed Excel number, As shown, Note). Durations are Excel `[h]:mm` so they add up; km, %, km/h and L have number formats. Then one block per chart with the data behind it (per-day/period table, ranked list, histogram buckets, or the heatmap matrix). exceljs cannot create native Excel charts, so the sheet says so and lists the data | `addXlsxSummary` |
| Export filtered view | When the table is filtered (chart chip and/or quick filter) or has hidden columns, an **Export filtered view** menu offers Excel, PDF and CSV. The page sends 8-character row keys (cyrb53 of the row JSON without address fields) in its sort order, plus hidden column headers and a label. The API re-runs the report, keeps only rows whose key matches, in that order, and drops hidden columns by header. Rows that no longer match (data changed since the run) are counted in a note. Totals are left out, with a note that they cover the whole report. The cover KPIs stay whole-report and say so. Payload ≤ 80 KB for 10,000 rows, inside the default 100 KB JSON limit | `export-view.ts`, `ReportTable.tsx` (`onView`), `reports.controller.ts` (`applyView`) |
| API contract | `POST /reports/export` gains two optional fields: `summary?: boolean` and `view?: { rows, hiddenColumns?, label? }`, both validated (keys `^[0-9a-z]*$`, length a multiple of 8 and ≤ 80,000, at most 100 headers of ≤ 80 characters, label ≤ 200). **Without them the response is byte-for-byte as before.** CSV never gets a cover. Scheduled reports do not send them, so emailed files are unchanged | `reports.dto.ts` |
| Flag | All new UI is behind `isEnabled('uiRefresh')`: batch-2 insight types, histograms, Export filtered view, the cover request and Open in Alerts report. With the flag off, the page behaves as batch 1. Finding: batch 1 itself was not code-gated (only CSS uses `data-ui-refresh`), so its insights show regardless of the flag | `ReportInsights.tsx`, `ReportsPage.tsx` |
| **Bug fix (pre-existing, production)** | XLSX export threw for **Halt / long stoppage, Ignition on/off, AC / Door and AC / Door daily totals**. The worksheet name was the title, and Excel forbids `/`. This affects on-screen downloads and scheduled XLSX emails in v1.3.0. Forbidden characters now become `-` ("Halt-long stoppage"). Separate commit, so it can be cherry-picked to a release | `xlsxSheetName` (commit `1ef5882`) |

### Commits (batch 2, oldest first)

1. `6913a75` feat(reports): shared insight builder with batch-2 types, duration histograms and row keys
2. `1ef5882` fix(reports): XLSX export failed for Halt, Ignition on/off and AC / Door reports
3. `9f79a69` feat(reports): PDF cover, XLSX Summary sheet and filtered-view export (RP-7)
4. `2589cdf` feat(reports): batch-2 insights, histograms, filtered-view export and heatmap → Alerts
5. docs commit (this file, assessment ticks, screenshots)

### Tests (batch 2)

| Suite | Result |
|---|---|
| **Golden** `reports-golden.int.spec.ts` on `veetrax_reports_test` | **PASS**, unchanged spec and snapshot (47 variants, 31 types: rows, totals, CSV hashes). No file under `apps/api/src/reports` that computes rows or totals was touched. Changes are limited to `report-files.ts` (rendering), `reports.controller.ts`, `reports.dto.ts` and the new `report-summary.ts` |
| API `tsc --noEmit` | green |
| API jest (full) | 112 suites passed, 3 skipped · **994 passed, 17 skipped, 0 failed** (baseline 983/17; +11 in `report-summary.spec.ts`: options text, zone line, KPI block, SVG escaping, PDF has exactly one extra cover page, XLSX Summary sheet first, CSV byte-identical with/without cover, filtered view order/missing/hidden columns/no totals, address-independent row keys, sheet names, HALT XLSX) |
| Web `tsc -b` | green |
| Web `node --test` | **148 passed, 0 failed** (baseline 135; +13 in `reports-batch2.test.ts`) |
| Vite production build | green (outDir in scratchpad) |
| E2E through the running API (:4410, scratch DB `veetrax_reports_ui_test`) | STOPS/TRIPS/EVENT_SUMMARY/DRIVERS/GEOFENCE_VISITS/HALT × PDF+XLSX with `summary` → 200. Plain PDF → 200, no cover. Filtered view of 45 of 640 Trips (one vehicle, 30–60 min, sorted by distance, Idle hidden) → PDF/XLSX/CSV contain exactly 45 rows in that order without the Idle column. Malformed `view.rows` → 400. HALT XLSX → 200 (was a 500) |

### Screenshots (`screenshots/batch2/`)

Worktree web (:5191) → worktree API (:4410) on the scratch copy `veetrax_reports_ui_test` (synthetic simulator data, 3–9 Nov). Headless Chrome via CDP.

- Teal and Dark at 1440: `{teal,dark}-1440-{stops,halt,geofence-visits,geofence-summary,geofence-distance,drivers,fuel}-insights`, `-trips-histogram`, `-stops-histogram-filtered` (15–30 min bucket → 320 of 600 rows, "Total (filtered)"), `-export-filtered-view-menu`, `-event-summary-cell-selected`, `-event-summary-open-in-alerts`, `-alerts-prefiltered-from-heatmap` and `-alerts-prefiltered-table` (Bus 07 + Overspeed pre-filled and run: 33 alerts = the cell).
- Phone 390 (teal): `teal-390-stops-{top,insights,charts}`.
- Exported PDFs rendered in Chrome's viewer (page 1 = cover, page 2 shows the table): `pdf-stops-cover`, `pdf-trips-cover`, `pdf-event-summary-cover` (heatmap table), `pdf-drivers-cover`, `pdf-trips-filtered-view` (cover says "Filtered view … 45 of 640 (filtered view)"; table page carries the filtered-view note and has no totals row).
- `fuel-insights` shows the empty state: the fixture has no fuel-sensor data, so the fuel KPIs and charts are covered by unit tests only.

**XLSX Summary sheet** (`stops-cover.xlsx` from the running API): sheets `Summary (36 rows)`, `Stops (607 rows)`. Rows: Demo Logistics / Stops report / Period 2026-11-03 to 2026-11-09 / Time zone Asia/Kolkata (GMT+05:30) / Vehicles: All vehicles you can access / Rows 600 / Generated … Then **Key figures**: Stops 600; Stopped time 285:53 (`[h]:mm`); Average stop 00:29; Longest stop 00:40; Vehicles 8; Idle stops 0 ("Engine running while stopped"). Then **Stops by duration**: 5–15 min 40 / 15–30 min 320 / 30–60 min 240 (Parked, Idle columns). Then **Stopped time by vehicle**: 8 ranked rows with Excel durations. Last, the footnote that Excel charts are not embedded and the chart data is listed instead.

### Needs backend / approval (batch 2)

- **Per-company logo**: no company logo exists in the schema. The cover uses the **platform logo** from billing settings, which invoices already use. When none is set, as in the scratch DB, it shows the company name only. A customer logo needs an upload endpoint and storage. That could go in `Company.settings` JSON, so no schema change; it is a product decision.
- **Filtered-view totals**: left out on purpose (API totals cover the whole report). A "Total (filtered)" row like the page's would need per-type total rules on the server.
- **Native Excel charts**: not supported by exceljs. The data is listed instead; real charts would need a new dependency.
- **Fuel screenshots**: no fuel-sensor data in the fixtures. Real-data validation is needed before release.
- i18n: new strings are English keys (fallback). Run `scripts/i18n-extract.mjs` and translate hi/ta. PDF/XLSX text is English, like the existing exports.
- The XLSX sheet-name fix changes the sheet name of the four affected reports. They could not be downloaded before, so no consumer can depend on the old name.

## Done (batch 1)

| Item | What | Where |
|---|---|---|
| RP-1 catalogue | Search over label, group, description and keywords (EN + translated text), favourites and recents (localStorage `vt.reports.favourites` / `vt.reports.recents`), description under the active item and in results, collapsible groups; phones get a button that opens a searchable full-height sheet | `ReportCatalog.tsx`, `report-catalog.ts` |
| D-1 time zone | Report cells in the company zone (`/auth/me` company.timezone), headers "Start (IST)", result header "Times in IST (Asia/Kolkata), the company time zone", presets/"today"/max date on company days. Exports already used the company zone: verified in `report-columns.ts` (`localTime(…, tz)`) and `report-files.ts` (period/generated lines); unchanged | `report-time.ts`, `report-columns.tsx`, `AuthProvider.tsx` |
| RP-2 insights | KPI strip + charts for Summary (KPIs + existing period charts now clickable + distance by vehicle), Consolidated, Trips, Over-speed, Alerts, Event summary (vehicle × type heatmap), Engine hours. KPI values from API totals (cover every row); row-derived ones marked `*` when truncated; "Charts are based on the first N of M rows" notice on capped runs. Formulas reuse the server's (idle %, utilisation) | `insights.ts`, `charts.tsx`, `ReportInsights.tsx`, `SummaryCharts.tsx` |
| RP-3 drill-down | "Play in History" row action (same `historyLink` as the geofence out-to-in link, hidden without History permission) for trips, stops/halts/idling, over-speed (±2 min), alerts and ignition (±15 min), continuous driving, geofence visits. Chart clicks (bar → day/period, ranking → vehicle/alert type, heatmap cell → vehicle+type) filter the table with a removable chip | `report-columns.tsx` (`drill`), `ReportTable.tsx` |
| RP-6 table | Sticky first column and action column, column chooser saved per type (`vt.columns.report.<TYPE>`, same family as masters), quick filter, card layout under 640 px. Unfiltered totals row = API totals exactly as before; filtered shows "Total (filtered)" | `ReportTable.tsx`, `table-state.ts` |
| Date presets | One `DatePresets` component (Today, Yesterday, Last 7 / 30 days, This / Last month) on company days | `DatePresets.tsx`, `date-presets.ts` |
| D-2 schedule options | Additive `ReportSchedule.options Json @default("{}")`, migration `20261110090000_report_schedule_options` (applied only to scratch DBs; **production migration needs owner approval**). Validated with the on-screen rules, kept per selected type, passed to generation; schedules without options send no options (unit-tested). Dialog shows the options of each selected report | `schedule-options.ts` (api + web), `report-schedules.service.ts`, `ScheduledReportsPage.tsx` |
| D-3 copy | "Group rows by — Used by the Summary, Distance and Engine hours reports" | `ScheduledReportsPage.tsx` |
| Schedule this | Button on results (needs `report_schedules:create`; not for Positions) opens the schedule dialog pre-filled with type, scope, grouping and options | `ReportsPage.tsx` |

## Commits (oldest first)

1. `e9c557b` test(reports): golden snapshot of all 31 report types on a frozen fixture (captured on unchanged v1.3.0)
2. `029b827` feat(report-schedules): persist report options per report type (D-2)
3. `9e6fba2` feat(reports): pure helpers (zone, presets, catalogue, insights, table state) + tests
4. `cfa967d` feat(reports): company-zone timestamps (D-1), Play in History, table usability
5. `1ba616e` feat(reports): KPI strip and charts for 7 types (RP-2)
6. `cbfe9d4` feat(reports): catalogue, date presets, schedule options UI, Schedule this, D-3
7. `c94400c` test(reports): pin GEOFENCE_SUMMARY on closed visits only
8. docs commit (this file, assessment, screenshots)

## Tests

| Suite | Result |
|---|---|
| **Golden** `reports-golden.int.spec.ts` on `veetrax_reports_test` (frozen copy of the assessment DB: 20 vehicles, 360k positions, 896 trips, 914 alerts; 3–9 Nov; clock fixed 2026-11-09T12:00Z) | **PASS**: 47 type/option variants covering all 31 types: rows count, totalRows, truncated, period, totals, SHA-256 of rows and of the CSV export. Snapshot written on unchanged v1.3.0 code; re-run on final code identical. GEOFENCE_SUMMARY open visits use Postgres `now()` (not freezable) so that entry pins closed visits only (commit 7); the other 46 entries are byte-identical to the v1.3.0 snapshot. `apps/api/src/reports/**` is unchanged vs 07077b6 |
| API jest (full) | 111 suites passed, 3 skipped (DB-gated) · **983 passed, 17 skipped, 0 failed** (incl. 6 new schedule-option tests) |
| Web `node --test` | **135 passed, 0 failed** (20 new in `reports-analytics.test.ts`) |
| `tsc` API / web | green / green (`tsc -b`) |
| Web production build | green (outDir in scratchpad, outside repo) |
| E2E (own API :4410 on `veetrax_reports_ui_test`) | Schedule with `{HALT:{minDurationMin:45}, ALERTS:{alertTypes:[OVERSPEED]}, TRIPS:{…}}` saved as `{HALT…, ALERTS…}` (TRIPS dropped: no options); invalid value → 400; Run now emailed CSV with 5 alerts (= on-screen OVERSPEED-only run) vs 31 unfiltered |

Golden run: `REPORTS_TEST_DATABASE_URL=postgresql://…/veetrax_reports_test npx jest reports-golden` (add `REPORTS_GOLDEN_UPDATE=1` only to re-baseline on unchanged code).
Fixture gaps (rows = 0, pinned as empty): IDLE, CONTINUOUS_DRIVING, POI_VISITS, FUEL, FUEL_EVENTS, AC_DOOR(_DAILY), 5 attendance types.

## Screenshots

`screenshots/before/` (24: production code) and `screenshots/after/` (Teal + Dark × 1440 + 390): catalogue, catalogue search ("speed"), phone catalogue sheet, Summary / Trips / Over-speed / Event summary (top, insights, table), event summary filtered by a heatmap cell, Schedule this dialog + options, Scheduled reports Add dialog.
Before = isolated API :4100 via web :5188. After = own API :4410 (worktree build, scratch DB copy) via web :5189 (5178 was taken by another session's server). Live data on the assessment copy differs slightly from the golden fixture (e.g. 9 Nov).

## Remaining / next batches

- ~~Batch 2~~: done (see top). Open items: per-company logo, filtered-view totals, fuel real-data check.
- Batch 3: period comparison, presets, ad-hoc run history ✚, test-send and failure alerts ✚, alerts severity/status filter ✚.
- Batch 4: background jobs, per-type aggregates for capped runs ✚, virtualised table / group-by.
- i18n: new strings are English keys (fallback); run `scripts/i18n-extract.mjs` and translate hi/ta.

## Risks

- **Production migration** (`ReportSchedule.options`) must be approved and applied before deploying the API; the web tolerates a missing `options` field (treated as {}), an old API rejects the new field (400) — deploy API first.
- Display change: report times now show company time instead of browser time (intended; labelled). Users outside the company zone will see different clock times than before.
- Charts on capped (>10,000-row) runs are partial (notice shown).
- Favourites/recents/column choices are per browser.
- Golden fixture is a frozen copy of assessment data; several types have empty fixtures (listed above).
- Batch 2: the cover/filtered view only change files when the page asks for them (flag on), but PDF cover rendering adds work per export (charts are small SVGs; measured exports stay in the same size class). A filtered-view PDF generates up to 10,000 rows (instead of 5,000) to find the selected rows, then writes at most 5,000.
- Batch 2: filtered-view rows are matched by content. Rows that change between the run and the export (an ongoing trip, an open geofence visit) are left out and counted in the file note.
- Batch 2: the shared package must be rebuilt (`npm run build -w @veetracer/shared`) before API/web tests and the API build, as for every shared change.

## Estimate

Batch 2 ≈ 3–4 days (exports are the bulk); batch 3 ≈ 3 days; batch 4 ≈ 4–6 days.
