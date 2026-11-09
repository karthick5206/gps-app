# VeeTrax Modernization — Phase 0 Discovery Report

**For:** product owner review and approval · **Date:** 2026-11-09 · **Branch:** `feature/modernization-phase0` (from `main@17a2e63`)
**Master specification:** *VeeTrax Complete Modernization Assignment*.
**Status:** discovery complete for review. **No application source code, configuration or production data has been changed.** Implementation starts only after approval.

**How this was established:**
- Full repository review (Phase 1, [docs/discovery](../discovery/README.md)).
- 81 real screenshots of an **isolated** instance with seed + synthetic data (Phase 2, [visual assessment](../discovery/phase2/VISUAL_ASSESSMENT.md)).
- On this branch: runtime tenant-isolation and role-escalation probes, built-in role grants read from the API, performance baselines, a licensing and billing code audit, and re-verification of both mandatory safety items.

| # | Required section (assignment §20) | Summary below | Detail |
|---|---|---|---|
| 1 | Architecture and stack | §1 | [00 §1](00-current-state-inventory.md#1-architecture-and-stack-confirmed), [04](04-api-and-integration-inventory.md) |
| 2 | Modules and routes | §2 | [01](01-route-and-module-inventory.md) |
| 3 | Customer Portal capabilities | §3 | [00 §2](00-current-state-inventory.md#2-customer-portal-capabilities) |
| 4 | Super Admin capabilities | §4 | [00 §3](00-current-state-inventory.md#3-super-admin-portal-capabilities) |
| 5 | Report inventory, duplicates, gaps | §5 | [03](03-report-inventory.md) |
| 6 | Design system, logo, colours, fonts, themes | §6 | [07](07-design-system.md) |
| 7 | Licensing and billing lifecycle | §7 | [00 §6](00-current-state-inventory.md#6-annual-device-licensing--billing-as-implemented) |
| 8 | Tenant, user, role, permission model | §8 | [02](02-role-permission-matrix.md) |
| 9 | APIs, integrations, mobile, background jobs | §9 | [04](04-api-and-integration-inventory.md) |
| 10 | Critical risks | §10 | [05](05-technical-risk-register.md) |
| 11 | Documentation vs code vs screenshots | §11 | [00 §8](00-current-state-inventory.md#8-gaps-between-documentation-code-and-screenshots) |
| 12 | Phased roadmap, dependencies, effort | §12 | [06](06-proposed-roadmap.md) |
| 13 | Product-owner questions | §13 | [decision-log](decision-log.md) |
| — | Acceptance criteria · test strategy · release/rollback | §14 | [08](08-acceptance-criteria.md) · [09](09-test-strategy.md) · [10](10-release-and-rollback-plan.md) |

---

## 1. Architecture (confirmed)
- **Shape:** a TypeScript monorepo. One NestJS 11 codebase runs as **5 processes** (api, TCP gateway, stream processor, notifier, summarizer), connected through Valkey streams and pub/sub, with PostgreSQL (85 Prisma models, optional TimescaleDB).
- **Clients:** web is React 19 / Vite / Tailwind / MapLibre (51 routed screens). Mobile is **two Expo apps already on Google Play** (VeeTrax 0.6.7, Tracker 1.4.3), not Flutter as older docs say.
- **Devices:** Concox GT06, Teltonika, AIS-140 and JT808/JT1078 dashcams.
- **Hosting today:** a Windows PC with PM2, PostgreSQL and Valkey in WSL, and an optional Cloudflare tunnel.
- **Stack decision:** keep it. Nothing found justifies a migration.

## 2. Modules and routes
- **Customer Portal:** 30 menu routes in 6 groups (Tracking, Drivers & staff, Costs & reports, Masters, Alerting, Admin).
- **Super Admin:** 8 platform routes.
- **Public:** 9 pages.
- **API:** 55 module folders, ≈300+ endpoints.
- 9 routes were rendered and verified with screenshots; the rest were code-read.
- A Super Admin **platform overview dashboard is missing**.

## 3. Customer Portal: existing vs missing (highlights)
| Strong today (verified) | Missing / defective |
|---|---|
| Live map with status filters, rotated markers, rich drawer, commands, sharing | Explicit stale-data indicator, marker legend, panel collapse |
| History playback with speed graph, events and compare (best UI in the product) | Place names without a geocoder; trip isolation on the map |
| 31 report types, server exports XLSX/PDF/CSV, schedules | Search, favourites, recents; charts beyond Summary; drill-down; ad-hoc run history; **company-TZ timestamps (defect)**; **schedules drop options (defect)** |
| Dashboard (Overview, Criticality, Device health, Compare), DMS, Driver scorecard | Trends and comparisons, KPI definitions, cabin/road split, driver view, score trends |
| Alerts engine, templates, recipients, geofences, POIs, fuel, expenses, attendance/payroll, documents, video | WhatsApp, alert auto-resolve, geofence address search; attendance alerts bypass settings (defect) |
| Users, custom roles, menu × action permissions, data scope | Permission ceiling (defect); locale/unit preferences; MFA; key rotation; OpenAPI; support tickets |

## 4. Super Admin: existing vs missing
- **Existing:**
  - Companies (create, suspend, purge, "Act as").
  - Licences & invoices (pools, grants, partners, offline payments, UPI claims, credit notes, GST CSV).
  - Platform pricing and invoicing settings.
  - Device models, inventory and shipments; unknown devices; data forwarding; system health.
- **Missing:**
  - Platform overview (tenants, licences, revenue, expiry pipeline, ingestion health).
  - Suspension reason and effective date.
  - Partner reclaim.
  - Licence corrections with seat history.
  - Order and payment reconciliation; double-pay detection.
  - Refund workflow.
  - Cross-tenant audit search.
- **Defective:** the suspension hint claims "data is not processed", but ingestion and alerts continue.

## 5. Reports
- 31 types (7 run and verified).
- Overlaps: Distance and Engine hours are subsets of Summary; Stops, Halts and Idling are ignition variants of one source; the Consolidated report duplicates the Dashboard Compare surface.
- **Gaps:** no Driver-score report, no DMS/ADAS event report, no customer licence report.
- **Defects:** D-1 time-zone presentation, D-2 schedule options dropped, D-3 misleading schedule copy.
- Report data isolation verified across tenants.

## 6. Design system
- **Logo:** the existing logo files in `brand/logo` are preserved. A byte-identical check is part of every release.
- **Themes:** five fixed themes (Teal default, Plum, Sky, Light, Dark).
- **Fonts:** **Inter is requested but never loaded**, so the UI renders in the OS font.
- **Charts:** hand-rolled SVG/CSS; there is no charting library.
- **Tokens:** one token set of 47 colour tokens in `index.css`. Plum, Sky and Light reuse Teal's success/warning/danger colours. There are no chart, severity, spacing or font-size tokens, and 111 hex colours are hard-coded across 25 files.
- **Contrast (calculated from the token values):**
  - all 6 status badges fail WCAG AA in every light theme (2.3–4.4:1);
  - the focus ring is drawn at 40 % opacity and fails;
  - the Dark destructive button fails (3.8:1);
  - 5 of the 8 DMS chart colours are below 3:1.
  - Body text, buttons and the header pass.
- **Other gaps:** a stored "system" theme value silently falls back to Teal, and date presets are inconsistent across modules.
- Most fixes are component-level and keep the palette values; only the Dark destructive colour needs a value change, subject to your approval.
- Full token tables, contrast math and the proposed (unimplemented) token structure: [07](07-design-system.md).

## 7. Annual device licensing and billing (as implemented)
**The model is preserved:** seats by type (GPS device, dashcam, fuel sensor, mobile tracker; plus API access), in company or partner pools, auto-assigned to devices, valid 12 months, with EXPIRING ≤20 d → GRACE (default 15 d) → EXPIRED lock.

**Billing:**
- GST-inclusive INR pricing with a CGST/SGST/IGST split.
- Razorpay with server-side signature verification and webhook-only activation (correctly not trusting the redirect).
- UPI/cash claims.
- Partner offline payments.
- Gap-free GST invoice and credit-note series.
- Partial and bulk renewal, including expired seats.

**Issues:**
- **UPI claim confirm is not atomic** (double fulfilment risk; re-verified).
- Second captured payment goes unnoticed.
- Trial reminders quote the wrong grace.
- Inconsistent seat behaviour on device move.
- No seat history or corrections.
- Refunds are manual.
- India-only hard-coding.
- 10 commercial rules need your decision (Q-05…Q-15).

## 8. Tenants, roles, permissions
- Company → Branch → vehicles.
- Built-in roles Admin (COMPANY), Manager/User/Viewer (ASSIGNED), with grants verified from the API. Exactly one Super Admin; partners are a commercial relationship.
- **Verified at runtime:** 9 cross-tenant probes all isolated (404 or empty), and a spoofed `X-Company-Id` was ignored.
- **Escalation:** a Manager **cannot** escalate to Admin (scope ceiling works), but **can assign themselves any branch-scoped role** (no permission ceiling).
- **Still to probe:** sockets, file downloads, partner boundaries.

## 9. APIs, integrations, mobile, jobs
- **Integrations:** SMTP, Smartping SMS, Expo push, Razorpay, webhooks and relay, OpenFreeMap, optional geocoder and routing. WhatsApp is missing; MSG91 and Gupshup are stubs. No error tracking, correlation IDs, request logs or OpenAPI.
- **Jobs:** processor (no DLQ), summarizer, notifier, report scheduler, licence reminders, retention.
- **Mobile:**
  - The customer app signs users out when offline.
  - The tracker can be blocked by one rejected batch, and re-pairs silently by Android ID.
  - iOS tracking is missing.
  - There are no mobile tests.

## 10. Critical risks (top)
1. **Critical, safety (R-01, re-verified):** an engine-stop queued for an offline vehicle is delivered on reconnect, up to 24 h later, **without re-checking speed**.
2. **Critical, security (R-02, re-verified):** the deployment lacks `NODE_ENV=production`, so production assertions are off and SSRF guards are relaxed.
3. **High:** backups exclude uploaded files and no restore has been tested.
4. **High:** the seed creates a default Super Admin password.
5. **High:** OTPs and reset links are written to disk.
6. **High:** the permission ceiling is missing.
7. **High:** sockets survive logout.
8. **High:** API keys can exceed their creator's scope.
9. **High:** the UPI double-fulfilment race.
10. **High:** GPS pipeline durability (trim loss, no DLQ, live state written before commit, single processor).
11. **High:** DB scaling (summarizer scan, retention by DELETE, mixed timestamp types).
12. **High:** no CI.

In total: 2 Critical, 22 High, 9 Medium ([05](05-technical-risk-register.md)).

## 11. Documentation vs reality
- HANDOFF says Flutter and "not started" (wrong).
- The module map is stale; the README has a wrong PDF name.
- A "system" theme was promised but doesn't exist.
- The UI hints on suspension and billing are wrong, and the licence comments say 30 days where the code uses 20.
- Inter is not loaded.

([00 §8](00-current-state-inventory.md#8-gaps-between-documentation-code-and-screenshots))

## 12. Roadmap (effort in person-weeks, ±30 %)
| Order | Phase | Effort | Gate |
|---|---|---|---|
| now | **S0 Safety track**: engine-stop re-check, `NODE_ENV`, file backups + restore test, seed password, atomic UPI confirm | 2.3 | Your safety and config approvals (Q-01…Q-03) |
| 1 | P0 remainder: socket/file/partner probes, 2,000-device baseline, decisions | 1.0 | Scope approval |
| 2 | P1 Design system: Inter, tokens, contrast, chart kit, tables, presets, lazy map, CI | 3.0 | Representative screens approved |
| 3 | P2 Reports Hub | 4.5 | Golden-data parity for all 31 types |
| 4 | P3 Dashboard & live (incl. DMS, scorecard) | 4.0 | Freshness and performance verified |
| 5 | P4 Customer self-service & security fixes | 4.5 | Isolation suite green |
| 6 | P5 Super Admin & commercial ops | 5.0 | Financial accuracy and audit verified |
| 7 | P6 Mobile & integrations | 3.5 | Device and customer compatibility |
| 8 | P7 Reliability, security & scale (can run in parallel by a 2nd engineer) | 6.0 | Operational readiness |
| | **Total** | **≈36 person-weeks** (≈5–6 months with 2 engineers) | |

## 13. Decisions needed from you (top 8 of 24)
- Q-01 engine-stop policy for offline vehicles.
- Q-02 approve `NODE_ENV=production`.
- Q-03 backup target.
- Q-04 company time zone as the display default.
- Q-05 seat follows device or company.
- Q-10 alerts for locked vehicles.
- Q-13 suspension semantics.
- Q-20 support platform.

Full list: [decision-log.md](decision-log.md).

## 14. Acceptance and testing
- Global criteria apply to every PR: themes, viewports, a11y, states, screenshots, no data leaks, logo unchanged. Per-phase criteria are in [08](08-acceptance-criteria.md).
- Test strategy ([09](09-test-strategy.md)):
  - the isolated instance becomes a scripted test environment;
  - add a **tenant-isolation suite**, a **safety suite** and **golden-data tests** for reports, scoring and GST;
  - visual regression using the Phase 2 capture script;
  - CI from P1.
- Releases use feature flags, additive migrations and documented rollback ([10](10-release-and-rollback-plan.md)).

---

### What I need from you to proceed
1. **Approve or adjust** the roadmap order, especially starting with the S0 safety track.
2. **Answer Q-01, Q-02 and Q-03** so S0 can start. The remaining questions can follow per phase.
3. Confirm you're happy for Phase 0 documents (this folder and `docs/discovery`) to be committed on this branch. Nothing has been committed yet.
