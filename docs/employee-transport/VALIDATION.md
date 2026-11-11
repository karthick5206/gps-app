# ETMS E0 — independent validation report

| Item | Value |
|---|---|
| Reviewer | Independent E0 reviewer; did not write any document in this package |
| Date | 2026-11-11 |
| Code baseline | worktree `D:\Vibhav\gps-app-wt\etms` = `origin/main` **f5b151b** (v1.8.0); routing branch read with `git -C D:\Vibhav\gps-app show feature/routing-engine:<path>` |
| Scope | `README.md`, `00`–`13`, `source/VeeTrax_Employee_Transportation_Complete_Plan.md` (15 documents) |
| Method | Claims about existing code checked with `grep`, `sed`, `git show`, `git merge-base`, `git ls-tree`. Claims in `06`–`11` were checked by four read-only sub-reviews with strict path / line rules. The reviewer re-checked their key findings directly: tile defaults, queue cap, OTP TTL, Google navigation links, push payload, routing-branch file paths and the routing default. No application code, schema, migration, database, server or flag was touched. Nothing was committed. |
| Production facts | Facts from the Lead's production check (27 GiB, `appendonly no`, backup cron, `NODE_ENV`, no SMS / mail provider) cannot be checked from the repo. They are accepted as the brief's authoritative baseline and marked UNVERIFIABLE-from-repo where an agent restated them. |

## Summary of results

| # | Check | Result |
|---|---|---|
| 1 | Cross-document contradictions | **Pass after fixes.** 12 contradictions were already resolved in README §6 and confirmed. Review found 12 more: 4 fixed directly in Lead docs, the rest resolved with validation notes and added to README §6. None is left open without a pointer to an owner decision. |
| 2 | Existing-code claims | **247 claims checked: 222 pass (89.9 %), 16 partial, 7 false, 2 unverifiable from the repo.** Pass + partial = 96.4 %. No false claim changes an architectural decision. |
| 3 | Existing vs proposed clearly separated | **Pass with exceptions.** V/P tagging is consistent. Six passages presented proposed or env-dependent behaviour as existing; each now has a note. |
| 4 | Schema conflicts with v1.8 | **Documented; none blocks R1.** 12 items, listed in §4. The `RouteStop` clash and the out-of-order branch migrations affect E4 only. |
| 5 | R1 independent of Driver app and optimiser | **Pass.** `12` dependencies and `05` R1 routes need neither. One UX passage (`07` `AssignPicker` in E3) was noted. |
| 6 | No external map / routing / geocoding calls proposed | **Pass with conditions.** No doc proposes one. The *existing* code defaults to OpenFreeMap tiles and has Google Maps hand-offs. G8 was extended to the web bundle and owner decision O9 was added. The driver navigation hand-off is an owner decision (L6). |
| 7 | Notification exception explicit | **Pass.** D7, `02` §8 and L4 cover it. Two places that called D7 "approved" were reworded. |
| 8 | Backup restrictions | **Pass with condition.** The restriction is stated in `12` §1, G7 and `02` §10, and nothing proposes backups in Git. Existing Windows backups go to GitHub Release assets; owner decision O8 was added. |
| 9 | D6 items have owner, measurable acceptance and evidence | **Pass.** All of G1–G8 have all three. |
| 10 | Phases have dependencies, test requirements and merge gates | **Pass after fixes.** E0.5 had no test gate, and E7 / E8 had schema work without a merge-gated x.0 WP. All three were added. |
| 11 | Unresolved decisions listed, not invented | **Pass after fixes.** README §7 lists them (plus the new O8, O9). Nine spots presented an owner decision as settled; each is fixed or noted. |
| 12 | Estimates realistic, with assumptions and confidence | **Pass.** The arithmetic is correct. E0.5 confidence was lowered from High to Medium. |

**Sign-off recommendation: READY WITH CONDITIONS** (§13).

---

## 1. Contradictions across the 15 documents

### 1.1 Already resolved in README §6 (confirmed)

| Topic | Confirmed resolution |
|---|---|
| Trip business status (`04` §6 vs `09` §4.1) | Derived states (D2). Validation notes added in `03` §2 and `04` §6. |
| Menu keys / feature flag (`07`, `10`, `03`) | `etms_*`, `etms_self`, `etms_driver`; feature `etms`. Notes in `07` §2.4 and `10` §2.2. |
| Branch model renames (`03` §6 vs `06` §6) | Only `RouteStop`, after review (D3). Note in `06` §6. |
| Valhalla parked fallback (`06` §2.4) | Out of scope (D3). Note in `06` §2.4. |
| Recurring rosters (`06` §5 vs `04` §6) | Nullable `routeId`; P2. Note in `06` §5. |
| Vehicle capacity phase (`03` §2) | E2. |
| Driver phone location (`10` §3 vs `09` §2.1) | Off by default (D4). Note in `10` §3. |
| Consent / policy / incident names | Agent 1 names; `EmployeeTransportConsent`. Notes in `03`, `04`, `10`. |
| Booking provider id | Both ids. Note in `03` §2. |
| Passenger stop link | FK + seq snapshot. |
| Production headroom (16 GiB vs ≈3 GB) | Both kept. Consistent: 27 GiB − 23–24 GB of configured maxima ≈ 3 GB. |
| Board phasing | Basic board in E3. Note in `07` §3. |

### 1.2 Found by this review

| # | Contradiction | Resolution |
|---|---|---|
| R1 | `03` §1 / §3 and `04` §3 add global `SYSTEM_ROLES` incl. an "Employee" role; `12` WP 1a.2 seeds role templates per company only; D5 says "Passenger" | Notes in `03` and `04`; README §6 row |
| R2 | `TransportFleetAllocation`: E2 (`03` §2, `04` §8) vs E1b (`12` §6) | E1b; notes; README §6 |
| R3 | `03` §6 "rebase / merge main into the branch" vs `12` §1 / D3 "fresh branch from main, never a rebase" | D3; note in `03` §6 |
| R4 | `06` §6 renames all plan models to `TransportPlan*` while its own R-2 names only `RouteStop` | D3; note in `06` §6 |
| R5 | `04` §2 `agreementScope(ctx)` with an unchanged `AuthContext` vs D1 `ctx.agreements` | D1; note in `04` §2 |
| R6 | `04` §8 `TransportIncidentAction` vs `02` §3.1 `TransportIncidentEvent` | `02`; note in `04` §8 |
| R7 | OTP lifetime: `09` §1.1 says 10 min, `08` §3 says 5 min | Code says 5 min (`auth.service.ts` l.29); note in `09` |
| R8 | Map tiles today: `07` §1.3 and `09` §1.4 say "self-hosted", `08` §1.4 says OpenFreeMap default | `08` is right; notes in `07` and `09`; brief corrected; G8 extended |
| R9 | `02` §8.3 assigned "no XACK on failure" to G3, while `12` puts it in G2 | **Fixed in `02`** |
| R10 | D7 / D5 described as "approved" / "accepted" in the `02` diagram, `13` ETR-10 and ETR-39, contradicting README "Proposed" | **Fixed in `02` and `13`** |
| R11 | `02` §4.1 stated two-sided approval as settled, while P1 is open | **Fixed in `02`** (marked as the recommended default, P1) |
| R12 | Chaos figure: `10` §1.5 says "36,220 sent" vs evidence 26,521 / 26,521 | Note in `10` |

Minor items: `07` counts "11 new menu keys" against 12 listed (note added). `04` §9 cites itself instead of `06` (note added). `11` Q5 is answered by the Lead box (note added). None is left for the owner except where the resolution already points to an owner decision (P1, P2, P3, P6, L4, L6, O8, O9).

---

## 2. Verification of existing-code claims

### 2.1 Totals

| Source | Checked by | Claims | Pass | Partial | False | Unverifiable |
|---|---|---|---|---|---|---|
| `00`, README, `01`, `02`, `03`, `04`, `05`, `12` | Reviewer directly | 76 | 72 | 3 | 1 | 0 |
| `06` | Sub-review + reviewer spot checks | 32 | 27 | 4 | 0 | 1 |
| `07` | Sub-review + reviewer (tiles) | 30 | 25 | 3 | 2 | 0 |
| `08` | Sub-review + reviewer (queue, push) | 24 | 22 | 1 | 1 | 0 |
| `09` | Sub-review + reviewer (OTP, nav links, queue) | 25 | 20 | 2 | 3 | 0 |
| `10` | Sub-review | 29 | 26 | 3 | 0 | 0 |
| `11` | Sub-review | 31 | 30 | 0 | 0 | 1 |
| **Total** | | **247** | **222 (89.9 %)** | **16** | **7** | **2** |

The `06` "required FK" error was found by the reviewer, not the sub-review, and is counted in the reviewer's row.

### 2.2 Sample of claims verified directly (all PASS unless marked)

- **Schema line numbers** (`apps/api/prisma/schema.prisma`, 2,800 lines), all exact:
  - `Partner` l.55, `Company` l.78, `Branch` l.115, `User` l.134 (`email` / `mobile` `@unique`).
  - `Device` l.245, `TrackedObject` l.299, `DeviceAssignment` l.363, `Driver` l.378, `DriverAssignment` l.408 (`source String`).
  - `Lookup` l.541, `Position` l.559, `AuditLog` l.600, `AuditAction` l.45 (7 values), `Session` l.617, `PushToken` l.634.
  - `Poi` l.878 (`category String`), `Alert` l.984 (`objectId` required), `NotificationLog` l.1023 (fields exactly as `01` §6.1), `MessageTemplate` l.1043, `LiveShare` l.1142, `VehicleShare` l.1208.
  - `LicenceSeat` l.1627, `LicenceOrder` l.1660.
  - `PlannedTripStatus` l.2632, `Route` l.2649, `RouteStop` l.2674, `RouteSchedule` l.2696, `PlannedTrip` l.2719 (`routeId` required l.2723, `closedBy String?` l.2740, `@@unique([scheduleId, plannedStart])`), `PlannedTripStop` l.2765, `PlannedTripEvent` l.2786.
- **Migrations:** 58 migration directories; head `20261113090000_routes_planned_trips`; RolePermission backfill at l.170–178. Drivers migration l.43–44 has the partial unique open-row indexes. The init migration creates the `Position` hypertable at l.509. There is no `CREATE POLICY` anywhere. Prisma is `^6.19.3`.
- **Auth:**
  - `OTP_TTL_MS = 5 min`, resend 30 s, 5 attempts.
  - `ACCESS_TTL_SEC = 15 min`, refresh token 30 days.
  - `AccessTokenPayload {sub, cid, sa, sid}`.
  - `X-Company-Id` is honoured only for the Super Admin.
- **Access:** `access-rules.ts` helpers. `planned-trips.service.ts` l.92–94 (scope) and l.302 (`objectScopeWhere`). There is no Prisma `$extends` / `$use`.
- **Notifications:**
  - `notifier/retry.ts` `BACKOFF_MS = [1000, 3000]`, 3 attempts.
  - The mailer logs "NOT DELIVERED" and returns normally.
  - The console SMS provider is the default; MSG91 throws "not implemented yet".
  - `arattaiEnabled @default(false)`; `PUSH_PROVIDER` / `EXPO_ACCESS_TOKEN`.
  - The notifier process hosts the webhooks and relay workers; `XAUTOCLAIM` is used.
- **Keys:** `DEFAULT_POSITIONS_STREAM_MAXLEN = 2_000_000`, `vt:ptrip:<objectId>`, `vt:plannedtrips:updates`, `vt:cache:invalidate`.
- **Kill switch:** `PLANNED_TRIPS=off` (`processor/main.ts` l.35–39).
- **Purge and retention:** `PURGE_KINDS`, `LOGICAL_KEY` (l.42), `FINANCIAL_TABLES`. Retention trims `NotificationLog`; `PlannedTrip` is not trimmed.
- **Billing:** `billing.service.ts` l.98 (platform company) and l.158 ("users are free"). `COMPANY_FEATURES` at `api.ts` l.68 = `['attendanceInsightsPlus']`. `PERSONAL_HIDDEN_MENUS` includes `drivers`, `routes`, `plannedTrips`.
- **Line-cited producers:** `history.controller.ts` l.68; `attendance.service.ts` l.743 and `reminders.service.ts` l.115 (`vt:notify` XADD); `release.sh` l.42 (`prisma migrate deploy`).
- **v1.8 trip internals:** `routeId` appears on 72 lines in 15 non-spec files (the docs say "~71 in 15"). The tracker engine has no `routeId` read. The tracker window is plannedStart −60 / plannedEnd +120 min. SOS is `mandatory: true` at `alerts.ts` l.154.
- **API surfaces:**
  - `setGlobalPrefix('api')`; `ListQueryDto` `pageSize ≤ 200`; `Paginated<T>`; `common/http-exception.filter.ts`.
  - `PlannedTripsService.start` / `complete` / `cancel` and the controller routes; `PATCH auth/me/preferences`; `PoiImportDialog`.
  - `/api/health/ready`; gateway health on `:4121`; the System Health AOF WARN (`monitoring/checks.ts` l.175–181).
  - Tracker app route `POST /api/tracker/v1/positions`; `LiveGateway` namespace `/live`.
- **Routing branch:**
  - merge-base `07077b6`; 38 commits.
  - Migrations `20261110110000_routing_engine_v2` (`CREATE TABLE "RouteStop"`) and `20261110120000_routing_jobs_plan_versions`.
  - Six models at branch `schema.prisma` l.2174–2332.
  - `PublicSharePage.tsx:139` / `live-share.service.ts:179` (share-page bug confirmed).

### 2.3 Every false claim (7)

| # | Doc · section | Claim | Fact | Action |
|---|---|---|---|---|
| F1 | `06` §5 table "Required `routeId`" | "Required FK to a master `Route`" | Required column, but **no FK**: `PlannedTrip` has no relation to `Route` | Note |
| F2 | `07` §1.3 Map row | "self-hosted tiles via `map-style.ts`" | `map-style.ts` l.34–36 falls back to OpenFreeMap; self-hosted only through the production `VITE_MAP_STYLE_*` setting | Note; G8 extended |
| F3 | `07` §6.1 | `NOT_ON_ROAD` / `OUTSIDE_GRAPH` road check in the editor | Not in code (proposed names; the contract uses `POINT_NOT_ON_ROAD` / `OUTSIDE_COVERAGE`) | Note |
| F4 | `08` §1.3 | Tracker SQLite queue "20 000" | `PointQueue.kt` l.18 `CAP = 50_000` | Note |
| F5 | `09` §1.1 | OTP "10-min code" | 5 min (`auth.service.ts` l.29) | Note |
| F6 | `09` §1.4 | Mobile "MapLibre, self-hosted tiles" | `apps/mobile/src/lib/config.ts` l.8–10 defaults to OpenFreeMap; `eas.json` sets no style | Note |
| F7 | `09` §1.4 | Tracker queue "cap 20 000" | 50 000 | Note |

### 2.4 Partial claims (16)

- **Reviewer's own checks (3):**
  - `01` §4: `ensureSystemRoles` callers omit `signup/signup.service.ts`.
  - Brief §1: "Tiles: self-hosted Martin" holds only for the production web build env. **Brief corrected (marked).**
  - README §2: "backup script and documentation not in the repo" holds for the installed cron, but `ops/backup/` holds WSL and Windows kits. **README clarified.**
- **`06` (4):**
  - `GET /routing/capabilities` has no v2 guard.
  - The branch test counts are copied, not recounted (36 vs 33; 10 vs 9; pytest 12 vs "16").
  - The risk register and decision log are at the branch repo root, not `docs/routing/`.
  - R2 is in `production-readiness.md` §8, not §7.
- **`07` (3):**
  - "22 primitives": there are 20 `.tsx` components.
  - The road preview is GraphHopper only through the env setting (code default `valhalla`).
  - `STATUS_CHIPS` is defined in `trip-format.ts`, not in the page.
- **`08` (1):** "push token tied to session": `PushToken.sessionId` is optional, and tokens without a session are also targeted (`notifier.service.ts` l.417).
- **`09` (2):**
  - The status values are cited to SPEC §3; they are in §2.
  - The `/live` socket is gated on `live_map` **or** `alerts`.
- **`10` (3):**
  - `ThrottlerModule` is also in `mobile-tracker.module.ts` and `signup.module.ts`.
  - 56 vs 58 audit-calling files.
  - The chaos figure (see R12).

### 2.5 Unverifiable from the repo (2)

The production server "27 GiB" (`06`) and the `ssh veetrax-prod` facts in the `11` box. Both come from the Lead's production check, which the brief makes authoritative, so they are accepted as given.

**Drift summary:** line numbers in `01` / `03` / `04` / `05` / `12` were exact. Path drift appears only in `06` (branch doc locations). Two docs (`07`, `09`) copied the brief's tile statement without checking the code defaults.

---

## 3. Existing vs proposed

Lead docs (`02`, `05`, `12`, `13`) open with "Proposed — needs owner approval" and mark baseline facts **(V)** with a path. Agent docs use V/P tags consistently. Exceptions found, each now noted:

1. `07` §1.3 states self-hosted tiles and the GraphHopper preview as code facts; both are env-dependent.
2. `07` §6.1 presents the `NOT_ON_ROAD` / `OUTSIDE_GRAPH` road check as existing.
3. `07` §4.3 / §5 use routing-branch features (`RoutingCapabilities`, `RoutingJob`, planner page) as available. They are labelled "routing branch", but that branch is unmerged; the E4 port is selective (D3).
4. `06` §1.4 says "Owner accepted Photon": a deployment fact, with no recorded decision.
5. `09` §5.2 cites `openDirections` as the precedent for a `geo:` chooser; it is actually a direct Google Maps intent.
6. `11` uses manual 2026-11-09 probe and chaos runs ("20/20 PASS", "0 lost") as the E1 / E9 baseline. They are real committed evidence (`docs/modernization/tenant-isolation-probes.md`, `test-evidence.md`) but not CI-produced (condition C6).

---

## 4. Schema conflicts with v1.8 (and with the routing branch)

| # | Conflict | Evidence | Impact / handling |
|---|---|---|---|
| S1 | **Model / table name clash `RouteStop`**: main `RouteStop` (routeId, seq, radiusM, offsetMin, waitMin) vs branch `RouteStop` (planId, assignmentId, demand, timeWindows…) | main `schema.prisma` l.2674; branch migration `20261110110000_routing_engine_v2` `CREATE TABLE "RouteStop"` | The branch schema cannot compile with main, and the branch migration fails on any v1.8 database. D3: rename the branch model (working name `RoutePlanStop`) only after the E4 compatibility review |
| S2 | **Migration order**: the branch's `20261110110000` / `20261110120000` sort **between** main's `20261110100000_sim_management` and `20261112090000_stock_sales` | `ls apps/api/prisma/migrations`; `git ls-tree feature/routing-engine` (branch lacks main's 20261110090000, 20261110100000, 20261112*, 20261113*) | History drift: the migrations would be inserted into an already-applied sequence. Regenerate and re-date after main's head (`12` WP 4.0) |
| S3 | Branch adds relations on `Company` / `User`; `schema.prisma`, `permissions.ts`, `nav.ts` and two more files conflict | `git merge-tree` (5 files, `06` §6) | Port onto a fresh branch from main (D3) |
| S4 | **`PlannedTrip.routeId` required** (`String @db.Uuid`, l.2723) but not an FK | schema; `01` §10 | `DROP NOT NULL` is backward-compatible DDL. The work is the 72 references in 15 files (WP 3.1 must merge before 3.4) |
| S5 | `PlannedTrip` `@@unique([scheduleId, plannedStart])` | l.2759 | ETMS trips have `scheduleId NULL`; PostgreSQL treats NULLs as distinct, so no clash, but ETMS needs its own idempotency (change-set key) |
| S6 | Agent proposal of a business-status enum on `TransportTrip` vs D2 (keep `PlannedTripStatus`) | `03` §2 table 8; `04` §6 | Adopt D2; notes added |
| S7 | Proposed name differences: `EmployeeLocationConsent` vs `EmployeeTransportConsent`; `ConsentRecord`, `Incident*`, `SafetyPolicy*` (Agent 6) | `02` §3.1 | Lead names; notes added |
| S8 | `DriverAssignmentSource += APP` described as a migration | `DriverAssignment.source` is a `String` (l.408 block) | No SQL change; **`12` WP 5.0 corrected** |
| S9 | `Poi` categories `OFFICE` / `SHUTTLE_STOP` | `Poi.category String @default("OTHER")` | No enum migration; lookup values only |
| S10 | `AuditAction += ACCESS` | enum l.45 | Additive. Inside Prisma's migration transaction the new value cannot be used in the same migration (PG 18); keep any backfill out of it |
| S11 | Purge logical key matches only a column named exactly `companyId` | `purge-plan.ts` l.42 | `02` renames some owner columns to `customerCompanyId` / `providerCompanyId`. The schema owner must give every ETMS table either a `companyId` column or explicit FKs with chosen `onDelete` (note in `03` §2) |
| S12 | Existing model names `Trip` (l.1081) and `Stop` (l.1104) belong to the automatic trip summariser | schema | All ETMS names are `Transport*` / `EmployeeTransport*`: no clash. No existing model is named `Booking`, `Shift`, `Incident`, `OutboxEvent` or `Passenger` |

Related existing-code observation: `RoutingService` defaults `ROUTER_ENGINE` to `valhalla` when unset (`routing.service.ts` l.22). The E4 adapter should make GraphHopper the only supported value (note in `06` §2.4).

---

## 5. First release vs Driver app and optimiser

- **`12` dependencies:** E3 ← E2 ← E1a ← E0.5. E4 (optimiser) and E5 (driver app) both depend **on** E3, never the reverse. E1b runs after E3.
- **E3 exit criteria:** everything must work with GraphHopper stopped. A GPS stop arrival never sets `BOARDED`. The work runs on a test copy only.
- **`05` R1 routes:**
  - `dispatch/candidates` returns **seats only in E3** (detour / ETA from E4, `null` + `degraded` when routing is down).
  - Progression is `trips/:id/start|complete|acknowledge` by the dispatcher (`etms_dispatch:command`).
  - Outcomes are recorded per passenger by the dispatcher (source `WEB`).
  - `/api/me/transport/*` is read-only in E3.
  - Route-plans and routing jobs are E4; `/api/driver/v1/*` is E5.
- **D8 / condition A:** satisfied in `02` §5.3 and `12` §5. The dispatcher advances trips, boarding and no-show are recorded separately, and vehicle GPS is never proof of boarding.
- **Soft dependencies found:**
  1. `07` §6.3 / §4.4: the E3 "assign" action opens the E7 ranked `AssignPicker`. A note now limits E3 to the seats-only picker.
  2. `07` §6.1: the E2 editor's road check needs `RoutingProvider.locate` (E4). A note says E2 runs without it.
  3. WP 3.7 push depends on D7 approval; it falls back to in-app only. Acceptable.
  4. WP 3.6 needs the G8 mobile build. Acceptable.

---

## 6. External map, routing and geocoding calls

The docs and the source plan were searched for Google Maps, Mapbox, OpenFreeMap, nominatim, OSRM, HERE, TomTom, `google.navigation`, `geo:`, `maps://`, analytics / crash SDKs and Valhalla.

| Finding | Where | Verdict |
|---|---|---|
| No doc proposes an external map, routing or geocoding service | all | Pass |
| OpenFreeMap: existing **code default** in web and mobile | `08` §1.4 (correct), G8, ETR-12 | Pre-existing breach for mobile builds. **G8 extended to the web bundle**; brief corrected |
| Valhalla kept as a parked fallback | `06` §2.4, §6, Q1 | Contradicts D3. Notes added; Lead docs say out of scope |
| Public Nominatim, OSRM, GH Directions API | `06` (historical / rejected) | Not proposed |
| Driver hand-off to an external navigation app (`geo:` chooser, `maps://`) | `09` §5.2, `12` WP 5.2, ETR-11 | **Flagged as owner decision L6** everywhere |
| Existing Google Maps links in the fleet app (`sos/[id].tsx` `openDirections` `google.navigation:` + web fallback; `attendance-day.tsx` `openMap`) | code | Not proposed by ETMS, but already sends coordinates to Google. **Owner decision O9 added** |
| Firebase / FCM / APNs / Expo | `02` §8, `08` §7 | Only as push transport under D7 |
| Esri satellite | maps README | Off (`ESRI_BASEMAP_KEY` unset); not proposed |

---

## 7. Notification exception

The exception is explicit in four places:

- **D7 (README §5):** the decision itself.
- **`02` §8:** the three options (Expo / direct FCM + APNs / no push), what Expo, Google and Apple each see, payload rules (generic text, `{kind, id}` only, no names, addresses or precise coordinates), retries, truthful status, the token lifecycle and the in-app fallback.
- **`05` §5.5:** the payload contract.
- **`12`:** WP 3.7 (push only if D7 is approved), E5 scope, and E8 (direct-path evaluation).

Owner decision L4 covers approval. Two wording fixes made it consistent: the `02` diagram and `13` ETR-10 had called the exception "approved". The new O9 records that **existing** fleet-alert pushes already send the full alert text and data to Expo (`notifier/push.ts` l.72); the D7 rules govern ETMS pushes only.

---

## 8. Backups and secrets

- **The restriction is stated** in `12` §1 ("Secrets and backups"), G7 ("`git` contains no dump, archive, key or secret", with CI secret scan), `02` §10, D6 and O1 (key custody outside Git). Evidence folders hold results only, with tokens redacted.
- **Nothing in the package proposes storing backups, keys or secrets in Git.**
- **Existing setup not addressed in G7 before this review:** `ops/backup/README.md` (Windows) uploads age-encrypted dumps as **GitHub Release assets** to the private repo `veetrax/dailydbbackup`, and the server stores a GitHub token. Release assets are not Git history, but this does store backups on GitHub. The repo also holds `ops/backup/veetrax-backup.sh` / `veetrax-restore.sh` (GPG to a public key, verified restore, manifest counts) that G7 should reuse.
- **Edits:** G7, `02` §10 and ETR-17 now say this, and owner decision **O8** chooses the off-site target.
- `11` §9 Q2 names a server IP (166.0.242.121). That is not a secret, but the owner may prefer to keep IPs out of docs.

---

## 9. D6 gate items

| Gate | Owner role | Measurable acceptance | Evidence | Comment |
|---|---|---|---|---|
| G1 share page | Web engineer + Lead | 3 synthetic shares, mapper unit test, no other swap | Unit output, Playwright before / after, deploy record | OK; bug confirmed at `PublicSharePage.tsx:139` |
| G2 lost alerts | Backend (notifier) + schema owner | 100 % jobs within 2 min, 0 lost, 0 duplicates, un-acked on failure | Chaos results, Jest counts | OK |
| G3 SENT status | Backend (notifier) | 100 % status = outcome across 5 providers; 5xx → FAILED | Jest, test-instance rows, post-deploy check | OK |
| G4 Valkey AOF | Ops + owner | kill -9 drill, groups present, chaos scenario, AOF restore | Drill log, `CONFIG GET` | OK |
| G5 logout | Backend + security | 0 events within 5 s in 20/20 runs; F-1 → PASS | Probe output, Jest | OK |
| G6 health | Ops | Raised within 2 min, cleared; `release.sh` dry run fails / passes | Tests, logs, transcript | OK; `/api/health/ready` and `:4121/health` exist |
| G7 backup / restore | Ops + owner | Restore drill counts equal, RTO ≤ 2 h, 26 h freshness WARN, secret scan | Drill log, scan, key custody | OK; O8 added |
| G8 builds w/o external maps | Mobile (+ web) | 0 foreign hosts in a 5-min capture (except push) | Host list, build id, `eas.json` diff | **Extended to the web bundle** |

All eight items have an owner, measurable acceptance and evidence. The two extra E1a entry items (0.5-9, 0.5-10) also have them.

---

## 10. Phases E0.5–E9

| Phase | Dependencies | Test requirements | Merge gate |
|---|---|---|---|
| E0.5 | none | Exit criteria + **test gate added** | Per-patch owner approval; evidence reviewed before merge (added) |
| E1a | G5, 0.5-9 | Isolation matrix 100 %, probes, Playwright | 1a.0 merge-gated |
| E2 | E1a | 10k import, purge tests, contract tests | 2.0 merge-gated |
| E3 | E2 | Full E2E on `veetrax_assess`, GH-down run, golden | 3.0 merge-gated; 3.1 before 3.4 |
| E1b | E3, P1 | Provider leakage cases, Playwright | 1b.0 merge-gated |
| E4 (+E4b) | E3, staging, review, D3 / O2 | Corpus, R4 / R5, manual dispatch with optimiser stopped | 4.0 merge-gated after review |
| E5 | E3, G8, D7, P4 / P5 | E2E scenarios, Maestro, chaos R1 | 5.0 merge-gated |
| E6 | E5, L1 / L2, C2 | Policy suite, chaos R1 / R7, Playwright | 6.0 merge-gated |
| E7 | E4, E6, E1b | Playwright journeys, R8, k6 | **7.0 added** (only if costing approved) |
| E8 | E7, C2, P6 | Webhook / HRMS / locale suites, US DST run | **8.0 added** (`Company` country / time zone needs a migration) |
| E9 | E8, staging, legal | SLOs ×2, 24 h soak, chaos, restore | Full regression + owner deployment approval |

---

## 11. Owner decisions presented as settled

| Spot | Issue | Action |
|---|---|---|
| `02` §2 diagram | "D7 approved exception" | Fixed |
| `02` §4.1 | Two-sided approval stated as fact (P1 open) | Fixed |
| `13` ETR-10 | "Approved exception D7" | Fixed |
| `13` ETR-39 | "D5 accepted" | Fixed |
| `08` §2.5 | "Decision: Option A" | Note (D4 is proposed) |
| `07` §2.2–§2.4 | Group placement, key set, templates, gating stated as fixed while Q4 / Q5 ask | Notes (P6) |
| `06` §1.4 | "Owner accepted Photon" | Note |
| `06` §2.4 | Valhalla kept as a fallback | Note (D3) |
| `10` §3 | Driver phone location during duty | Note (D4) |

Not counted as violations: `09` "masked call out of scope" (C2 lists it as a recommended default) and `11` tool choices (O4). README §7 lists every open decision with recommended defaults only; O8 and O9 were added by this review.

---

## 12. Estimates

- **Arithmetic checked:**
  - R1 (E1a 3–5 + E2 4–6 + E3 6–9) = **13–20** ✓; E0.5 + R1 = **15.5–24** ✓.
  - Total excl. E4b = 2.5+3+4+6+3+8+7+6+5+4+4 = **52.5**, and 4+5+6+9+5+13+11+10+8+7+6 = **84** ✓; incl. E4b **54.5–88** ✓.
- **Assumptions:** seven are listed (AI-assisted with human review, engineer-week unit, reuse holds, exclusions, M1 matrix, synthetic data, no contingency + add 20 %). Every phase has a confidence level.
- **Calendar sanity:**
  - R1 at 15.5–24 ew in 8–12 weeks ≈ 2 ew per week. This is plausible only with parallel agents and two reviewers, as stated.
  - Full programme at 63–101 ew (with +20 %) in 7–10 months ≈ 2.1–2.3 ew per week. This is consistent with the R1 rate.
- **Changes and caveats:**
  - **E0.5 confidence lowered from High to Medium:** ten items at 0.25–0.4 ew each, including a notifier migration with a chaos scenario, two drills and two network captures, leave little slack.
  - E5 (7–11 ew, Low) and E4 (8–13 ew, Low) are the least certain, which the doc already says.
  - Legal and registration elapsed times are excluded from the ranges and correctly put on the critical path.

---

## 13. Sign-off recommendation

**READY WITH CONDITIONS.** The package is internally consistent after this review. Its baseline facts are about 90 % exactly right and 96 % substantially right. No architectural decision rests on a false claim. These conditions apply:

| # | Condition | When |
|---|---|---|
| C1 | Owner approves D1–D8 (P7) and decides L4 (push exception) before WP 3.7 ships push, and O8 (backup off-site target) before the G7 drill | Before E0.5 / E1a start |
| C2 | The schema owner writes the E1a / E2 / E3 migrations from `02` §3.1 / §4 / §5 and `12` (Lead names, D2 derived states, dual keys, no global `SYSTEM_ROLES` change), **not** verbatim from `03` §2 / `04`. The purge logical-key choice (S11) is made per table in WP 2.0 / 3.0 | E1a–E3 |
| C3 | G8 is verified for both mobile builds and the web bundle. Owner decides O9 (existing Google Maps links and full-text alert pushes) | E0.5 |
| C4 | `feature/routing-engine` is archived to a private remote ref (O7) before any E4 work. The compatibility review re-runs the branch test counts instead of quoting its docs | Before E4 prep |
| C5 | Agents correct F2–F7 the next time they edit `07` / `08` / `09`. The validation notes are authoritative until then | Next revision |
| C6 | The isolation-probe and chaos baselines ("20/20 PASS", "0 lost") are re-run on the test instance (ideally in CI) before they serve as E1a / E5 / E9 acceptance baselines; today they are manual runs from 2026-11-09 | E0.5 / E1a |

There are no blockers.

---

## 14. Edits made by this review

### 14.1 Lead documents (fixed directly)

| File | Section | Change | Reason |
|---|---|---|---|
| `02-target-architecture.md` | §2 diagram (EXPO node) | "D7 approved exception" → "D7 exception, pending owner approval L4" | D7 is proposed (R10) |
| `02-target-architecture.md` | §1.1 after the boundaries table | Added a tile caveat paragraph (OpenFreeMap code defaults; G8) | False "self-hosted" impression (F2 / F6) |
| `02-target-architecture.md` | §4.1 Agreement row | Two-sided approval marked "recommended default (P1)" | Owner decision presented as settled (R11) |
| `02-target-architecture.md` | §8.3 Retries row | G3 → G2 (+ G3 truthful status) | Wrong gate reference (R9) |
| `02-target-architecture.md` | §10 Backups row | Reuse of `ops/backup/` scripts; GitHub Release storage → O8 | Point 8 |
| `12-phased-implementation-plan.md` | §2.1 G7 | Reconcile with `ops/backup/`; off-site target O8; owner approves the target | Point 8 |
| `12-phased-implementation-plan.md` | §2.1 G8 | Added the web bundle check and web engineer | Point 6 (F2) |
| `12-phased-implementation-plan.md` | §2.2 exit paragraph | Added the E0.5 **test gate** and merge rule | Point 10 |
| `12-phased-implementation-plan.md` | §8 WP 5.0 | `DriverAssignmentSource += APP` is a TS union, no SQL | S8 |
| `12-phased-implementation-plan.md` | §10 E7 | Added merge-gated 7.0 (cost tables, only if C1) | Point 10 |
| `12-phased-implementation-plan.md` | §11 E8 | Added WPs 8.0 (merge-gated `Company` country / time zone migration) – 8.4 | Point 10 |
| `13-risks-dependencies-and-estimates.md` | §1.1 ETR-10 | "Approved" → "Proposed … pending L4" | Point 11 (R10) |
| `13-risks-dependencies-and-estimates.md` | §1.2 ETR-17 | Existing `ops/backup/` and GitHub Release storage; O8 | Point 8 |
| `13-risks-dependencies-and-estimates.md` | §1.4 ETR-39 | "D5 accepted" → "D5 proposed … pending P3" | Point 11 (R10) |
| `13-risks-dependencies-and-estimates.md` | §3.2 E0.5 row | Confidence High → Medium, with reason; G2 added to uncertainty | Point 12 |
| `README.md` | §2 Lead verifications | Backup bullet clarified (`ops/backup/` kits, O8) | Partial claim |
| `README.md` | §3 index | Added a `VALIDATION.md` row | Navigation |
| `README.md` | §6 | Added 12 review rows (marked "Added by the E0 review") | Point 1 |
| `README.md` | §7 | Added O8 (backup off-site target) and O9 (existing Google Maps links / full-text pushes) | Points 6–8, 11 |

### 14.2 Brief

| File | Section | Change | Reason |
|---|---|---|---|
| `00-e0-brief.md` | §1 table, new row "*Correction (E0 review, 2026-11-11)*" before "Passengers" | Tiles self-hosted only through the production web build env; code defaults are OpenFreeMap; mobile `eas.json` sets none; `ROUTER_ENGINE` defaults to `valhalla` | Verified code fact; the original text led `07` / `09` into false claims. Marked as a correction |

### 14.3 Agent documents (36 validation notes, findings not rewritten)

Each note is a `> **Validation note (E0 review):** …` blockquote placed after the passage concerned.

| File | Section(s) | Reason |
|---|---|---|
| `01` | §4 (`ensureSystemRoles`) | Missing caller (partial) |
| `03` | §1 Roles row; §1 Consent row; §2 table (TransportTrip status, booking dual keys, purge logical key); §2 later-phase list (fleet allocation); §6 resolution (rebase) | R1, S7, S6, S11, R2, R3 |
| `04` | §2 (`agreementScope`); §3 (Employee role, consent name); §6 (business status); §8 (fleet allocation phase, incident tables); §9 legend (self-reference) | R5, R1, S6, R2, R6 |
| `06` | §1.3 optimiser row (test counts); §1.3 ops / docs row (paths, capabilities guard); §1.4 (Photon "owner accepted"); §2.4 (Valhalla fallback; `ROUTER_ENGINE` default); §5 (`routeId` not an FK; `Route.source` absent); §6 (rename-all, park) | Partial claims, F1, D3, R4 |
| `07` | §0 item 9 (key count); §1.3 Map row (tiles, routeVia); §2.4 (flag name); §3 phases table (board in E3); §4.4 (`AssignPicker` in E3); §6.1 (`NOT_ON_ROAD`) | F2, F3, R8, D8, point 5 |
| `08` | §1.3 (queue cap); §2.5 ("Decision" is a recommendation); §7.3 (existing push payload / optional session) | F4, point 11, point 7 |
| `09` | §1.1 (OTP 10 → 5 min); §1.4 tiles + socket gate; §1.4 queue cap + `DriverAssignment.source` String; §5.2 (precedent is Google Maps, not `geo:`) | F5, F6, F7, point 6 |
| `10` | §1.5 (chaos figure); §2.2 item 7 (`transport_*` keys); §3 (driver phone location vs D4); §4.2 (`ConsentRecord` name) | R12, naming, D4, S7 |
| `11` | §1.6 backup README row (GitHub Release assets; reuse `ops/backup` scripts); §9 Q5 (answered by Lead box) | Point 8; consistency |

No application code, Prisma schema, migration, configuration or flag was modified. No database, server or external service was contacted. Nothing was committed.
