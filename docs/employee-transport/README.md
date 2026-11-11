# VeeTrax Employee Transportation Management System (ETMS) — E0 architecture pack

## 1. Purpose and status

This folder is the E0 (discovery and architecture) output for ETMS inside the VeeTrax GPS platform: verified current
state, proposed target architecture, data model, contracts, phased plan, risks and estimates.

| Item | Value |
|---|---|
| Status | **E0 approved by the owner on 2026-11-11** (architecture direction). No code, schema, configuration or server was changed. Nothing in these documents is implemented or tested unless a section cites existing code or a Lead production check. |
| Decisions | **Approved 2026-11-11:** D1–D8, L4, O8, O9 (record and conditions in §1.1). Also decided 2026-11-11 after the doc 14 review: O4, O10 (target only, no purchase), O12, O17, O19 resolved; O11 and O18 partly (§1.1, §7). v1.8.1 authorised for implementation and isolated testing only. All other §7 decisions stay **unresolved**. |
| Next step | **E0.5 is a documentation and planning phase only** (§1.1). Its deliverables are complete and listed for owner review in **§9**. Implementation of any D6 item, deployment, paid storage, destructive DB changes and infrastructure changes need separate owner authorisation. |

### 1.1 Owner approval record (2026-11-11)

| Item | Owner decision | Conditions recorded |
|---|---|---|
| D1–D8 | **Approved** as written in §5 | The validation conditions C2–C6 (`VALIDATION.md`) still apply. |
| L4: push | **Approved** as a limited Expo → FCM / APNs exception | Generic payloads only; sensitive trip details are fetched through authenticated VeeTrax APIs. |
| O8: backups | **Approved:** encrypted off-site object storage, independent of production and of Git, with **user-controlled encryption keys** | Provider and cost are presented before anything is bought (decision Q-03); nothing is provisioned under this approval. |
| O9: Google Maps hand-offs | **Preserve the existing hand-offs during E0.5**; introduce no new external sharing of passenger or driver location by default | Applies to new ETMS flows (e.g. driver navigation, L6, stays an open decision). |
| Not authorised | Implementation, production deployment, paid storage provisioning, destructive database changes, infrastructure changes | **All eight D6 items (G1–G8) remain outstanding.** *(Superseded for v1.8.1 implementation only by the 2026-11-11 review rows below.)* |
| **v1.8.1 (D6), owner review of `14` on 2026-11-11** | **Approved for implementation and isolated testing only:** G6 health checks + `release.sh` health gate; G1 share-page coordinate fix; G8 web (remove the hard-coded OpenFreeMap, self-hosted tiles, build check against external map URLs); the inert G4 installer AOF settings for fresh installs (the installer is not run on production) | Branch `feature/hardening-v1.8.1` from `origin/main`; test instance only. **Not authorised:** production deployment or restart, production Valkey changes, DB migrations, mobile store submission, purchases or provisioning, destructive DB or backup operations. No G-item is deployed. |
| **On hold (2026-11-11)** | v1.8.2 G5 (review after v1.8.1); G4 production AOF (separate maintenance approval); v1.8.3 G2 + G3 (high-risk notifier change); v1.8.4 G7 phase A (separate review); G7 phase B off-site (provider purchase and provisioning approval); G8 mobile (EAS build approval; URL decided, O12) | Each needs its own owner approval. |
| **Corrections to `14` (2026-11-11)** | Applied in `14`: **A** G2 — no exactly-once promise (durable job recovery, per-recipient dedupe in VeeTrax, at-least-once attempts, bounded documented duplicate risk at the provider boundary, provider idempotency keys where supported; DB duplicates = 0 vs external duplicates bounded and measured); **B** G4 — production safety gate; **C** G7 — uploads in scope, restore gate, private key never on the server or in Git; **D** G8 — old mobile installs keep `gps.mintplus.co.in` working | Mobile production build change and old-endpoint retirement need separate approval. |
| **`14` §9 open questions (2026-11-11)** | Resolved: O4, O10 (purchase not authorised), O12, O17, O19; partly resolved: O11 (deputy not named), O18 (backup capture only) | Still open: C3 (staging host), O1 (deployments, AOF window), O13. See §7. |

**E0.5 (documentation and planning), as directed:**
1. resolve the outstanding documentation contradictions
2. correct the seven false claims
3. prepare the eight D6 pre-pilot fixes with acceptance criteria and evidence requirements
4. finalise the database change plan from the authoritative data-model documents
5. prepare the isolated test-environment requirements
6. keep the old routing branch isolated until its compatibility review

The owner reviews the E0.5 deliverables before authorising any implementation.

## 2. Inspected baseline

| Item | Fact |
|---|---|
| Repository / branch / commit | `karthick5206/gps-app`, `origin/main` = **f5b151b** = tag **v1.8.0** (deployed 2026-11-11); worktree `D:\Vibhav\gps-app-wt\etms` at the same commit |
| Unreleased routing work | local-only `feature/routing-engine` (38 commits) and `feature/routing-r0`, read with `git show` only |
| Production host | Ubuntu 24.04.5, 27 GiB RAM, 6 vCPU (QEMU model **without AVX**); Node 24.22.2, GraphHopper 11.1 India, Photon 1.3.0, Martin 1.16.1, PostgreSQL 18.6 + TimescaleDB 2.31.0, Valkey 7.2.13, Caddy 2.11.9 (`00-e0-brief.md` §1; exact versions in the Lead box of [16](16-test-environment-requirements.md)) |

**Lead verifications on production (2026-11-11), facts:**
- `NODE_ENV=production` is set.
- Memory: 10 GiB used, 16 GiB available (GraphHopper RSS 8.6 GB, Photon 1.1 GB).
- Valkey `appendonly no`.
- Nightly local backup cron installed (`/etc/cron.d/veetrax-backup`) but its script and documentation are not in the repo.
  (The repo does hold earlier WSL / Windows backup kits in `ops/backup/`; the Windows one uploads encrypted dumps as
  GitHub Release assets, see owner decision O8.)
- No SMS or mail provider configured.
- **Confirmed live production bug:** `apps/web/src/features/live-share/PublicSharePage.tsx:139` swaps lat/lng on the
  ETA road line. The API (`live-share.service.ts:179`, `RoutingService` shape) already returns `[lng,lat]` and the page
  maps `([la, ln]) => [ln, la]`. The fix exists only on the unreleased routing branch (RR-14). Gate G1 (`12` §2).

**Lead verifications added in E0.5 (2026-11-11):**
- The production web build sets all three `VITE_MAP_STYLE_*` to `app.veetrax.com/tiles`.
- **New finding — live breach:** `apps/web/src/features/live-share/PublicSharePage.tsx:104` hard-codes
  `style: OPENFREEMAP.standard`, so the public share page on production loads OpenFreeMap tiles despite that setting,
  sending every viewer's IP and viewed area to a third party. Gate G8 now covers the share page explicitly (`12` §2,
  `14` G8). Recommended fix: v1.8.1 next to G1; **outstanding, needs owner approval.**
- The production backup does **not** include uploaded files (`apps/api/var`: documents, selfies, invoices). Added to G7.
- `btree_gist` is available on production PostgreSQL 18.6 (version 1.8) but **not installed**; creating it needs
  superuser (owner decision O16). TimescaleDB 2.31.0 is installed.
- `feature/routing-engine` and `feature/routing-r0` are local only, upstream `origin/main`, `push.default` unset (git
  `simple` refuses a push whose names differ). Owner instruction: keep them isolated — no push, no merge (O7).

## 3. Reading order and document index

Read in this order: this README → `02` → `01` → `03` → `04` → `05` → `06` → `07` → `08` → `09` → `10` → `11` → `12` → `13` → `14` → `15` → `16`.

| # | Document | Owner | Content |
|---|---|---|---|
| 00 | [00-e0-brief.md](00-e0-brief.md) | Lead | Baseline, terminology, rules, the 12 questions |
| — | [source/VeeTrax_Employee_Transportation_Complete_Plan.md](source/VeeTrax_Employee_Transportation_Complete_Plan.md) | Owner | Original blueprint |
| 01 | [01-current-state-assessment.md](01-current-state-assessment.md) | Agent 1 | Platform and database reuse inventory: topology, auth, tenancy, notifications, audit, billing, telemetry |
| 02 | [02-target-architecture.md](02-target-architecture.md) | Lead | Components, module boundaries, tenancy, trip execution, R1 workflow, location data flow, push, degraded modes |
| 03 | [03-database-model-inventory-and-reuse.md](03-database-model-inventory-and-reuse.md) | Agent 1 | Existing model inventory, reuse matrix, new tables, extensions, purge, migrations, routing-branch conflict |
| 04 | [04-proposed-data-model-and-erd.md](04-proposed-data-model-and-erd.md) | Agent 1 | Proposed domain model and ERD |
| 05 | [05-api-and-event-contracts.md](05-api-and-event-contracts.md) | Lead | API groups, DTOs, error codes, outbox, events, sockets, authorisation matrix |
| 06 | [06-routing-and-optimization.md](06-routing-and-optimization.md) | Agent 2 | Routing inventory, engine strategy, adapter, formulations, capacity, benchmarks |
| 07 | [07-web-dispatcher-ux.md](07-web-dispatcher-ux.md) | Agent 3 | Web IA, menus, screens, dispatch board, scenario comparison |
| 08 | [08-employee-app.md](08-employee-app.md) | Agent 4 | Passenger shell in `apps/mobile`, auth, privacy, push |
| 09 | [09-driver-app.md](09-driver-app.md) | Agent 5 | Driver shell, identity, trip-state mapping, offline sync |
| 10 | [10-security-safety-and-privacy.md](10-security-safety-and-privacy.md) | Agent 6 | Isolation, provider authorisation, permissions, consent, SOS durability, threat model |
| 11 | [11-testing-and-acceptance.md](11-testing-and-acceptance.md) | Agent 7 | Test inventory, strategy, isolation suite, reliability, performance, acceptance |
| 12 | [12-phased-implementation-plan.md](12-phased-implementation-plan.md) | Lead | E0.5 gate, E1a–E9 scope, work packages, exit criteria, test gates |
| 13 | [13-risks-dependencies-and-estimates.md](13-risks-dependencies-and-estimates.md) | Lead | Risk register, external dependencies, estimates with confidence, critical path |
| 14 | [14-d6-release-gate-specs.md](14-d6-release-gate-specs.md) | E0.5 planning agent; Lead-integrated | Implementation-ready specs for D6 gate items G1–G8 (problem, change, risks, acceptance, tests, evidence, rollback), patch grouping v1.8.1–v1.8.4, effort 4.5–6.7 ew. Specification only |
| 15 | [15-database-change-plan.md](15-database-change-plan.md) | E0.5 schema agent; Lead-integrated | Database change plan: 13 R1 tables, migrations per phase, purge matrix, integrity rules (`btree_gist`), `routeId`-null impact, routing-branch compatibility review plan. Plan only |
| 16 | [16-test-environment-requirements.md](16-test-environment-requirements.md) | E0.5 test agent; Lead-integrated | Test tiers T1–T5, production version parity, local GraphHopper extract, staging requirements, CI additions, C6 baseline re-runs, per-gate environment mapping. Requirements only |
| — | [VALIDATION.md](VALIDATION.md) | Independent reviewer; E0.5 consistency check by the Lead | E0 review: claim verification, contradictions, schema conflicts, sign-off recommendation, list of review edits; E0.5 consistency check (§15) |

Short references such as `03` §4 in all Lead documents mean the document of that number in this table.

## 4. Answers to the twelve E0 questions

**V** = Verified (code evidence or Lead production check); **P** = Proposed.

1. **Reusable models (V).** `Company` (+ `Branch`) is the tenant; `User`, `Session`, `Role`, `RolePermission` and the
   guards for login; `TrackedObject` for vehicles; `Device` / `DeviceAssignment` via the vehicle; `Driver`,
   `DriverAssignment`, `Document` for drivers; `vt:notify`, `NotifierService`, `NotificationLog`, `MessageTemplate`,
   `PushToken` for notifications; `AuditService` / `AuditLog` for audit; `Poi` for offices and shuttle stops; the v1.8
   `PlannedTrip` family for trip execution. Billing (`LicenceSeat`, `LicenceOrder`, `Invoice`) stays untouched. Not
   reusable: `TrackedObject` PERSON for passengers (continuous tracking semantics) and `Partner` for providers (billing
   only). Evidence: `01` §12, `03` §1.
2. **Tenant isolation (V).** Application-level only: `AuthContext.companyId` from the user's own company (only the
   Super Admin may switch via `X-Company-Id`), scope helpers in `apps/api/src/access/access-rules.ts`; no PostgreSQL RLS,
   no Prisma tenant extension. Probes: 20 PASS / 0 FAIL. Weak points: hand-written filters, default-allow routes
   without grants, no permission ceiling (R-12), sockets survive logout (R-14), no read audit. Evidence: `01` §3, `10`
   §1.1.
3. **Expo structure (P on V facts).** `apps/mobile` hosts separate **Passenger** and **Driver** shells as
   `Stack.Protected` route groups selected from `/auth/me` and enforced by the server; `apps/tracker` stays the
   phone-as-GPS-device app (device token, background location, Android only). Evidence: `08` §0–2, `09` §2; D4.
4. **Routing APIs and models (V).** Main: `RoutingService` (`route`, `routeVia`, `estimateGaps`) over GraphHopper
   `/route`, GraphHopper `/match` in `point-quality/road-match.ts`, `POST /api/routing/estimate-gaps`; models `Route`,
   `RouteStop`, `RouteSchedule`, `PlannedTrip*`. Branch: `/routing/*` and `/route-plans/*` APIs (`routing-v2`), a
   routing worker, an OR-Tools service and six models whose `RouteStop` clashes with main. Evidence: `06` §1.1–1.3.
5. **Works vs blocked (V).** Production: road paths and legs, map matching, heuristic next-stop ETA (GH-capped,
   unlabelled), Photon geocoding. Branch (dev PC only, Valhalla): matrix, optimise jobs, plan editing. Blocked: branch
   cannot merge as is (schema clash, five conflicting files, migration order); open-source GH has no matrix endpoint;
   no GH ETA calibration; no foot profile; no passenger / walking / safety constraints anywhere. Evidence: `06` §1.4.
6. **GPS stream reuse (V).** Yes. The processor's planned-trip tracker already turns `vt:positions` into stop arrivals,
   ETA, delay and deviations on `PlannedTrip*`; ETMS references `PlannedTrip.objectId` + time window and stores no
   positions. Caveat: `Position` retention (30–180 days) means incidents must snapshot location. Evidence: `03` §7,
   `06` §5; D2.
7. **Notification channels (V).** Operational: in-app socket, Expo push, webhooks. Implemented but not configured in
   production: SMTP / Zoho e-mail, Smartping SMS, Arattai (Lead check: no SMS / mail provider). Stub: MSG91. Absent:
   WhatsApp, US SMS. `NotificationLog` reports `SENT` for console / unconfigured providers. Evidence: `01` §6; gate G3.
8. **New entities (P).** R1: `TransportServiceAgreement`, `OutboxEvent`, `EmployeeTransportProfile`,
   `EmployeeTransportConsent`, `TransportVehicleProfile`, `TransportShift`, `TransportSchedule`,
   `TransportScheduleException`, `TransportBooking`, `TransportTrip`, `TransportTripPassenger`, `TransportTripEvent`,
   `TransportChangeSet` (13 tables, `15` §2);
   extensions `PlannedTrip.routeId` nullable + `origin`, `Driver.userId`, `NotificationLog` columns,
   `Alert.notifiedAt`, `AuditAction.ACCESS`. Later: fleet allocation, stop profile, driver duty, incidents, policies.
   Evidence: `03` §2–3, `04` §9, `02` §3.1 (naming), `12` §3–5, `15`.
9. **Provider → customer authorisation (V today, P proposed).** Today none: `Partner` is billing-only and
   `VehicleShare` (Super Admin) is the only cross-company grant. D1 (approved 2026-11-11): `TransportServiceAgreement` with closed
   grants, site scope, validity and two-sided approval, loaded into `AuthContext` like `VehicleShare`, enforced by one
   helper set. Evidence: `10` §2, `02` §4.
10. **Driver vs employee permissions (P).** Relationship-based: drivers act only on assigned trips in a time window
    (`/api/driver/v1/*`), passengers only on own bookings and trip legs (`/api/me/transport/*`); minimum-data
    projections; passenger phones not tracked; driver phones need no background location. Evidence: `08` §3, `09` §3,
    `10` §3, `05` §6; D4, D5.
11. **SOS / event durability (V today, P proposed).** Positions are durable (gateway spool, phone queue; chaos 0 lost).
    The alert → notification hop is at-most-once (no outbox, notifier acks failed jobs, no dead letter, empty
    escalation), and Valkey AOF is off (Lead check). Proposed: E0.5 gate G2–G4 for the existing path; ETMS events and
    SOS PostgreSQL-first with `OutboxEvent`, direct-send fallback, DB-scheduled escalation. Evidence: `10` §1.5, §6;
    `11` §1.5, §4; `05` §5.
12. **Smallest useful E1–E3 release (P).** D8 / R1 below: corporate-managed only; passengers, consent, schedules,
    bookings, manual assignment published into `PlannedTrip`, dispatcher-driven trip progression with GPS tracking,
    passenger read-only view; no optimiser, driver app or provider portal; testable entirely on a test copy.
    Evidence: `02` §6, `12` §3–5, `13` §3.

## 5. Architecture decisions D1–D8

All **Approved by the owner on 2026-11-11** (record in §1.1).

| ID | Decision | Detail | Differs from |
|---|---|---|---|
| D1 | Tenancy | Customer and provider are each a `Company`, linked by `TransportServiceAgreement` (closed grants, site scope, validity, approved by both sides); dual-keyed rows (`customerCompanyId`, `providerCompanyId`); agreements in `AuthContext` like `VehicleShare` behind one helper set; corporate-managed = same company / no agreement; provider users never switch company; `Partner` stays billing-only. `02` §4 | `04` §2 adds a separate `agreementScope(ctx)` without changing `AuthContext` — Lead adopts Agent 6's `AuthContext.agreements` |
| D2 | Trip execution | Reuse `PlannedTrip` / `PlannedTripStop` / tracker; `routeId` nullable + `origin` (`ROUTE`/`ETMS`); 1:1 `TransportTrip` (SetNull) + `TransportTripPassenger` + `TransportTripEvent`; `PlannedTripStatus` unchanged; plan states derived (Agent 5 mapping). `02` §5 | `04` §6 gives `TransportTrip` a business-status enum; `06` §5 prefers generated `Route`s for recurring rosters |
| D3 | Routing | GraphHopper is the only road engine; matrix from sparse `/route` calls cached per graph version; custom endpoint only if benchmarks fail. OR-Tools, jobs, metering and ETA labels ported **selectively after a compatibility review** onto a fresh branch from main; the conflicting `RouteStop` renamed only after reviewing schema ownership, migration history and FK dependencies. **Valhalla out of scope.** `RoutingProvider` with degraded mode; never a fabricated ETA. **Manual dispatch keeps working when the optimiser is unavailable.** Optimiser cap ~3 GB / 1.5 cores after benchmarks. `02` §1.1, `12` §7 | `06` §6 renames all branch models to `TransportPlan*` and keeps Valhalla as a parked fallback |
| D4 | Apps | `apps/mobile` hosts Passenger and Driver shells, server-enforced; `apps/tracker` unchanged; passenger phones not tracked continuously (opt-in, window-limited); driver phone needs no background location. `02` §2, §7 | `10` §3 collects driver phone location during duty |
| D5 | Identity | Passenger = `User` + Passenger role + `EmployeeTransportProfile`; driver = additive `Driver.userId` + Driver role; relationship-based access on `/api/me/transport/*` and `/api/driver/v1/*`; one login per person (global unique mobile / email) for E1–E3. `05` §6 | — |
| D6 | Hardening **release gate before the pilot** (E0.5) | Eight gate items, each with owner role, measurable acceptance and required evidence: G1 share-page bug; G2 lost alert notifications; G3 misleading `SENT`; G4 Valkey AOF incl. recovery validation; G5 logout closes / invalidates live connections; G6 routing / map health checks (+ release health gate); G7 secure backup **and restore** process (scripts and documentation in the repo; encrypted backups outside it; no dumps, archives, keys or secrets in Git); G8 mobile builds without external maps. Not finished work. `12` §2 | — |
| D7 | Push | Expo → FCM / APNs is an explicit architectural exception to "nothing leaves the server", **approved by the owner on 2026-11-11 (L4)**; direct FCM / APNs evaluated in E8; providers see tokens and generic payloads only; no names, addresses or precise coordinates; details fetched via authenticated APIs; retries, failure handling, token lifecycle, in-app fallback. Map, routing, geocoding stay self-hosted. `02` §8 | — |
| D8 | Smallest useful release R1 (E1a + E2 + E3) | Corporate-managed only (agreements modelled and guarded, no provider UI); passenger import / CSV + profile + home pin via Photon + consent; shifts and recurring schedules; bookings (ad-hoc + from schedules); manual / assisted assignment to vehicles and stops publishing into `PlannedTrip`; dispatcher trip progression (no driver app; vehicle GPS for location; boarding / no-show recorded separately by the dispatcher; GPS never proof of boarding; v1.8 status semantics kept); reuse Route editor and v1.8 tracker / ETA / alerts; bookings list + basic board; passenger view of own trip on web and read-only mobile shell. **Excluded:** OR-Tools optimisation, Driver app workflows, transport-provider portal, multi-provider operational workflows, advanced billing and analytics. Testable entirely on a test copy (`veetrax_assess`, `sim:route`, synthetic passenger bots, Playwright); no production deployment. `02` §5.3, §6; `12` §5 | `07` §3 phases the trips list and board to E5 / E7 — Lead pulls a basic version into E3 |

### 5.1 First-release workflow (summary)

Employee import (corporate admin) → profile and consent (corporate admin, passenger) → shifts / schedules (corporate
admin / dispatcher) → bookings (scheduler job; dispatcher for ad-hoc) → passenger / vehicle / stop assignment
(dispatcher) → planned trip creation (publish transaction) → trip progression (dispatcher; processor for GPS-derived
start / stop arrival) → vehicle GPS tracking (device → gateway → processor) → boarding / no-show (dispatcher) →
passenger trip view (passenger) → completion and reporting (processor or dispatcher; corporate admin). Full table and
Mermaid sequence: `02` §6.

## 6. Contradictions between agent documents and how they were handled

Status as of **E0.5 (2026-11-11)**, after the owner approved D1–D8, L4, O8 and O9 (§1.1). **Resolved** = settled by an
approved decision or a Lead naming / phasing choice, with the place where the conflicting passage now carries a
`Resolved in E0.5` or `Corrected in E0.5` note (agent reasoning is kept, not silently rewritten). **Open** = the
remaining part is a genuine owner decision from §7; no answer is chosen. Totals: **21 resolved, 3 open** (P6 ×2, P2).

| Topic | Contradiction | Resolution | Status (E0.5) |
|---|---|---|---|
| Trip business status | `04` §6 business-status enum vs `09` §4.1 derived states | Derived states: `PlannedTripStatus` preserved; milestones as `TransportTrip` timestamps and per-passenger states (D2) | **Resolved** (D2): notes in `03` §2, `04` §6, `09` §4.1; `02` §5 |
| Menu keys / feature flag | `etms_*` + `employeeTransport` (`07`) vs `transport_*` (`10`) vs `etms` / `etmsProvider` (`03`) | Feature `etms` (+ `etmsProvider` in E1b); working keys `etms_*`, `etms_self`, `etms_driver` — `02` §3.1 | **Open — P6** for the final key set and group placement; flag name and working names resolved (notes in `07` §0, §2.4, §9; `10` §2.2; `02` §3.1) |
| Branch model renames | `RoutePlanStop` only (`03` §6) vs all `TransportPlan*` (`06` §6) | Rename only the conflicting `RouteStop`, after review (D3) | **Resolved** (D3): note in `06` §6; `02` §3.1 |
| Valhalla | parked fallback (`06` §2.4) | Out of scope, not even as a parked fallback (D3) | **Resolved** (D3): notes in `06` §2.4, §6, §8 Q1 |
| Recurring rosters | generated hidden `Route` per roster (`06` §5) vs nullable `routeId` (`04` §6) | Nullable `routeId` + `origin` for ETMS trips (D2); fixed shuttles keep real `Route`s and door-to-door rosters use "repeat to date" drafts (recommended default) | **Open — P2** for the roster pattern; nullable `routeId` resolved by D2 (note in `06` §5) |
| Vehicle capacity phase | `03` §2 lists `TransportVehicleProfile` as both "not E1–E3" and "E2" | E2 (needed for R1 capacity checks) | **Resolved** (Lead, `02` §3.1): note in `03` §2 |
| Driver phone location | collected on duty (`10` §3) vs not needed (`09` §2.1) | Not collected by default; no GPS needed initially (D4) | **Resolved** (D4): note in `10` §3 |
| Consent / policy / incident table names | Agent 1 vs Agent 6 names | Agent 1 names (schema owner) with Agent 6 fields; consent table renamed `EmployeeTransportConsent` — `02` §3.1 | **Resolved** (Lead naming; condition C2): notes in `03` §1, `04` §3, `10` §4.2 |
| Booking provider id | `03` §2 table 7 customer-only vs both ids (`04` §2, `10` §2.2) | Both ids, provider nullable until assignment (D1 dual keys) | **Resolved** (D1): note in `03` §2 |
| Passenger stop link | FK to `PlannedTripStop.id` (`03`) vs `(tripId, seq)` (`06` §5, `09`) | FK plus `pickupSeq` / `dropSeq` snapshot | **Resolved** (Lead): `02` §5.1 `TransportTripPassenger` |
| Production headroom | "≈ 3 GB" (`11` §1.6) vs Lead check 16 GiB available | Both kept: 16 GiB is current use, ~3 GB is the ceiling if every service reaches its configured maximum; benchmarks decide | **Resolved** (no conflict): `11` Lead box, `02` §10; optimiser host stays O2 |
| Board phasing | trips list / board in E5 / E7 (`07` §3) vs D8 | Basic board and trip detail in E3; full actions E7 | **Resolved** (D8): notes in `07` §3, §4.4 |
| *Added by the E0 review (VALIDATION.md §1):* | | | |
| Role creation | `03` §1 / §3 and `04` §3: new global `SYSTEM_ROLES` incl. "Employee" vs `12` WP 1a.2 templates seeded per company + D5 "Passenger" | Role name **Passenger** (D5); per-company templates seeded only when `etms` is enabled (`12` WP 1a.2) | **Resolved** for the role name (D5): notes in `03` §1, `04` §3, `08` §3.1, `09` §3, `11` §3; `02` §3.1. **Open — P6** for the template mechanism and set ("templates, not global `SYSTEM_ROLES`" is P6's recommended default) |
| Fleet allocation phase | `03` §2 / `04` §8: E2 vs `12` §6: E1b | E1b (R1 is corporate-managed only, D8) | **Resolved** (follows `12`; D8): notes in `03` §2, `04` §8 |
| Routing branch handling | `03` §6 "rebase / merge main into the branch" vs `12` §1 / D3 fresh branch + selective port | Selective port onto a fresh branch from main after the compatibility review; old branch isolated until then | **Resolved** (D3): notes in `03` §6, §8 |
| Branch model renames inside `06` | `06` §6 renames plan models to `TransportPlan*` while its R-2 names only `RouteStop` | Only `RouteStop` renamed, after review | **Resolved** (D3): note in `06` §6 |
| Agreement scope helper | `04` §2 `agreementScope(ctx)` with unchanged `AuthContext` vs D1 `ctx.agreements` | `ctx.agreements` + one helper file `transport-scope.ts` | **Resolved** (D1): note in `04` §2 |
| Incident tables | `04` §8 `TransportIncidentAction` vs `02` §3.1 `TransportIncidentEvent` | `TransportIncidentEvent` (+ `TransportEscalationStep`) | **Resolved** (Lead naming; C2): notes in `03` §1 / §2, `04` §8 |
| OTP lifetime | `09` §1.1 "10-min" vs `08` §3 / code 5 min | 5 min (`auth.service.ts` l.29 `OTP_TTL_MS`) | **Resolved**: false claim F5 corrected in `09` §1.1 |
| Map tiles today | `07` §1.3, `09` §1.4 "self-hosted tiles" vs `08` §1.4 OpenFreeMap default | Code defaults are OpenFreeMap; production web build configured for Martin (Lead-verified); **but the public share page hard-codes OpenFreeMap** (`PublicSharePage.tsx:104`, found in E0.5, `14` G8 F1); mobile builds not yet. G8 covers share page, web fallbacks and mobile builds | **Resolved** in the docs: F2 corrected in `07` §1.3, F6 in `09` §1.4, share page added to `12` G8 and §2 above; gate G8 itself is outstanding (D6) |
| Tracker queue cap | `08` §1.2 / `09` §1.5 "20 000" | 50 000 (`PointQueue.kt` l.18 `CAP`) | **Resolved**: F4 corrected in `08` §1.2, F7 in `09` §1.5 |
| Retry ownership | `02` §8.3 attributed "no XACK on failure" to G3 | G2 | **Resolved** in E0 (`02` §8.3) |
| D7 / D5 wording | `02` diagram and `13` ETR-10 "approved exception"; `13` ETR-39 "D5 accepted" | Reworded to "pending" in E0; D5, D7 and L4 were then approved on 2026-11-11 | **Resolved**: now "approved 2026-11-11" in `02` §2, §8; `13` ETR-10, ETR-39 (P3 stays open for dual-role / multi-membership) |
| Chaos figure | `10` §1.5 "36,220 sent, 0 lost" vs evidence 26,521 / 26,521 | Evidence figure (`docs/reliability/test-evidence.md` l.75) | **Resolved**: corrected in `10` §1.5; re-run required by C6 |

The seven false claims of `VALIDATION.md` §2.3 are corrected in place (F1 `06` §5; F2 `07` §1.3; F3 `07` §6.1; F4 `08`
§1.2; F5 `09` §1.1; F6 `09` §1.4; F7 `09` §1.5), each with a `Corrected in E0.5 (2026-11-11)` note and code evidence.

## 7. Owner decision list (P7, L4, O8, O9 approved 2026-11-11; O4, O10, O12, O17, O19 resolved 2026-11-11 after the `14` review; all others unresolved)

Merged and de-duplicated from the agents' open questions (`01` §13, `04` §11, `03` §8, `06` §8, `07` §9, `08` §8, `09`
§8, `10` §8, `11` §9) and, in E0.5, from `14` §9, `15` §13 and `16` §9 (new IDs O10–O19 and L8; the source question
numbers carry the README ID). **Rows marked ✅ are decided** (four approvals of 2026-11-11, plus five IDs resolved by
the owner's review of `14` on 2026-11-11, `14` §9). O11 and O18 are **partly resolved** (◐; the remaining part is
named in the row). The other rows show the recommended default only. Unresolved: **28** (C1–C3, L1–L3, L5–L8,
O1–O3, O5–O7, O11 ◐, O13–O16, O18 ◐, P1–P6).

| ID | Group | Decision needed | Recommended default | Sources |
|---|---|---|---|---|
| P7 ✅ **Approved 2026-11-11** | Product | Approve D1–D8, in particular R1 scope and exclusions (D8) | Approve as written | Lead |
| C1 | Commercial | ETMS pricing / licensing (driver and passenger `User`s are seat-free today) | No licensing change through the pilot; decide before general availability | `01` §8, `09` Q2 |
| C2 | Commercial | Messaging providers: activate Smartping DLT (India) and a mail provider; US SMS provider later; masked calling | Activate Smartping + ZeptoMail before E5; US SMS decided in E8; masked calling out of scope (paid) | `01` Q1–Q2, `10` Q5, `09` Q7 |
| C3 (still open; test approach decided 2026-11-11, `14` Q9: local stubs for early tests, staging required for production-class service checks) | Commercial / ops | Staging host (production-class, for E4 benchmarks, E7 load, E9 soak) | **Updated in E0.5:** a **separate** x86 VM on another physical host (≥ 32 GB, CPU model without AVX) before E4 benchmarks. Capped WSL2 on the dev PC is **not** feasible as staging (28.8 GB host RAM, global `.wslconfig`, AVX present while production has none) and serves only labelled pre-checks; Mintplus server as load generator only if available | `11` Q2, `13` §2, `16` §3.2 / Q1, `14` Q9 |
| L1 | Legal | Who reviews DPDP (India) and US monitoring notices; which US states first | Named counsel engaged at E0 approval; India first; US states chosen before E8 | `10` Q11 |
| L2 | Legal | Gender-related / night-shift safety rules and how the attribute is recorded | Off by default; configurable per customer after legal sign-off; self-declared attribute; never sent to drivers | `10` Q7, `06` Q6 |
| L3 | Legal | Retention: bookings / trips / events, incidents + legal hold, consent; provider access to history after an agreement ends | Bookings / trips / events 1 year; incidents 7 years with legal hold; consent life of account + statutory period; provider loses row access at agreement end (aggregates only) | `01` Q4, `03` Q2, `10` Q8, `11` Q6 |
| L4 ✅ **Approved 2026-11-11** (generic payloads; details via VeeTrax APIs) | Legal / architecture | Approve D7 push exception; timing of direct FCM / APNs evaluation | Approve Expo for R1–E5 with generic payloads; evaluate direct path in E8 before an iOS passenger pilot | `08` Q1 |
| L5 | Legal | Purge and erasure semantics | Customer purge keeps provider trip headers anonymised (SetNull); data-subject erasure anonymises profile and booking addresses in place, keeps statistics | `03` Q3–Q4 |
| L6 | Legal / privacy | Driver navigation hand-off to third-party map apps (pickup coordinates leave the phone) | `geo:` chooser, labels without names; owner may restrict to OSM-based apps | `09` Q1 |
| L7 | Legal / security | Super Admin access to passenger PII and incidents | Require a reason header and a customer-visible sensitive-access log | `10` Q9 |
| O1 (still open; 2026-11-11: v1.8.1 approved for implementation and isolated testing only, no deployment; G4 window needs a separate maintenance approval after the `14` G4 safety gate) | Ops | Approve each E0.5 v1.8.x deployment and the Valkey AOF maintenance window (key custody details split out to O11) | Approve each patch of §9.3 individually (v1.8.1 first, incl. the share-page fix); AOF in an off-peak window after the private-Valkey recovery drill | `10` Q3–Q4, `11` Q5, `14` §7 / Q8 |
| O2 | Ops | Optimiser resources on production vs a separate host | ≤ 3 GB / 1.5 cores after staging benchmarks; separate host if B6 fails | `06` Q3 |
| O3 | Ops | GraphHopper re-import for `foot` (+ `van`) profiles | Plan for E4b after B8 on staging; manual stop assignment until then | `06` Q2, Q9 |
| O4 ✅ **Resolved 2026-11-11** (`14` Q10): free, developer-only test tools approved; no paid overage, no production installation | Ops | New dev tools (Playwright, jest-expo + RNTL, Maestro CLI, k6) and CI service containers | Approve all (free, dev-only); CI containers on every PR | `11` Q3–Q4 |
| O5 | Ops / product | Escalation contacts and 24×7 desk per site; behaviour when a company is suspended mid-shift | Each site provides a desk number + contacts (users or external numbers); SOS and active trips continue during suspension | `10` Q10, Q12 |
| O6 | Ops | Device lab and iOS at pilot | Android-first pilot with 3 OEMs; one iOS device for shell smoke tests | `11` Q8, `09` Q9, `08` Q5 |
| O7 | Ops | Custody of `feature/routing-engine` / `feature/routing-r0` (single local copy; upstream `origin/main`, `push.default` unset). **Owner instruction (E0.5): keep them isolated — no push, no merge** | **Updated in E0.5:** an **off-repo `git bundle` custody copy** (e.g. on a second disk; optionally encrypted with the owner key; hashes recorded, bundle never in Git) — **recommended, not done; owner to approve**. Any remote copy only with explicit owner approval; optionally unset the `origin/main` upstream | `06` Q4, `15` §11.6 / Q9 |
| O8 ✅ **Approved 2026-11-11**: encrypted off-site object storage, independent of production and Git, user-controlled keys; nothing provisioned yet | Ops / security | Off-site target for encrypted backups. The Windows flow (`ops/backup/README.md`) uploads age-encrypted dumps as GitHub Release assets to `veetrax/dailydbbackup`; Release assets are not Git history but do store backups on GitHub | Use a non-Git object store (or a second disk / host) for the Linux production backup; retire the GitHub Release target after the G7 drill. Provider and purchase: **O10** (default AWS S3 Mumbai, earlier owner decision 2026-11-09) | E0 review (VALIDATION.md §8) |
| O9 ✅ **Approved 2026-11-11**: keep existing hand-offs during E0.5; no new external location sharing by default | Ops / privacy | Existing fleet-app hand-offs to Google Maps (`apps/mobile/src/app/sos/[id].tsx` `openDirections`, `attendance-day.tsx` `openMap`) and existing alert pushes that send full alert text and data to Expo (`notifier/push.ts`) | Decide together with L4 / L6; no change in E0.5 unless the owner asks | E0 review (VALIDATION.md §6–7) |
| O10 ✅ **Resolved 2026-11-11** (`14` Q1): AWS S3 Mumbai (ap-south-1) confirmed as the target; **purchase NOT authorised** | Ops / commercial | Off-site backup provider and purchase (under the approved O8) | **AWS S3 Mumbai (ap-south-1)** — the earlier owner decision of 2026-11-09 with verified prices (`docs/modernization/backup-plan.md` §4); needs only owner **confirmation and purchase approval** when G7 phase B is authorised; alternatives (Cloudflare R2, Backblaze B2, GCS / Azure India, second host) only if not confirmed. Nothing bought | `14` G7 / Q1 |
| O11 ◐ **Partly resolved 2026-11-11** (`14` Q2–Q3): owner holds two protected private-key copies plus one sealed deputy copy; server gets only the public key and write-only storage credentials; encrypt all backups; keep existing plaintext backups until an encrypted backup and its restore are verified and deletion is separately approved. **Open:** the deputy must be explicitly named before a real recovery arrangement is considered | Ops / security | Backup key custody and encryption: who generates and holds the GPG private key (two copies), deputy, who may restore, who holds the storage read / delete credential; encrypt today's local backups and delete plaintext after verification | Owner generates the key offline and holds both copies (safe + password manager), one sealed deputy copy; server holds the public key and a write-only credential only; encrypt everything, delete plaintext after the first verified run | `14` Q2–Q3, `10` Q3–Q4 |
| O12 ✅ **Resolved 2026-11-11** (`14` Q4): new mobile builds use `https://app.veetrax.com`; the old endpoint is preserved for existing installations. Mobile production build change and old-endpoint retirement need separate approval | Ops / product | Mobile server URL for new EAS builds (`eas.json` and code default point at `gps.mintplus.co.in`) | Switch new builds to `https://app.veetrax.com`; keep `gps.mintplus.co.in` proxying or redirecting until old installs update; owner confirms what it serves today | `14` Q4, `08` Q2 |
| O13 (still open; `14` Q9 decided the test approach only) | Ops | Second WSL distro (`veetrax-test`) on the dev PC and a `--wsl-distro` option for `chaos-run.ts` (for Valkey 7.2 / systemd drills) | Approve (free, isolated from the dev stack) | `16` Q3, `14` Q9 |
| O14 | Ops / data | Synthetic phone-number pattern `+91 00000 xxxxx` | Approve unless the SMS provider gives a reserved test range | `16` Q4, `11` Q9 |
| O15 | Ops | CI: repository privacy and free Actions quota (≈ +1,000 min / month); move CI and test processes to Node 24 | Confirm quota, no paid overage; Node 24 in WP 1a.3 | `16` Q5–Q6 |
| O16 | Ops / infra | Creating `btree_gist` on production (available 1.8, not installed, needs superuser): superuser deploy-user migration or install script | Install script as `postgres` (reviewed infra step), migration adds only the constraints; otherwise transactional checks only | `15` §8.2 / Q3 |
| O17 ✅ **Resolved 2026-11-11** (`14` Q5–Q8): five deliveries, 24-hour sweep window, CRITICAL for SOS / CRASH; `SKIPPED` for unconfigured providers in development and production, historical records preserved; proposed health severities, no automatic rollback; `maxmemory` stays a separate future decision | Ops | Gate operating parameters: G2 retry budget (DEAD after 5, sweeper 24 h, CRITICAL for SOS / CRASH); G3 `SKIPPED` also in dev; G6 severities and no automatic rollback; separate Valkey `maxmemory` item | Yes to the `14` defaults; `maxmemory` as a separate approved item after measuring | `14` Q5–Q8 |
| O18 ◐ **Partly resolved 2026-11-11** (`14` Q11): read-only, secrets-redacted inspection of the backup script and cron approved. **Open:** who performs the T5 steps (`16` Q8) | Ops / access | Production touch points: Lead read-only access to the installed backup script and cron (G7 capture); who performs T5 steps (share-link creation, aggregate query, production build capture) | Approve read-only access with secrets redacted; T5 steps by the owner or Lead after each approved deploy, never agents | `14` Q11, `16` Q8 |
| O19 ✅ **Resolved 2026-11-11** (`14` Q12): existing attendance Google Maps links preserved under O9 | Ops / privacy | O9 scope: do the web `AttendancePage.tsx` Google Maps links count as existing hand-offs to keep? | Yes (user-initiated, existing) | `14` Q12 |
| L8 | Legal / privacy | Use of a **copy of production data** (real personal data) for migration rehearsal or a G7 restore drill | **Synthetic, volume-scaled data only** (`12` §1, `16` §8 S2); a production copy only with explicit owner approval, on an owner-controlled host, destroyed afterwards | `15` Q8, `16` Q7 |
| P1 | Product | Provider model details: customer may contract several providers; agreement approval in-app by both sides or Super Admin on paper; who creates customer companies; shuttle-stop ownership | Several providers allowed; both sides approve in-app (Super Admin may draft); Super Admin creates customer companies in E1b; stops customer-owned | `10` Q1–Q2, `04` Q3–Q4, `07` Q1 |
| P2 | Product | Trip model: approve D2; one customer per trip vs pooled shuttles; recurring rosters vs daily trips | Approve D2; one customer per trip in R1 (pooling later via passenger rows); fixed shuttles via `Route` + `RouteSchedule`, door-to-door daily trips with "repeat to date" | `04` Q1–Q2, `03` Q1, `06` Q8, `07` Q2 |
| P3 | Product | Identity: one login per person; users with both fleet and passenger roles | Accept global uniqueness for E1–E3 (`IDENTITY_IN_USE`); dual-role users get the fleet shell + "My commute" | `01` Q3, `08` Q3–Q4, `09` Q3 |
| P4 | Product | What passengers see: ETA while uncalibrated, live-vehicle window, planning cadence | Time with "estimate, no live traffic" label, unavailable after 3 min without a fix; window from trip start or T−15 min to drop + 5 min; night-before planning, intra-day manual changes | `06` Q7, Q10; `08` Q7 |
| P5 | Product | Trip-execution policy defaults (E5): boarding verification; passenger self-confirm authority; passenger phone visible to drivers; no-show wait and arrival tolerance; telemetry freshness at start; duty writes `DriverAssignment` source `APP`; shared / kiosk phones | Name tick (PIN as policy flag); driver authoritative, passenger confirmation as dispute signal; dispatcher relay only; 5 min wait, k = 3; warn + dispatcher alert; yes, RFID overrides; personal phones only | `08` Q6, `09` Q4–Q8, Q10 |
| P6 | Product | UI and market: "Employee transport" group + menu keys + role templates seeded on enable; drag-and-drop dependency; overall "best scenario"; store listing / white-label; company country + `en-US` | Approve group and templates (not global `SYSTEM_ROLES`); explicit actions, no drag library; no overall winner without configured weights; reposition the VeeTrax listing, no white-label in R1; country + site time zone in E8 | `07` Q4–Q9, `08` Q8, Q10 |

## 8. Owner conditions coverage (2026-11-11 instructions)

| Condition | Where |
|---|---|
| D6 as an 8-item pre-pilot gate with owner, acceptance, evidence; backup restriction | `12` §2; §5 above (D6); `02` §10 |
| D3 wording (review before rename, selective port, Valhalla out, manual dispatch without optimiser) | §5 (D3); `02` §1.1, §3.1, §9; `12` §7 |
| D7 push exception (options, provider visibility, payload rules, retries, tokens, fallback) | `02` §8; `05` §5.5; `12` §8 |
| D8 exclusions and test-copy scope | §5 (D8); `12` §5 |
| A trip operation without a Driver App | `02` §5.3; `05` §2.6; `12` §5 |
| B component boundaries | `02` §1.1 |
| C location privacy and data flow | `02` §7 (cross-references `10` §4) |
| D authorisation matrix | `05` §6 (consistent with `10` §2.3) |
| E first-release end-to-end workflow | `02` §6 (table + Mermaid sequence); §5.1 above |
| Estimates with confidence | `13` §3 |
| Unresolved decisions with defaults | §7 above |
| E0.5 directed items (2026-11-11) and deliverables for owner review | §9 below |

## 9. E0.5 deliverables (2026-11-11) — for owner review

E0.5 was **documentation and planning only**. Nothing was implemented, deployed, provisioned, bought, migrated or
pushed; no code, schema, configuration, server or database was changed. **All eight D6 gate items (G1–G8) remain
outstanding.** The owner reviews this section before authorising any implementation (§1.1).

**Owner review of 2026-11-11 (§1.1):** v1.8.1 (G6, G1, G8 web, inert G4 installer edit) is **authorised for
implementation and isolated testing only** on `feature/hardening-v1.8.1` from `origin/main`; nothing is deployed. All
other patches are **on hold**. Corrections A–D were applied to `14`, and `14` §9 records the question resolutions.

### 9.1 The six directed items

| # | Directed item (§1.1) | Status | Where |
|---|---|---|---|
| 1 | Resolve the outstanding documentation contradictions | **Done.** 21 of the 24 E0 contradictions resolved, 3 left open as owner decisions (P6 ×2, P2). The contradictions raised by `14`–`16` are resolved by the Lead or mapped to owner decisions (§9.2) | §6; [VALIDATION.md](VALIDATION.md) §15 |
| 2 | Correct the seven false claims | **Done.** F1–F7 corrected in place with `Corrected in E0.5` notes | §6 (end); VALIDATION §2.3 |
| 3 | Prepare the eight D6 pre-pilot fixes with acceptance criteria and evidence | **Done as specification only** (nothing implemented). Effort 4.5–6.7 ew | [14](14-d6-release-gate-specs.md); `12` §2 |
| 4 | Finalise the database change plan from the authoritative data-model documents | **Done as a plan only** (no migration written or run). 13 R1 tables; C-1 / C-2 confirmed by the Lead | [15](15-database-change-plan.md); `12` §5 |
| 5 | Prepare the isolated test-environment requirements | **Done as requirements only** (nothing provisioned) | [16](16-test-environment-requirements.md) |
| 6 | Keep the old routing branch isolated until its compatibility review | **Kept isolated:** not pushed, merged, rebased or checked out (read with `git show` only). Review plan written; custody is owner decision O7 | `15` §11; §7 O7 |

### 9.2 New findings (Lead integration, 2026-11-11)

1. **Live breach on the public share page:** `PublicSharePage.tsx:104` hard-codes `OPENFREEMAP.standard`, so production
   share pages load OpenFreeMap tiles although the production build's `VITE_MAP_STYLE_*` (verified) point at
   `app.veetrax.com/tiles`. G8 now covers the share page and the mobile builds explicitly; the old G8 web acceptance
   ("bundle built with `VITE_MAP_STYLE_*`") would have passed while the leak continued. Recommended fix: v1.8.1 next to
   G1 — **outstanding, needs owner approval** (O1).
2. **Backup gap:** the production backup omits uploaded files (`apps/api/var`: documents, selfies, invoices). Added to
   G7's scope, with mandatory client-side encryption.
3. **Earlier owner decision on off-site storage:** `docs/modernization/backup-plan.md` §4 records AWS S3 Mumbai
   (ap-south-1), owner decision 2026-11-09, not created, with verified prices. It is consistent with O8; presented as the
   default needing only confirmation and purchase approval (O10). No purchase.
4. **`btree_gist`:** available on production PostgreSQL 18.6 (1.8) but not installed; creating it needs superuser (O16).
5. **Baselines on the wrong versions:** the probe and chaos baselines ran on Node 22 / Valkey 9; C6 re-runs must use
   production versions (Node 24.22.2, Valkey 7.2.13; `16` §6; `13` ETR-46).
6. **Staging:** capped WSL2 on the dev PC cannot be production-class (28.8 GB RAM, global `.wslconfig`, AVX present vs
   none on production). C3 now recommends a separate host; **still unresolved**.
7. **G4 drill** needs a private Valkey 7.2 instance, not the shared WSL Valkey (db 1 / db 0) (`12` G4).
8. **Probe count:** after G5 the probe baseline is 0 FAIL with 21 PASS (20 original + F-1) (`12` G5 / E1a).
9. **E3 burst SLO:** measured on T3 as indicative in E3; the SLO of record is measured on staging at E9 (`12` §5, §12).
10. **E3 database changes:** two migrations (`etms_bookings_trips` with WP 3.0; `planned_trip_origin` with WP 3.1, same
    PR) and an eighth E3 table `TransportChangeSet` (Lead-confirmed; `12` §1, §5). The existing `trip-performance.ts`
    "No driver" grouping bug is in WP 3.1 scope.
11. **Estimates:** E0.5 implementation is **5.0–7.5 ew** (G1–G8 4.5–6.7 + 0.5-9 / 0.5-10 0.5–0.8), not 2.5–4; programme
    total **55.0–87.5 ew** excl. E4b (57.0–91.5 incl.), 66–105 with 20 % contingency (`13` §3.2).
12. **Alert-loss window is wider** than a failed `XADD`: the processor acks positions before the rule commit, so a crash
    in between also loses the notification job (`14` F6); G2's sweeper covers both.
13. **Routing branches:** local only, upstream `origin/main`, `push.default` unset. Owner instruction: no push, no merge.
    C4 / O7 now recommend an off-repo `git bundle` custody copy (not done; owner to approve).

### 9.3 D6 patch plan (proposed in `14` §7; status after the owner review of 2026-11-11 — no patch is approved for production)

| Order | Patch | Contents | Migration / restart | Status (2026-11-11) |
|---|---|---|---|---|
| 1 | **v1.8.1** | G6 health checks + `release.sh` gate; G1 share-page line; G8 web part (share-page style, self-hosted fallbacks, dist check); G4 `install-ubuntu.sh` edit (inert on the running host; fresh installs only) | API restart + web build; no migration | **Authorised — implementation in progress, not deployed.** Implementation and isolated testing only, branch `feature/hardening-v1.8.1` from `origin/main`; production deployment / restart needs separate approval |
| 2 | **v1.8.2** | G5 session-bound sockets (E1a entry dependency) | API restart; no migration | **On hold** — review after v1.8.1 |
| 3 | Ops window | G4 production AOF switch (`CONFIG SET`, no restart), after the private-Valkey drill and the `14` G4 safety gate | none | **On hold** — separate maintenance approval; `maxmemory` a separate future decision |
| 4 | **v1.8.3** | G2 + G3 notifier durability (at-least-once, no exactly-once promise) and truthful status | additive migration (`Alert.notifiedAt`, `NotificationLog` columns) + restarts | **On hold** — high-risk notifier change |
| 5 | **v1.8.4** | G7 phase A: repo kit, systemd timer, local GPG encryption incl. uploads, freshness check | API restart; production timer install | **On hold** — separate review |
| 6 | Ops | G7 phase B: off-site store (O10: S3 Mumbai confirmed), restore drill, retire the GitHub Release flow | none; needs purchase approval | **On hold** — purchase and provisioning not authorised |
| parallel | Mobile build | G8 mobile: EAS profiles and config defaults; new builds use `https://app.veetrax.com` (O12), old endpoint `gps.mintplus.co.in` kept working | none; store submission | **On hold** — EAS build, store submission and old-endpoint retirement need separate approval |

0.5-9 (permission ceiling, R-12) and 0.5-10 (SOS ack audit) are E1a entry items outside the gate (`12` §2.2); they are
not yet assigned to a patch.

### 9.4 Not authorised

*Updated 2026-11-11:* the v1.8.1 items (G6, G1, G8 web, inert G4 installer edit) are now authorised for
implementation and isolated testing only, and free developer-only test tools are approved (O4, no production
installation). Everything else below stays not authorised, in particular production deployment or restart, production
Valkey changes, DB migrations, mobile store submission, purchases or provisioning, and destructive DB or backup
operations.

Implementation of any G-item or WP; any production deployment or production configuration change (including the
Valkey AOF switch and the backup timer); any migration run or extension install (`btree_gist`); buying or provisioning
storage (S3 or any alternative); infrastructure changes (staging host, second WSL distro, global `.wslconfig`, CI
service containers, new dev tools); pushing, merging, rebasing or bundling the routing branches; using production data
outside production; destructive database changes.

### 9.5 Unresolved owner decisions after E0.5

**Updated 2026-11-11 after the `14` review: 28 unresolved** (§7): C1–C3; L1–L3, L5–L8; O1–O3, O5–O7, O11 (deputy
not named), O13–O16, O18 (T5 steps); P1–P6. Approved: P7 (D1–D8), L4, O8, O9. Resolved 2026-11-11: O4, O10 (purchase
not authorised), O12, O17, O19. *(Before the review: 33 unresolved.)*
New in E0.5: **O10** off-site provider confirmation (S3 Mumbai) and purchase; **O11** key custody and encryption;
**O12** mobile server URL; **O13** second WSL distro; **O14** synthetic phone pattern; **O15** CI quota and Node 24;
**O16** `btree_gist` creation path; **O17** gate operating parameters; **O18** production touch points (read-only
backup capture, T5 steps); **O19** O9 scope for web attendance links; **L8** production-copy use for migration
rehearsal or restore drills. Updated in E0.5: **C3** (separate staging host), **O1** (per-patch approval of §9.3),
**O7** (`git bundle` custody instead of a push).

Needed first, in the Lead's view: O1 for v1.8.1 (closes the live share-page breach and G1), O12 and O18 (unblock G8
mobile and the G7 capture), O10 / O11 (G7), C3 (E4 benchmarks), O7 (single-copy risk). *2026-11-11: O12, O10 and the
O18 backup-capture part are decided; v1.8.1 is authorised for implementation only, so O1 (its deployment), the O11
deputy name, C3 and O7 remain the first open items.*
