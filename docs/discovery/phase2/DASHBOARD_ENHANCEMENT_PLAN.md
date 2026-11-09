# Dashboard, DMS & Driver Scorecard — Enhancement Plan

**Status:** proposal for review. Nothing here is implemented.
Evidence: [VISUAL_ASSESSMENT.md §4.1, §4.6, §4.7](VISUAL_ASSESSMENT.md#41-dashboard--dashboardpagetsx-overviewtabtsx-healthtabstsx-comparetabtsx-chartstsx). Mock-ups are **proposals, not the current application**: [dashboard](mockups/mockup-dashboard-overview.png), [DMS & scorecard](mockups/mockup-dms-scorecard.png).
Legend: **Data: Existing** = built from data the API already returns or stores. **Data: New backend** = needs new aggregation, endpoints or storage.

---

## 1. What the dashboards show today (Confirmed in code)

| Screen | Widgets | API data | Refresh | Export |
|---|---|---|---|---|
| **Overview** ([01](../screenshots/phase2/01-dashboard-teal.png), [11](../screenshots/phase2/11-dashboard-overview-scrolled.png)) | 6 KPI cards; fleet status bar + 6 status cards; AC/door tiles (when the fleet has IO); 4 compliance cards; 3 donuts (status, moving vs idle, geofence); Most/Least distance; Alerts by type | `GET /dashboard/overview`: byStatus, today km/trips, todayAlerts by type, geofence counts, top/bottom km, IO incl. `acByDay[7]` ([dashboard.ts:4-44](../../../packages/shared/src/dashboard.ts#L4-L44)) | 60 s polling + refetch on live batches (≤ every 10 s) ([OverviewTab.tsx:25-45](../../../apps/web/src/features/dashboard/OverviewTab.tsx#L25-L45)) | PNG/PDF page capture ([page-capture.tsx](../../../apps/web/src/components/page-capture.tsx)) |
| **Criticality** ([13](../screenshots/phase2/13-dashboard-criticality.png)) | Bucket chips + table + remarks | `GET /dashboard/health`: per-vehicle status, lastSeen, inactiveSec, clockSkew, battery, voltage, **gsmSignal**, branchName, model… | 120 s + Refresh | PNG/PDF |
| **Device health** ([14](../screenshots/phase2/14-dashboard-device-health.png)) | 2 battery band lists + chips | same `/health` (threshold fixed at 1,440 min) | 120 s | PNG/PDF |
| **Compare** ([15](../screenshots/phase2/15-dashboard-compare.png)) | 6 totals, 3 top-15 rankings, Consolidated table | `POST /dashboard/compare` (Consolidated rows) | manual | PNG/PDF (no XLSX) |
| **DMS** ([61](../screenshots/phase2/61-dms-this-month.png), [62](../screenshots/phase2/62-dms-this-month-table.png)) | 8 count tiles; stacked events per day; donut by type; top-10 vehicles; table (row click filters to the vehicle) | `GET /dms` (Alert grouped by object/type/day, ≤92 days) | on filter change | CSV |
| **Driver scorecard** ([71](../screenshots/phase2/71-scores-last-week-drivers.png)) | 3 cards + ranked table (medals, grade) | `GET /driver-scores`: score, grade, km, overspeed, harsh, dms, adas, crash, idle %, night km, **penalties** | none | none |

**Data already returned but not visualised** (✔ no backend work):
- `/health`: `branchName`, `gsmSignal`, `model`, `lat/lng`. These enable a per-branch criticality breakdown, a signal-strength band and "problem devices on a map".
- `/dashboard/compare`: `branchName`, `activeDays`, `overspeedCount`, `criticalAlertCount`, `geofenceVisits`, `maxSpeedKph`. These enable branch roll-ups, utilisation and more rankings.
- `/driver-scores`: the `penalties` breakdown, today shown only in a tooltip ([DriverScoresPage.tsx:35](../../../apps/web/src/features/driver-scores/DriverScoresPage.tsx#L35)).
- Overview: `top/bottom.runningSec` (moving time).
- `DailySummary` stores per-day history, including `overspeedSec`. The dashboard reads only today. A fleet trend can be built client-side today by calling `/reports/run` (SUMMARY, group by day, empty scope) and summing per day, which is what `SummaryCharts` does.

**Needs new backend** (✚):
- A light **fleet daily-trend endpoint** (km, trips, running/idle sec, alerts per day for N days). Calling SUMMARY returns one row per vehicle per day, which is wasteful for 10,000 vehicles.
- Alerts per day across all types (only DMS groups alerts by day today).
- Health history (only snapshots exist).
- Driver score trends and custom ranges (the API accepts 4 fixed periods).
- AC trend beyond 7 days.

---

## 2. Proposals — Dashboard

### DB-1 "Needs attention" first
| | |
|---|---|
| **Existing screen** | [01 Overview](../screenshots/phase2/01-dashboard-teal.png): 16 equal cards; attention items are spread over KPIs, status, documents and the separate Criticality tab |
| **Problem** | A manager has to scan the whole page to find what needs action. |
| **Enhancement** | One strip at the top summarising actionable counts: unacknowledged critical alerts, vehicles overspeeding now, devices silent beyond the threshold, documents expiring this week, overdue services. Each links to the filtered destination (Alerts, Live filtered, Criticality, Documents). Hidden when all clear. See [mockup](mockups/mockup-dashboard-overview.png) ①. |
| **Benefit** | Time to first action drops from scanning to one glance. |
| **Components** | [OverviewTab.tsx](../../../apps/web/src/features/dashboard/OverviewTab.tsx); reuse logic from [live/attention.ts](../../../apps/web/src/features/live/attention.ts) (Needs-attention on the Live map) and `/documents/summary`. |
| **Backend/API** | Mostly Existing (overview + health + documents summary + alerts). An unacknowledged-critical count may need a small additive field ✚ if not already in `/alerts`. |
| **Database** | None. |
| **Testing** | Counts match the destination lists; permission-aware (hide items the user can't open); empty state. |
| **Priority** | **High.** |

### DB-2 KPIs with delta and 7-day sparkline
| | |
|---|---|
| **Existing screen** | [01](../screenshots/phase2/01-dashboard-teal.png): "Distance today 100.2 km", "Trips today 0", "Alerts today 23"; no context |
| **Problem** | No sense of normal: is 100 km good? "Trips today 0" while vehicles are driving is confusing (it counts completed trips only). |
| **Enhancement** | Five KPIs (distance, trips completed + in progress, utilisation %, idle time, alerts), each with a delta vs yesterday or the same weekday last week (selectable) and a 7-day sparkline. See [mockup](mockups/mockup-dashboard-overview.png) ②③. |
| **Benefit** | Instant performance context; fewer misreadings. |
| **Components** | `OverviewTab.tsx`, new `components/charts/Sparkline`, extracted from `charts.tsx`. |
| **Backend/API** | Phase A (✔): client-side from `/reports/run` SUMMARY (acceptable for small fleets; cache 5 min). Phase B (✚): `GET /dashboard/trend?days=14` aggregating DailySummary + Alert per day (one SQL group-by; the indexes exist on DailySummary). "In-progress trips" needs a small additive count from live state (✚). |
| **Database** | None (DailySummary exists). Verify the index on `DailySummary(companyId, day)`, see [Phase 1 DB doc](../11-database.md). |
| **Testing** | Delta math across midnight in the **company time zone**; today-partial handling (compare to yesterday up to the same hour, or label "so far"); performance at 2,000 vehicles. |
| **Priority** | **High.** |

### DB-3 Consolidate duplicated status widgets
| | |
|---|---|
| **Existing screen** | [01](../screenshots/phase2/01-dashboard-teal.png) + [11](../screenshots/phase2/11-dashboard-overview-scrolled.png): status cards, status bar, status donut, moving-vs-idle donut |
| **Problem** | The same numbers appear three or four times. The geofence donut is often 100 % "outside" (low information). |
| **Enhancement** | One "Fleet status now" widget (segmented bar + six counts, click → Live filtered). Replace the two status donuts with a **14-day distance-per-day** chart and "Alerts by type, today vs 7-day average". Show the geofence donut only when more than 0 vehicles are inside geofences, or turn it into a "vehicles inside geofences" list. See [mockup](mockups/mockup-dashboard-overview.png) ④. |
| **Benefit** | Less noise, more insight per pixel; shorter page on phones (the current phone page is ≈5 screens, [19b](../screenshots/phase2/19b-dashboard-mobile-scrolled.png)). |
| **Components** | `OverviewTab.tsx`, `charts.tsx`. |
| **Backend/API** | Distance per day: same as DB-2. Alerts 7-day average ✚ (alerts per day). |
| **Database** | None. |
| **Testing** | Visual regression light/dark/phone; click-through filters on Live. |
| **Priority** | **Medium.** |

### DB-4 Compact compliance card
| | |
|---|---|
| **Existing screen** | [01](../screenshots/phase2/01-dashboard-teal.png) "Documents & service": four cards, usually zeros |
| **Problem** | A whole row of the page is spent on numbers that are usually 0. |
| **Enhancement** | One card with four counts and a link; it highlights only when a count is above 0 (and moves into DB-1 when urgent). [Mockup](mockups/mockup-dashboard-overview.png) ⑤. |
| **Benefit** | Space for trend widgets. |
| **Components** | `OverviewTab.tsx`. |
| **Backend/API** | None. Data: Existing. |
| **Database** | None. |
| **Testing** | Visual; links. |
| **Priority** | **Low.** |

### DB-5 Criticality and Device health: branch breakdown, map, friendlier thresholds
| | |
|---|---|
| **Existing screen** | [13](../screenshots/phase2/13-dashboard-criticality.png), [14](../screenshots/phase2/14-dashboard-device-health.png) |
| **Problem** | The threshold is a raw-minutes number (`1440`). There is no view of which branch has the problems or where the devices are. GSM signal is returned but not shown. The "inactive devices battery" panel is usually empty. |
| **Enhancement** | Threshold as a preset select (1 h / 6 h / 24 h / 3 d / custom). A per-branch stacked bar of buckets (click filters). A mini-map of problem devices' last positions. A GSM-signal band list. Collapse the inactive-battery panel into the chips when it is empty. |
| **Benefit** | Field teams can plan site visits by branch and location. |
| **Components** | [HealthTabs.tsx](../../../apps/web/src/features/dashboard/HealthTabs.tsx), a map component (reuse the lazily loaded MapLibre map). |
| **Backend/API** | None. Data: Existing (`branchName`, `lat/lng`, `gsmSignal` already in `/health`). |
| **Database** | None. |
| **Testing** | Bucket counts vs table; MapLibre lazy-load (don't add it to the initial bundle; Phase 1 noted it already loads on every page). |
| **Priority** | **Medium.** |

### DB-6 Compare: period vs period and branch roll-up
| | |
|---|---|
| **Existing screen** | [15](../screenshots/phase2/15-dashboard-compare.png), [18 dark](../screenshots/phase2/18-dashboard-compare-dark.png) |
| **Problem** | It compares vehicles in one window only, duplicates the Reports scope form, and only ranks distance, idle and alerts. It has no XLSX export. |
| **Enhancement** | Mode toggle "Vehicles / Branches / Periods". The branch roll-up comes from `branchName` (✔). Period mode calls compare twice (✔) and shows paired bars and deltas. Add rankings for overspeed, critical alerts, utilisation and max speed (fields already returned). Add an Excel export through the existing CONSOLIDATED report export. |
| **Benefit** | Branch managers can benchmark themselves; management sees trends. |
| **Components** | [CompareTab.tsx](../../../apps/web/src/features/dashboard/CompareTab.tsx), shared `ScopePicker`. |
| **Backend/API** | None. Data: Existing. |
| **Database** | None. |
| **Testing** | Roll-up sums equal the totals; period window rules shared with RP-5. |
| **Priority** | **Medium.** |

---

## 3. Proposals — DMS dashboard

### DMS-1 Split cabin vs road events; small multiples instead of the 8-hue stack
| | |
|---|---|
| **Existing screen** | [61](../screenshots/phase2/61-dms-this-month.png), [60 single day](../screenshots/phase2/60-dms-period-menu.png), [64 phone](../screenshots/phase2/64-dms-mobile.png) |
| **Problem** | The 100 % stacked bar of 8 similar hues makes every category except the bottom one hard to compare. For one day it is a single full-width block. Driver state and driving style are mixed. |
| **Enhancement** | Two panels, **Driver state (cabin)** and **Driving style (road)**, each with per-type mini column charts on a shared scale in one severity colour (see [mockup](mockups/mockup-dms-scorecard.png) ②). For a single day, switch to per-hour columns. Tiles show delta vs the previous period. |
| **Benefit** | Readable trends per behaviour; works on phones. |
| **Components** | [DmsPage.tsx](../../../apps/web/src/features/dms/DmsPage.tsx) (`DailyChart` at L175), [packages/shared/src/dms.ts](../../../packages/shared/src/dms.ts) (categories already carry `types`; add a `kind: 'cabin' \| 'road'`, aligned with `CABIN_EVENT_TYPES` in `driver-events.ts`). |
| **Backend/API** | None for the day series (`daily[]` is returned). Per-hour for single days ✚ small (group by hour). Delta: second call (✔). |
| **Database** | None. |
| **Testing** | Visual regression; colour-blind check; ≤92-day limit messaging. |
| **Priority** | **High.** |

### DMS-2 Driver view and per-100 km normalisation
| | |
|---|---|
| **Existing screen** | [62](../screenshots/phase2/62-dms-this-month-table.png) (vehicles only; raw counts; red bars) |
| **Problem** | Coaching is about drivers, not vehicles. Raw counts penalise high-mileage vehicles. All bars are alarm red. |
| **Enhancement** | A "By vehicle / By driver" toggle (driver attribution exists via DriverAssignment, as the Scorecard does). An events/100 km column using Trip km. A cabin vs road mix bar. "Events →" opens Driver events filtered by driver/vehicle and type. See [mockup](mockups/mockup-dms-scorecard.png) ①③. |
| **Benefit** | Fair, actionable ranking for coaching. |
| **Components** | `DmsPage.tsx`; reuse the attribution logic from [driver-scores.service.ts](../../../apps/api/src/driver-scores/driver-scores.service.ts). |
| **Backend/API** | ✚ moderate: `/dms?by=driver` (join to DriverAssignment intervals, as driver-scores does) and km per object or driver (Trip sum). |
| **Database** | None (indexes on DriverAssignment `(driverId, fromTime)` and Alert exist; verify Alert `(objectId, occurredAt)`). |
| **Testing** | Attribution across assignment changes mid-day; unassigned events bucket; parity with Scorecard counts. |
| **Priority** | **Medium.** |

### DMS-3 Consistent period presets and table fit
| | |
|---|---|
| **Existing screen** | [60](../screenshots/phase2/60-dms-period-menu.png) (Today / This week / This month / Custom), [62](../screenshots/phase2/62-dms-this-month-table.png) (table cut at "Harsh b…") |
| **Problem** | Presets differ from Reports and History; the table truncates silently. |
| **Enhancement** | Adopt the shared preset set (see roadmap UX-3); sticky first column, column fade or chooser; phone card list. |
| **Benefit** | Predictability across modules. |
| **Components** | `DmsPage.tsx`, a shared `PeriodPresets` component. |
| **Backend/API** | None. |
| **Database** | None. |
| **Testing** | Preset → range mapping in the company TZ (shared unit tests). |
| **Priority** | **Medium.** |

---

## 4. Proposals — Driver scorecard

### DS-1 Penalty breakdown and score distribution
| | |
|---|---|
| **Existing screen** | [71](../screenshots/phase2/71-scores-last-week-drivers.png) |
| **Problem** | Why a score is 90 is visible only in a tooltip; counts are raw while the score is per 100 km; there's no distribution view. |
| **Enhancement** | A stacked "points lost" bar per row (overspeed / harsh / cabin / ADAS / crash / idle / night) from `penalties` (✔); a header histogram of scores (A/B/C/D bands); column headers labelled "count" vs "/100 km". |
| **Benefit** | Coaching conversations start from the cause, not just the number. |
| **Components** | [DriverScoresPage.tsx](../../../apps/web/src/features/driver-scores/DriverScoresPage.tsx). |
| **Backend/API** | None. Data: Existing. |
| **Database** | None. |
| **Testing** | Penalty segments sum to 100 − score; accessibility of segment colours. |
| **Priority** | **High** (cheap, high value). |

### DS-2 Trend and drill-down
| | |
|---|---|
| **Existing screen** | [71](../screenshots/phase2/71-scores-last-week-drivers.png), [07 "Under 10 km"](../screenshots/phase2/07-driver-scores-teal.png) |
| **Problem** | No week-over-week trend; no path from a driver to the events or trips behind the score; KPIs show "—" without saying why. |
| **Enhancement** | A 4-week sparkline and ▲/▼ per driver; row → driver detail (events list, trips, History link); KPI tiles explain "Not enough driving yet (under 10 km)". |
| **Benefit** | Shows improvement over time, which is the purpose of a scorecard. |
| **Components** | `DriverScoresPage.tsx`, Driver events page (filters by driver). |
| **Backend/API** | Phase A ✔: 4 calls with fixed periods (this, last, and earlier weeks are not available; only 4 fixed periods exist). Phase B ✚: accept arbitrary `from/to`, or store weekly score snapshots. |
| **Database** | ✚ optional `DriverScoreWeekly` snapshot table for cheap trends at scale. |
| **Testing** | Score parity between snapshot and on-the-fly calculation; driver reassignment. |
| **Priority** | **Medium.** |

### DS-3 Export and phone layout
| | |
|---|---|
| **Existing screen** | [74 phone](../screenshots/phase2/74-scores-mobile.png) (table cut after Score); no export button |
| **Enhancement** | CSV/XLSX export (the DMS has CSV; the Scorecard has none); phone card list (driver, score chip, top penalty). |
| **Components** | `DriverScoresPage.tsx`, `driver-scores.controller.ts` (`?format=csv`, like DMS). |
| **Backend/API** | ✚ small. |
| **Database** | None. |
| **Testing** | CSV columns match the screen; permissions. |
| **Priority** | **Low.** |

---

## 5. Summary matrix

| ID | Proposal | Data | Effort | Priority |
|---|---|---|---|---|
| DB-1 | Needs-attention strip | Existing (+ tiny ✚) | S | High |
| DB-2 | KPI delta + sparkline | Phase A Existing / Phase B ✚ trend endpoint | M | High |
| DMS-1 | Cabin/road split, small multiples | Existing | S–M | High |
| DS-1 | Penalty breakdown, score distribution | Existing | S | High |
| DB-3 | Consolidate status widgets; add trend charts | Existing / ✚ alerts per day | M | Medium |
| DB-5 | Health: branch breakdown, map, presets | Existing | M | Medium |
| DB-6 | Compare: periods and branches | Existing | M | Medium |
| DMS-2 | Driver view, per-100 km | ✚ | M | Medium |
| DMS-3 | Presets + table fit | Existing | S | Medium |
| DS-2 | Score trend + drill-down | Existing (limited) / ✚ | M | Medium |
| DB-4 | Compact compliance card | Existing | S | Low |
| DS-3 | Scorecard export + phone cards | ✚ small | S | Low |

**Shared prerequisite:** a small internal chart kit (Sparkline, Bar/StackedBar, SmallMultiples, Heatmap, Histogram). Extract it from the existing hand-rolled SVG in [dashboard/charts.tsx](../../../apps/web/src/features/dashboard/charts.tsx) and [SummaryCharts.tsx](../../../apps/web/src/features/reports/SummaryCharts.tsx), with built-in light/dark tokens, `aria-label`s and a "view as table" fallback. This avoids a new dependency, in line with the project's "no new packages without need" stance. If a library is preferred later, that is a separate decision.
