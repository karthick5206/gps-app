# 09 — Test Strategy

Branch `feature/modernization-phase0` · 2026-11-09 · Proposal.

## 1. Baseline today (Confirmed)
| Workspace | Framework | Files / cases | Gaps |
|---|---|---|---|
| api | Jest (unit only) | 97 files / ≈834 cases | No integration/e2e; 14 modules without specs (incl. auth tokens and guards, live, live-share, masters, drivers, transfer) |
| web | `node --test` (helpers only) | 21 files / ≈96 cases | No component, interaction or visual tests |
| shared | — | 0 | — |
| mobile, tracker | — | 0 | — |
| CI | — | **none** | — |

## 2. Test environment (proven in Phase 0/2)
The **isolated assessment instance** is the integration and visual test bed. It runs side by side with the existing installation and needs no config file edits:
- DB `veetrax_assess` (Prisma migrations + seed), Valkey db 1, API :4100, web :5174, gateway :5123/5127/5130/6908.
- Data: repo seed; GT06 simulator (`src/simulator/gt06-sim.ts`); synthetic history (`scripts/partb-synth-day.ts`); licences via the Super Admin grant API; driver and DMS fixtures tagged `synthetic`; second tenant "Beta Transport (assessment)".
- **Phase 1 deliverable:** script this as `scripts/test-env/` (up, seed, fixtures, down) so CI and developers get the same environment. In CI, use containers for PostgreSQL and Valkey.

## 3. Test pyramid by phase
| Layer | Tooling (existing where possible) | What |
|---|---|---|
| Unit | Jest (api), node:test (web/shared) | Business rules: command delivery guard; licence dates, grace and reminders; GST split; report aggregations and KPI math; period presets and company-TZ formatting; permission-ceiling rules |
| API integration | Jest + Nest testing module + real PostgreSQL/Valkey (containers) | Every changed endpoint; webhook HMAC; idempotent fulfilment; UPI confirm concurrency; report golden datasets (31 types) |
| **Tenant isolation suite** | Jest e2e | Generalise the Phase 0 probe ([02 §4](02-role-permission-matrix.md#4-tenant-isolation-probes-verified-2026-11-09)) to every `:id` route, report scope, export download, document/file download, Socket.IO room join, webhook delivery, partner boundaries. Runs in CI on every PR |
| Safety suite | Jest + simulator | Engine-stop: offline queue, reconnect moving/stationary, TTL expiry, duplicate delivery, two gateways, cancel |
| Pipeline | Jest + simulator | Poison message → DLQ; outage replay; out-of-order and duplicate packets; LATE handling |
| Web components | node:test for logic; add a lightweight DOM test runner only if approved (no new deps by default) | Chart kit, DataTable, PeriodPresets, ScopeBar |
| Visual regression | Phase 2 headless capture script (CDP, no deps) | The same ~75 screens × Teal/Dark × 1440/390; pixel diff report attached to the PR |
| Accessibility | axe-core in the headless run (dev-only dependency; needs approval) or manual checklist | Changed screens |
| End-to-end journeys | Headless script | Login → live → history playback; run report → export; schedule → test-send; renew licence (Razorpay test mode) → invoice; Super Admin grant → customer seat active |
| Mobile | Jest for logic modules; manual device checklist | Session handling offline; tracker queue dead-letter |
| Performance | Simulator `sim:register --count 2000` + timing script | Dashboard, reports, live latency, ingestion at 1,000 positions/s |

## 4. Golden-data rule for calculations
Report calculations, scoring, payroll and GST must not change unless approved. Before touching any of these modules:
1. Capture outputs for the fixed synthetic dataset (all 31 report types, scorecard, DMS, GST quotes).
2. Store them as golden JSON.
3. Assert equality after the change.

Any intended change requires a decision-log entry and updated goldens in the same PR.

## 5. Manual acceptance checklist (per release)
- Themes, viewports, roles (Super Admin, Admin, Manager, User, Viewer), partner user.
- Empty, loading, partial, error, permission-denied states.
- Large dataset (2,000 vehicles).
- Slow/interrupted network (DevTools throttling); expired session.
- Cross-tenant attempts (automated suite plus a spot check).
- Export and download permissions.
- Keyboard and screen-reader walk-through of: login, live, report run, renewal.
