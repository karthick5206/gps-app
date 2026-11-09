# Customer Dashboard Redesign: Report

**Status:** deployed to production as **v1.4.0** (2026-11-09 02:27 IST). The phone tab-bar follow-up ships as **v1.4.1**.
**Scope:** presentation only, behind the `uiRefresh` flag (on in production builds since v1.3.0). Flag off renders the original dashboard.
**Code:** `apps/web/src/features/dashboard/` only:
- new `refresh/kit.tsx`, `refresh/charts.tsx`, `refresh/OverviewRefresh.tsx`, `refresh/use-updated-at.ts`;
- small flag-gated edits in `DashboardPage.tsx`, `OverviewTab.tsx`, `charts.tsx`, `CompareTab.tsx`.

No API, database, permission, business-logic or dependency changes.

## What changed (flag on)
| Area | Change |
|---|---|
| Header | Title, an "Updated hh:mm" chip (read passively from the overview query; never starts a request), grouped Download / Open live map, tab bar with icons that fits 390 px |
| Needs attention | Built **only from already-fetched data**: critical alerts today, overspeeding now, offline, no data, documents expired or expiring this month, services overdue. Each item links to the existing destination. Only non-zero items show, and the strip is hidden when all are zero |
| KPI cards | Quiet label with a definition tooltip (also on keyboard focus), icon chip, 28 px tabular numerals, meaningful sub-line, skeleton while loading; CountUp honours reduced motion |
| Fleet status | One widget replaces the status cards, the status bar and two donuts: segmented bar; six tiles (AA text, icon, % of fleet, same `/live?status=` links); compact moving-vs-idle list. No previously shown data dropped |
| Documents & service | Compact 2×2 card. A cell is tinted only when its count is above 0; "All clear" otherwise |
| Geofence donut | Legend wraps instead of truncating; empty state |
| Lists | Ranked rows with semantic bars. Alerts-by-type in two columns on wide screens. "Show all" on phones |
| Phone | Page height 3,697 → 2,662 px (−28 %), no horizontal scroll |

## Verification
| Check | Result | Who |
|---|---|---|
| Web tests / typecheck / production build | 115/115 (release branch), tsc clean, build OK | me |
| API requests, flag off vs on (7 endpoints on load) | Identical (method, path, params, polling); only the rotating refresh token differs | me |
| API requests, all interactions (CDP: method, URL, body, status, size) | 23/23 identical | agent |
| Flag-off regression (base vs final, frozen API responses) | 0.00 % pixel difference on 6 full-page captures | agent |
| Interactions, flag off and on | Tabs (`?tab=criticality/health/compare`), Top 5/10/20, Criticality/Health chips, inactive-minutes input + Refresh, remarks dialog, Compare presets + Compare, Download PNG (241 KB) and PDF (169 KB), Open live map `/live`, click-throughs `/alerts`, `/live?status=…`, `/masters/documents?tab=service`. The set of 10 link destinations is identical with the flag on and off | me + agent |
| Console errors | None | me + agent |
| Themes | Teal, Plum, Sky, Light (light themes) and Dark (the single dark theme) | agent |
| Viewports | 1440 / 1024 / 768 / 390 | agent |

## Screenshots (running application, isolated test instance with synthetic data; not production data, not mockups)
- `screenshots/before/` (flag off) and `screenshots/after/` (flag on): 1440/1024/768/390 in Teal and Dark, plus Plum/Sky/Light at 1440.
- `screenshots/interactions/`: Top 10, remarks dialog, Compare result, KPI tooltip.
- `release-1.4-evidence/`: my independent captures (1440 + 390, Teal + Dark, before/after) and the API request logs (tokens redacted).

## Needs backend (not built, by design: no fake data)
- KPI period-over-period changes, sparklines, and a 14-day distance chart: need a fleet daily-trend endpoint.
- Alerts versus the 7-day average: need alerts-per-day data.
- Unacknowledged critical alerts count: new field.
- Devices silent beyond the threshold on the Overview: lives in `/dashboard/health`, which the Overview doesn't fetch.
- Utilisation and idle-time KPIs: not in the overview payload.

## Open items
- New UI strings are English only; Hindi/Tamil translations are needed.

## Deployment
- **v1.4.0:** web-only mirror, no service restart, backup `pre-release-1.4-20261109-022258`, rollback copy `dist.prev-1.3-web-20261109-022722`.
- **v1.4.1:** phone tab-bar fix (`449014c`), same procedure.
