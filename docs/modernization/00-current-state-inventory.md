# 00 — Current-State Inventory

Branch `feature/modernization-phase0` · baseline `main@17a2e63` · 2026-11-09 · **Phase 0: no source code changed.**

**Sources:**
- Phase 1 discovery: [docs/discovery](../discovery/README.md).
- Phase 2 visual assessment (81 real screenshots of an isolated instance with synthetic data): [docs/discovery/phase2](../discovery/phase2/VISUAL_ASSESSMENT.md).
- Phase 0 verification done on this branch: tenant probes, role grants, performance baselines, licensing audit, safety re-checks.

**Status labels (assignment §3.3):**
- **IV**: Implemented and verified.
- **INV**: Implemented, not verified.
- **PART**: Partially implemented.
- **MISS**: Missing.
- **DEF**: Defective.
- **DUP**: Deprecated / duplicate.
- **DEC**: Requires product-owner decision.

"Verified" means the code path was read **and** the feature was exercised at runtime on the isolated instance. Production was never accessed.

---

## 1. Architecture and stack (Confirmed)
| Layer | Technology | Notes |
|---|---|---|
| Monorepo | npm workspaces, Node ≥22, TypeScript 5.9 | `@veetracer/*` package scope (legacy name) |
| API | NestJS 11, Prisma 6, PostgreSQL 16+ (TimescaleDB optional), Valkey/Redis (ioredis), Socket.IO 4 | **One codebase, 5 processes:** api, gateway, processor, notifier, summarizer |
| Web | React 19.3, Vite 8, Tailwind 4, Radix/shadcn-style UI, TanStack Query/Table, react-hook-form + zod, i18next (en/hi/ta), MapLibre GL 5, lucide | 51 routed screens |
| Mobile | Expo SDK 58 / RN 0.88: VeeTrax customer app + VeeTrax Tracker (native Kotlin service) | On Google Play; **not Flutter** (HANDOFF is outdated) |
| Devices | Concox GT06 family, Teltonika Codec 8/8E/16, AIS-140, JT808/JT1078 (dashcam video) | TCP gateway |
| Hosting today | Windows PC: PM2 + WSL (PostgreSQL, Valkey) + optional Cloudflare tunnel | Planned Linux production: gps./track.mintplus.co.in |

Diagrams: [04 §1](04-api-and-integration-inventory.md#1-runtime-topology-confirmed) and Phase 1 [02](../discovery/02-architecture-and-platform.md).

## 2. Customer Portal capabilities
| Area | Capability | Status | Evidence / note |
|---|---|---|---|
| Dashboard | Overview KPIs, status, donuts, top/bottom, alerts by type | **IV** | [01](../discovery/screenshots/phase2/01-dashboard-teal.png) |
| | Criticality, Device health, Compare tabs | **IV** | [13](../discovery/screenshots/phase2/13-dashboard-criticality.png)–[15](../discovery/screenshots/phase2/15-dashboard-compare.png) |
| | Trends / comparison periods / KPI definitions | **MISS** | Phase 2 D3 |
| | "Trips today" excludes trips in progress, with no explanation | **DEF** (definition) | Phase 2 D4 |
| Live tracking | Map, markers by type and heading, status filters, list, drawer, follow, share, commands tab | **IV** | [41](../discovery/screenshots/phase2/41-live-object-drawer.png) |
| | Clustering (web) | INV | code |
| | Data-freshness indicator (live / delayed / stale) | **PART** | "since" text and status, no explicit stale badge |
| | Map legend for small markers | **MISS** | Phase 2 L3 |
| History | Playback with speed graph, events, trips/stops/alerts/summary, compare | **IV** | [51](../discovery/screenshots/phase2/51-history-car01-7days-trips.png), [57](../discovery/screenshots/phase2/57-history-compare.png) |
| | Place names | **PART** | Coordinates unless a geocoder is configured |
| Reports | 31 types, XLSX/PDF/CSV | 7 **IV**, 24 INV | [03](03-report-inventory.md) |
| | Search, favourites, recents, charts beyond Summary, drill-down, ad-hoc history | **MISS** | [03](03-report-inventory.md) |
| | Timestamps in company TZ | **DEF** | R-31 |
| Scheduled reports | Daily/weekly/monthly, company TZ, multi-report, run sheet | **IV** (UI) / INV (delivery) | [30](../discovery/screenshots/phase2/30-schedules-add-dialog.png) |
| | Report options honoured | **DEF** | R-32 |
| | Test-send, failure notification | **MISS** | |
| Alerts | Engine, hierarchy config, recipients, templates, acknowledgement | INV | Phase 1 [05 §1](../discovery/05-feature-modules-and-api.md) |
| | Auto-resolve (`RESOLVED`) | **MISS** | |
| | WhatsApp channel | **MISS** | |
| | MSG91/Gupshup | **PART** (stubs) | |
| | Toast noise / grouping | **DEF** (UX) | Phase 2 X1 |
| Geofences / POIs | Circle/polygon/rectangle, enter/exit/dwell/speed | INV | Phase 1 [09](../discovery/09-gps-tracking-architecture.md) |
| | Address search in the editor | **MISS** | HANDOFF §4.3 |
| DMS / ADAS | DMS dashboard | **IV** | [61](../discovery/screenshots/phase2/61-dms-this-month.png) |
| | Cabin vs road split, driver view | **MISS** | |
| Driver scorecard | Score, grade, penalties (tooltip), drivers/vehicles | **IV** | [71](../discovery/screenshots/phase2/71-scores-last-week-drivers.png) |
| | Trends, export | **MISS** | |
| Fuel, expenses, mileage | Sensor fuel, refills/drains, manual mileage, OCR receipts | INV | |
| | Expenses pagination | **PART** (500 cap) | |
| Attendance / payroll | Shifts, selfie check-in, payroll, corrections | INV | |
| | Alerts honour Alert Settings | **DEF** (H14) | |
| | CSV hard-codes Asia/Kolkata | **DEF** | |
| Masters | Vehicles, devices, drivers, groups, branches, documents, lookups, bulk import | INV | Object/driver isolation **IV** ([02 §4](02-role-permission-matrix.md)) |
| Users & roles | Users, custom roles, menu × action, data scope | **IV** (grants read) | |
| | Permission ceiling | **DEF** (R-12) | |
| Customer settings | Company settings, notification lists, retention (30–180 d) | INV | |
| | Locale / units / date-format preferences | **MISS** | INR, IST, km assumed |
| Developer API | Keys (`vtx_live_`), webhooks, public `/v1` | INV | |
| | Key rotation | **MISS** | |
| | OpenAPI document | **MISS** | |
| | Scope clamp | **DEF** (R-13) | |
| Support | In-app help guide (`/guide`), getting-started card | INV | |
| | Tickets / knowledge base / status page | **MISS** | DEC |
| Live share | Public link with hashed 192-bit expiring token | INV | |
| Parking mode | Alarm | INV | |
| | Escalation | **PART** (stub) | |
| Video | JT1078 live / playback | INV | |
| | Multi-host | **PART** | |

## 3. Super Admin Portal capabilities
| Capability | Status | Evidence / note |
|---|---|---|
| Companies: create (company + roles + Head Office + Admin), edit, status, bulk, delete, purge, history, "Act as" | **IV** (create via API) / INV (UI) | `companies.service.ts:85-147` |
| Suspension | **DEF**/**DEC** | No reason field; blocks sign-in, keys, tracker and schedules, but gateway, processor and alerts continue while the UI hint says "data is not processed" (R-21) |
| Company switcher incl. "all" | **IV** | Spoofing by non-SA ignored (V-run) |
| Licences & invoices: pools, grant, record payment, quote, billing profile, partners, invoices, credit notes, GST CSV, UPI claims | **IV** (grant run) / INV | `LicencesAdminPage.tsx:101-128` |
| Platform settings: pricing (paise, GST %, grace, override days), invoicing (supplier, bank, prefixes, SAC, logo, UPI QR) | INV | |
| Device models, device inventory (assign, read SIM/version, shipments, purge), unknown devices | INV | |
| Data forwarding (relay TCP/HTTPS) | INV | SSRF guard relaxed without `NODE_ENV` (R-02) |
| System health (heartbeats, checks, test alerts, Prometheus) | INV | 658-line page |
| **Platform overview dashboard** (tenants, licences, revenue, expiry pipeline, ingestion health) | **MISS** | |
| Cross-tenant audit view | **PART** | Audit log is scoped to the current company; SA platform actions land under the platform company |
| Partner management | **PART** | Inside Licences only. No delete, reclaim, or partner-created customers |
| Impersonation | **MISS** (by design) | "Act as" is company-context switching, not user impersonation (preferred per §7.7) |
| Order / payment-attempt list, reconciliation, finance exports beyond GST CSV | **MISS** | |
| Support / ticket administration | **MISS** | DEC |

## 4. Tenant, identity and permissions
See [02-role-permission-matrix.md](02-role-permission-matrix.md). Summary:
- `companyId` scoping in services; no DB row security.
- Global JWT + permission guards.
- Object-level isolation **verified** on 9 probes.
- Scope ceiling **verified**; permission ceiling missing.
- Socket, file-download and partner-boundary probes still to do.

## 5. GPS pipeline and device commands
See Phase 1 [09](../discovery/09-gps-tracking-architecture.md) and [04 §4](04-api-and-integration-inventory.md#4-background-jobs-and-queues).

| Capability | Status |
|---|---|
| Multi-protocol TCP ingest | IV (GT06 simulator) |
| Phone ingest | INV |
| Stream processing, filtering (INVALID/JUMP/DRIFT/LATE/FUTURE), status machine, geofence and alert rules | **IV** (simulator produced overspeed and geofence alerts through the pipeline) |
| Trips / stops / daily summaries | **IV** (896 trips from synthetic data) |
| DLQ, backpressure, multi-processor safety | **MISS** (R-05…R-08) |
| Commands with engine-stop speed interlock | **DEF**, safety (R-01) |
| Command downlink for all protocols | **PART** (encode exists for some) |

## 6. Annual device licensing & billing (as implemented)
Paths: `L/` = `apps/api/src/licences/`, `S/` = `packages/shared/src/licences.ts`, `W/` = `apps/web/src/features/`.

### 6.1 Model
| Capability | Status | Evidence |
|---|---|---|
| Seat types GPS_DEVICE, DASHCAM, FUEL_SENSOR, MOBILE_TRACKER; API_ACCESS (1 per company, plans); USER retired | IV | `S:7-14`, `L/pools.service.ts:77` |
| Seat type derived from device-model capabilities | IV / **DEF** edge: changing a device's model doesn't re-type its seat | `S:33-36`, `devices.service.ts:124,137` |
| Pools: company pool, or partner pool (`companyId` null + `partnerId`) | IV | `schema.prisma:1603-1637` |
| Auto-assignment: first-expiring free seat (`FOR UPDATE SKIP LOCKED`) → trial seat → 402 `LICENCE_REQUIRED` → SA override | **IV** (25 granted, 20 auto-used on the isolated instance) | `L/seats.service.ts:41-85` |
| Hourly rebalance of free seats onto unlicensed devices | IV | `L/pools.service.ts:87-121` |
| Dates: new seat = paid date + 1 year; renewal = +12 months from current expiry if still running, else from payment | IV | `S:177-183`, `L/billing.service.ts:350,374-376` |
| Status ACTIVE / EXPIRING (≤20 d) / GRACE (platform grace, default 15 d; trial 0) / EXPIRED | IV (stale "30 days" comments) | `S:166-191` |
| Enforcement when locked: live REST + socket, history, reports, video, public API, driver events, live-share, fuel | **IV** (banner and locked rows seen: [x1](../discovery/screenshots/phase2/x1-licence-gate-live.png)) | `L/licence-policy.service.ts:46-95` |
| Alerts, dashboard, webhooks, relay **ignore** the lock | **DEC** (R-34) | |
| Reminders (`LICENCE_JOB`, hourly, Valkey lock): D20…D0, grace D-3/-7/-10, lock day; 09:00–19:00 IST; email + push digest to billing users and the partner | IV | `L/licence-reminders.service.ts:56-170` |
| Trial seats get reminders that quote the platform grace | **DEF** (R-19) | `:118,140` |
| Deactivated device keeps its seat | **DEC** | `devices.service.ts:137` |
| Seat on device move: admin move keeps it with the old company; SA Transfer moves it with the device | **DEF/DEC** (R-20) | `admin-devices.service.ts:79-83` vs `transfer.service.ts:152-156` |
| Partner allocation (seats keep their original expiry; audited) | IV | `L/pools.service.ts:124-152` |
| Partner reclaim / de-allocation | **MISS** | |
| Complimentary grant (reason, OVERRIDE, audited) | **IV** | `L/pools.service.ts:155-179` |
| Grant dialog never sends an API plan | DEF (UI) | `W/billing/admin/AdminPoolsTab.tsx:46` |
| Seat history, expiry corrections, revoke | **MISS** | |

### 6.2 Billing
| Capability | Status | Evidence |
|---|---|---|
| Pricing in paise, GST-inclusive, per type + API plans; partner price overrides; audited | IV | `L/billing.service.ts:161-165` |
| GST split CGST+SGST / UTGST / IGST by state; GSTIN validated against state | IV | `S` gstBreakdown, `L/billing.service.ts:121-128` |
| Razorpay order → HMAC-verified callback → fetch payment `captured` + amount match | IV (code) | `L/razorpay.ts:17-36`, `L/billing.service.ts:277-290` |
| Webhook with raw-body HMAC; captured / paid → fulfil; failed → FAILED | IV (code) | `L/billing.service.ts:293-318` |
| Idempotent fulfilment (conditional PAID claim, unique payment id) | IV | `:334-344` |
| Second captured payment on the same order | **DEF** (silent, R-18) | |
| Failure UX; retry inside the same modal after a failure | INV (possible defect) | `W/billing/razorpay.ts:57-60` |
| UPI / cash claims (server quote, UTR checks) | IV (code) | `L/upi.service.ts:53-66` |
| Claim **confirm not atomic**; reject not audited; SA not notified of new claims | **DEF** (R-17) | `L/upi.service.ts:75-87` (re-verified) |
| Partner offline payments → platform GST invoice at platform price; no settlement ledger | **DEC** | `L/billing.service.ts:213-240` |
| Invoice numbering `PREFIX/FY/seq`, gap-free; GST invoice PDF emailed | IV | `L/invoice-numbering.ts`, `L/invoices.service.ts` |
| Invoice resend (API only) | PART (no UI button) | |
| Credit notes (full/partial, own series, seat expiry option, audited) | IV | `L/credit-notes.service.ts:91-200` |
| Refunds | **PART** (recorded only, manual) | `:130-131` |
| Receipts separate from invoice | **MISS/DEC** | |
| Renewal: partial, bulk, expired seats, mixed with new seats | IV | `L/billing.service.ts:147-176` |
| Monthly GST CSV export | IV | |
| Order / attempt list, reconciliation | **MISS** | |
| Currency, tax, locale | **India-only, hard-coded** (INR, GST, IST) | `L/billing.service.ts:266`, `L/razorpay.ts:87` |

### 6.3 Customer renewal journey (web `/admin/billing`)
1. Licences tab shows seats with checkboxes and a "Select expiring / expired" button; the GST and grace line; a warning when the billing profile is incomplete.
2. "Buy licences" or "Renew N selected" opens a live quote with the GST breakdown.
3. Payment: Razorpay, then server verification. If online payment is disabled: bank details plus a UPI QR or cash claim.
4. Seats are extended only after verified payment or Super Admin confirmation.
5. Invoices and credit notes can be downloaded. **No** self-service retry history, refund request or receipt.
6. Copy defect: the header still says "Licences for users…" though user licences are retired. The dead `USER_LICENCE_EXPIRED` handling remains in `apps/web/src/lib/api.ts:146`.

## 7. Design system
See [07-design-system.md](07-design-system.md):
- Logo assets: `brand/logo`; must not change.
- 5 themes (Teal, Plum, Sky, Light, Dark).
- Inter is requested but not loaded.
- Contrast failures on status badges.
- Hand-rolled charts.

## 8. Gaps between documentation, code and screenshots
| Documented | Actual | Where |
|---|---|---|
| Mobile apps are "Flutter, not started" | Two Expo apps shipping on Play | HANDOFF §1, §4.4 |
| Repository map lists ~10 API modules | 55 module folders | HANDOFF §6 |
| README PDF `VeeTrax_Design_Document_v2.0.pdf` | File is `VeeTracer_Design_Document_v2.0.pdf` | README |
| "Light/dark/system themes everywhere" | 5 fixed themes; no "system" option | design decision vs `features/theme` |
| UI hint: suspended company "data is not processed" | Ingestion and alerts continue | `CompaniesPage.tsx:107` |
| Billing header: "Licences for users…" | User licences retired | `BillingPage.tsx:125` |
| Schedule form: period "used by the Summary report" | Also Distance and Engine hours | `ScheduledReportsPage.tsx:127` |
| Licence "expiring" = 30 days (comments) | 20 days in code | `S:172` |
| Inter as the UI font | Never loaded; falls back to the OS font | `07-design-system.md` |

## 9. Baseline measurements (isolated instance, 20 vehicles, ~302k positions; not representative of production scale)
| Metric | Value |
|---|---|
| Initial JS on first load (incl. `/login`) | 46 scripts, **744 KB gzip** (MapLibre 264 KB, translations 176 KB) |
| Total JS in build | 161 files, 4.68 MB raw / 1.31 MB gzip |
| `GET /dashboard/overview` | 30 ms (median of 5) |
| `GET /dashboard/health` | 157 ms |
| `GET /objects/:id/history` (7 d) | 115 ms |
| Reports: SUMMARY / TRIPS / OVERSPEED, 7 d fleet | 19 / 37 / 66 ms |
| Export TRIPS XLSX | 95 ms |
| `/dms` month / `/driver-scores` last week | 10 / 78 ms |
Re-baseline at 2,000 simulated devices before Phase 3/7 work (assignment §16).
