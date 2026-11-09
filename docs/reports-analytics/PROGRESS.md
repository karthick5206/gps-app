# Reports & Analytics — batch 1 progress

Branch **`feature/reports-analytics`** (base production v1.3.0 @ 07077b6, `uiRefresh` on). Not pushed, not merged.
Worktree: `D:\Vibhav\gps-app\.claude\worktrees\agent-a3a2b4009d061540c`. Assessment: [REPORT_ASSESSMENT.md](REPORT_ASSESSMENT.md).

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

- Batch 2: exports (PDF cover with logo/period/zone/filters, KPI block and chart; XLSX Summary sheet; export filtered view); insights for Stops/Halts/Idling, Geofences, Fuel, Drivers; heatmap cell → Alerts report; histograms.
- Batch 3: period comparison, presets, ad-hoc run history ✚, test-send and failure alerts ✚, alerts severity/status filter ✚.
- Batch 4: background jobs, per-type aggregates for capped runs ✚, virtualised table / group-by.
- i18n: new strings are English keys (fallback); run `scripts/i18n-extract.mjs` and translate hi/ta.

## Risks

- **Production migration** (`ReportSchedule.options`) must be approved and applied before deploying the API; the web tolerates a missing `options` field (treated as {}), an old API rejects the new field (400) — deploy API first.
- Display change: report times now show company time instead of browser time (intended; labelled). Users outside the company zone will see different clock times than before.
- Charts on capped (>10,000-row) runs are partial (notice shown).
- Favourites/recents/column choices are per browser.
- Golden fixture is a frozen copy of assessment data; several types have empty fixtures (listed above).

## Estimate

Batch 2 ≈ 3–4 days (exports are the bulk); batch 3 ≈ 3 days; batch 4 ≈ 4–6 days.
