# VeeTrax Employee Transportation Management System (ETMS) — E0 architecture pack

## 1. Purpose and status

This folder is the E0 (discovery and architecture) output for ETMS inside the VeeTrax GPS platform: verified current
state, proposed target architecture, data model, contracts, phased plan, risks and estimates.

| Item | Value |
|---|---|
| Status | **E0 complete, pending owner approval.** No code, schema, configuration or server was changed. Nothing in these documents is implemented or tested unless a section cites existing code or a Lead production check. |
| Decisions | D1–D8 below are **Proposed — need owner approval**. The owner decision list (§7) is **unresolved** in full. |
| Next step | Owner reviews §5 and §7; on approval, E0.5 (hardening gate) and E1a can start (`12`). |

## 2. Inspected baseline

| Item | Fact |
|---|---|
| Repository / branch / commit | `karthick5206/gps-app`, `origin/main` = **f5b151b** = tag **v1.8.0** (deployed 2026-11-11); worktree `D:\Vibhav\gps-app-wt\etms` at the same commit |
| Unreleased routing work | local-only `feature/routing-engine` (38 commits) and `feature/routing-r0`, read with `git show` only |
| Production host | Ubuntu 24.04, 27 GiB RAM, 6 vCPU; GraphHopper 11.1 India, Photon 1.3, Martin, PostgreSQL 18 + TimescaleDB, Valkey 7.2, Caddy (`00-e0-brief.md` §1) |

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

## 3. Reading order and document index

Read in this order: this README → `02` → `01` → `03` → `04` → `05` → `06` → `07` → `08` → `09` → `10` → `11` → `12` → `13`.

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
| — | [VALIDATION.md](VALIDATION.md) | Independent reviewer | E0 review: claim verification, contradictions, schema conflicts, sign-off recommendation, list of review edits |

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
   `TransportScheduleException`, `TransportBooking`, `TransportTrip`, `TransportTripPassenger`, `TransportTripEvent`;
   extensions `PlannedTrip.routeId` nullable + `origin`, `Driver.userId`, `NotificationLog` columns,
   `Alert.notifiedAt`, `AuditAction.ACCESS`. Later: fleet allocation, stop profile, driver duty, incidents, policies.
   Evidence: `03` §2–3, `04` §9, `02` §3.1 (naming), `12` §3–5.
9. **Provider → customer authorisation (V today, P proposed).** Today none: `Partner` is billing-only and
   `VehicleShare` (Super Admin) is the only cross-company grant. Proposed D1: `TransportServiceAgreement` with closed
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

All **Proposed — need owner approval.**

| ID | Decision | Detail | Differs from |
|---|---|---|---|
| D1 | Tenancy | Customer and provider are each a `Company`, linked by `TransportServiceAgreement` (closed grants, site scope, validity, approved by both sides); dual-keyed rows (`customerCompanyId`, `providerCompanyId`); agreements in `AuthContext` like `VehicleShare` behind one helper set; corporate-managed = same company / no agreement; provider users never switch company; `Partner` stays billing-only. `02` §4 | `04` §2 adds a separate `agreementScope(ctx)` without changing `AuthContext` — Lead adopts Agent 6's `AuthContext.agreements` |
| D2 | Trip execution | Reuse `PlannedTrip` / `PlannedTripStop` / tracker; `routeId` nullable + `origin` (`ROUTE`/`ETMS`); 1:1 `TransportTrip` (SetNull) + `TransportTripPassenger` + `TransportTripEvent`; `PlannedTripStatus` unchanged; plan states derived (Agent 5 mapping). `02` §5 | `04` §6 gives `TransportTrip` a business-status enum; `06` §5 prefers generated `Route`s for recurring rosters |
| D3 | Routing | GraphHopper is the only road engine; matrix from sparse `/route` calls cached per graph version; custom endpoint only if benchmarks fail. OR-Tools, jobs, metering and ETA labels ported **selectively after a compatibility review** onto a fresh branch from main; the conflicting `RouteStop` renamed only after reviewing schema ownership, migration history and FK dependencies. **Valhalla out of scope.** `RoutingProvider` with degraded mode; never a fabricated ETA. **Manual dispatch keeps working when the optimiser is unavailable.** Optimiser cap ~3 GB / 1.5 cores after benchmarks. `02` §1.1, `12` §7 | `06` §6 renames all branch models to `TransportPlan*` and keeps Valhalla as a parked fallback |
| D4 | Apps | `apps/mobile` hosts Passenger and Driver shells, server-enforced; `apps/tracker` unchanged; passenger phones not tracked continuously (opt-in, window-limited); driver phone needs no background location. `02` §2, §7 | `10` §3 collects driver phone location during duty |
| D5 | Identity | Passenger = `User` + Passenger role + `EmployeeTransportProfile`; driver = additive `Driver.userId` + Driver role; relationship-based access on `/api/me/transport/*` and `/api/driver/v1/*`; one login per person (global unique mobile / email) for E1–E3. `05` §6 | — |
| D6 | Hardening **release gate before the pilot** (E0.5) | Eight gate items, each with owner role, measurable acceptance and required evidence: G1 share-page bug; G2 lost alert notifications; G3 misleading `SENT`; G4 Valkey AOF incl. recovery validation; G5 logout closes / invalidates live connections; G6 routing / map health checks (+ release health gate); G7 secure backup **and restore** process (scripts and documentation in the repo; encrypted backups outside it; no dumps, archives, keys or secrets in Git); G8 mobile builds without external maps. Not finished work. `12` §2 | — |
| D7 | Push | Expo → FCM / APNs is an explicit architectural exception to "nothing leaves the server", to be approved; direct FCM / APNs evaluated in E8; providers see tokens and generic payloads only; no names, addresses or precise coordinates; details fetched via authenticated APIs; retries, failure handling, token lifecycle, in-app fallback. Map, routing, geocoding stay self-hosted. `02` §8 | — |
| D8 | Smallest useful release R1 (E1a + E2 + E3) | Corporate-managed only (agreements modelled and guarded, no provider UI); passenger import / CSV + profile + home pin via Photon + consent; shifts and recurring schedules; bookings (ad-hoc + from schedules); manual / assisted assignment to vehicles and stops publishing into `PlannedTrip`; dispatcher trip progression (no driver app; vehicle GPS for location; boarding / no-show recorded separately by the dispatcher; GPS never proof of boarding; v1.8 status semantics kept); reuse Route editor and v1.8 tracker / ETA / alerts; bookings list + basic board; passenger view of own trip on web and read-only mobile shell. **Excluded:** OR-Tools optimisation, Driver app workflows, transport-provider portal, multi-provider operational workflows, advanced billing and analytics. Testable entirely on a test copy (`veetrax_assess`, `sim:route`, synthetic passenger bots, Playwright); no production deployment. `02` §5.3, §6; `12` §5 | `07` §3 phases the trips list and board to E5 / E7 — Lead pulls a basic version into E3 |

### 5.1 First-release workflow (summary)

Employee import (corporate admin) → profile and consent (corporate admin, passenger) → shifts / schedules (corporate
admin / dispatcher) → bookings (scheduler job; dispatcher for ad-hoc) → passenger / vehicle / stop assignment
(dispatcher) → planned trip creation (publish transaction) → trip progression (dispatcher; processor for GPS-derived
start / stop arrival) → vehicle GPS tracking (device → gateway → processor) → boarding / no-show (dispatcher) →
passenger trip view (passenger) → completion and reporting (processor or dispatcher; corporate admin). Full table and
Mermaid sequence: `02` §6.

## 6. Contradictions between agent documents and how they were handled

| Topic | Contradiction | Resolution |
|---|---|---|
| Trip business status | `04` §6 business-status enum vs `09` §4.1 derived states | Derived states (D2); owner may still prefer a column |
| Menu keys / feature flag | `etms_*` + `employeeTransport` (`07`) vs `transport_*` (`10`) vs `etms` / `etmsProvider` (`03`) | `etms_*`, `etms_self`, `etms_driver`; feature `etms` (+ `etmsProvider` in E1b) — `02` §3.1 |
| Branch model renames | `RoutePlanStop` only (`03` §6) vs all `TransportPlan*` (`06` §6) | Rename only the conflicting `RouteStop`, after review (D3) |
| Valhalla | parked fallback (`06` §2.4) | out of scope (D3, owner instruction) |
| Recurring rosters | generated hidden `Route` per roster (`06` §5) vs nullable `routeId` (`04` §6) | Nullable `routeId` for ETMS trips; fixed shuttles keep real `Route`s; "repeat to date" drafts for door-to-door rosters; owner decision P2 |
| Vehicle capacity phase | `03` §2 lists `TransportVehicleProfile` as both "not E1–E3" and "E2" | E2 (needed for R1 capacity checks) |
| Driver phone location | collected on duty (`10` §3) vs not needed (`09` §2.1) | Not collected by default (D4) |
| Consent / policy / incident table names | Agent 1 vs Agent 6 names | Agent 1 names (schema owner) with Agent 6 fields; consent table renamed `EmployeeTransportConsent` — `02` §3.1 |
| Booking provider id | `03` §2 table 7 customer-only vs both ids (`04` §2, `10` §2.2) | Both ids, provider nullable until assignment |
| Passenger stop link | FK to `PlannedTripStop.id` (`03`) vs `(tripId, seq)` (`06` §5, `09`) | FK plus `pickupSeq` / `dropSeq` snapshot |
| Production headroom | "≈ 3 GB" (`11` §1.6) vs Lead check 16 GiB available | Both kept: 16 GiB is current use, ~3 GB is the ceiling if every service reaches its configured maximum; benchmarks decide |
| Board phasing | trips list / board in E5 / E7 (`07` §3) vs D8 | Basic board and trip detail in E3; full actions E7 |
| *Added by the E0 review (VALIDATION.md §1):* | | |
| Role creation | `03` §1 / §3 and `04` §3: new global `SYSTEM_ROLES` incl. "Employee" vs `12` WP 1a.2 templates seeded per company + D5 "Passenger" | Templates seeded only when `etms` is enabled; role name Passenger (validation notes in `03`, `04`) |
| Fleet allocation phase | `03` §2 / `04` §8: E2 vs `12` §6: E1b | E1b (R1 is corporate-managed only) |
| Routing branch handling | `03` §6 "rebase / merge main into the branch" vs `12` §1 / D3 fresh branch + selective port | Fresh branch from main after the compatibility review |
| Branch model renames inside `06` | `06` §6 renames plan models to `TransportPlan*` while its R-2 names only `RouteStop` | D3: only `RouteStop` renamed, after review |
| Agreement scope helper | `04` §2 `agreementScope(ctx)` with unchanged `AuthContext` vs D1 `ctx.agreements` | D1 (already noted in §5) |
| Incident tables | `04` §8 `TransportIncidentAction` vs `02` §3.1 `TransportIncidentEvent` | `TransportIncidentEvent` |
| OTP lifetime | `09` §1.1 "10-min" vs `08` §3 / code 5 min | 5 min (`auth.service.ts` l.29) |
| Map tiles today | `07` §1.3, `09` §1.4 "self-hosted tiles" vs `08` §1.4 OpenFreeMap default | `08` is right; G8 extended to the web bundle |
| Tracker queue cap | `08` §1.3 / `09` §1.4 "20 000" | 50 000 (`PointQueue.kt` l.18) |
| Retry ownership | `02` §8.3 attributed "no XACK on failure" to G3 | G2 (fixed in `02`) |
| D7 / D5 wording | `02` diagram and `13` ETR-10 "approved exception"; `13` ETR-39 "D5 accepted" | Reworded to pending owner approval |
| Chaos figure | `10` §1.5 "36,220 sent, 0 lost" vs evidence 26,521 / 26,521 | Evidence figure (validation note in `10`) |

## 7. Owner decision list — all unresolved

Merged and de-duplicated from the agents' open questions (`01` §13, `04` §11, `03` §8, `06` §8, `07` §9, `08` §8, `09`
§8, `10` §8, `11` §9). **None of these is answered; each shows the recommended default only.**

| ID | Group | Decision needed | Recommended default | Sources |
|---|---|---|---|---|
| P7 | Product | Approve D1–D8, in particular R1 scope and exclusions (D8) | Approve as written | Lead |
| C1 | Commercial | ETMS pricing / licensing (driver and passenger `User`s are seat-free today) | No licensing change through the pilot; decide before general availability | `01` §8, `09` Q2 |
| C2 | Commercial | Messaging providers: activate Smartping DLT (India) and a mail provider; US SMS provider later; masked calling | Activate Smartping + ZeptoMail before E5; US SMS decided in E8; masked calling out of scope (paid) | `01` Q1–Q2, `10` Q5, `09` Q7 |
| C3 | Commercial / ops | Staging host | Capped WSL2 on the dev workstation for E3–E4; separate VM before E9; Mintplus server as load generator only if available | `11` Q2, `13` §2 |
| L1 | Legal | Who reviews DPDP (India) and US monitoring notices; which US states first | Named counsel engaged at E0 approval; India first; US states chosen before E8 | `10` Q11 |
| L2 | Legal | Gender-related / night-shift safety rules and how the attribute is recorded | Off by default; configurable per customer after legal sign-off; self-declared attribute; never sent to drivers | `10` Q7, `06` Q6 |
| L3 | Legal | Retention: bookings / trips / events, incidents + legal hold, consent; provider access to history after an agreement ends | Bookings / trips / events 1 year; incidents 7 years with legal hold; consent life of account + statutory period; provider loses row access at agreement end (aggregates only) | `01` Q4, `03` Q2, `10` Q8, `11` Q6 |
| L4 | Legal / architecture | Approve D7 push exception; timing of direct FCM / APNs evaluation | Approve Expo for R1–E5 with generic payloads; evaluate direct path in E8 before an iOS passenger pilot | `08` Q1 |
| L5 | Legal | Purge and erasure semantics | Customer purge keeps provider trip headers anonymised (SetNull); data-subject erasure anonymises profile and booking addresses in place, keeps statistics | `03` Q3–Q4 |
| L6 | Legal / privacy | Driver navigation hand-off to third-party map apps (pickup coordinates leave the phone) | `geo:` chooser, labels without names; owner may restrict to OSM-based apps | `09` Q1 |
| L7 | Legal / security | Super Admin access to passenger PII and incidents | Require a reason header and a customer-visible sensitive-access log | `10` Q9 |
| O1 | Ops | Approve each E0.5 v1.8.x deployment, the Valkey AOF maintenance window and backup encryption-key custody | Approve G1–G8 individually; AOF in an off-peak window after the test-instance recovery drill; key held by the owner outside Git | `10` Q3–Q4, `11` Q5 |
| O2 | Ops | Optimiser resources on production vs a separate host | ≤ 3 GB / 1.5 cores after staging benchmarks; separate host if B6 fails | `06` Q3 |
| O3 | Ops | GraphHopper re-import for `foot` (+ `van`) profiles | Plan for E4b after B8 on staging; manual stop assignment until then | `06` Q2, Q9 |
| O4 | Ops | New dev tools (Playwright, jest-expo + RNTL, Maestro CLI, k6) and CI service containers | Approve all (free, dev-only); CI containers on every PR | `11` Q3–Q4 |
| O5 | Ops / product | Escalation contacts and 24×7 desk per site; behaviour when a company is suspended mid-shift | Each site provides a desk number + contacts (users or external numbers); SOS and active trips continue during suspension | `10` Q10, Q12 |
| O6 | Ops | Device lab and iOS at pilot | Android-first pilot with 3 OEMs; one iOS device for shell smoke tests | `11` Q8, `09` Q9, `08` Q5 |
| O7 | Ops | Custody of `feature/routing-engine` / `feature/routing-r0` (single local copy) | Push to a private remote ref as an archive now | `06` Q4 |
| O8 | Ops / security | Off-site target for encrypted backups. The Windows flow (`ops/backup/README.md`) uploads age-encrypted dumps as GitHub Release assets to `veetrax/dailydbbackup`; Release assets are not Git history but do store backups on GitHub | Use a non-Git object store (or a second disk / host) for the Linux production backup; retire the GitHub Release target after the G7 drill | E0 review (VALIDATION.md §8) |
| O9 | Ops / privacy | Existing fleet-app hand-offs to Google Maps (`apps/mobile/src/app/sos/[id].tsx` `openDirections`, `attendance-day.tsx` `openMap`) and existing alert pushes that send full alert text and data to Expo (`notifier/push.ts`) | Decide together with L4 / L6; no change in E0.5 unless the owner asks | E0 review (VALIDATION.md §6–7) |
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
