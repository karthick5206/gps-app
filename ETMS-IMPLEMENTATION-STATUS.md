# ETMS implementation status (master dashboard)

Owner authorisation **2026-11-11**: the complete ETMS programme E1a–E9, from implementation and testing through
phased production delivery. **Not included:** unapproved infrastructure purchases, paid subscriptions and unrelated
production changes. These still need separate approval: the G4 production AOF window, the G7 phase-B purchase, a
paid staging host (C3), O13 (second WSL distro), and the SMS / mail provider activation.

Sources of truth: `docs/employee-transport/` (README §1.1 approvals, §7 decisions, docs 02, 05, 12, 14, 15, 16).
Statuses used: Not started · In progress · Blocked · In review · Passed · Deployed. Each status is backed by the
evidence in the phase log below.

| Phase | Backend | Web | Mobile | QA | Security | Deployment |
|---|---|---|---|---|---|---|
| v1.8.1 / D6 (G1, G6, G8 web, G4 script) | Deployed | Deployed | Not started (G8 mobile on hold) | Passed | Passed | Deployed (2026-11-11 08:12 UTC, a393a2c) |
| D6 v1.8.2 (G5) | Deployed | — | — | Passed | Passed | Deployed (2026-11-11 09:31 UTC, a92fa45) |
| D6 v1.8.3 (G2+G3) | Deployed | — | — | Passed | Passed | Deployed (2026-11-11 10:05 UTC, f42d076) |
| D6 v1.8.4 (G7-A), G8 mobile, G4 prod AOF | In progress (G7-A) | Not started | Not started | Not started | Not started | Blocked (owner public key; AOF window) |
| E1a | Deployed | Deployed | Not started | Passed | Passed | Deployed (2026-11-11 10:10 UTC, v1.9.0) |
| E2 | Deployed | Deployed | Not started | Passed | Passed (conditions: L5 + reset residual before real data) | Deployed (2026-11-11 11:57 UTC, v1.10.0, ETMS off) |
| E3 | Deployed | Deployed | Moved to E5 (WP 3.6/3.7 delivered with E5) | Passed (re-check + WP 3.8 gate 1,606/0) | Passed (conditions: owner L5 / L7 / withdrawal policy before real data) | Deployed (2026-11-11 15:23 UTC, v1.11.0, ETMS off). **Reopened for WP 3.9 below** |
| E3 · WP 3.9 Ad-hoc trip creation (R1, **implementation authorised 2026-11-12**) | In progress (contract 18784f2 + migration 1d08467 done; API agent on `etms/adhoc-api`, E4 agent on `etms/adhoc-plan`) | In progress (`etms/adhoc-web`) | In progress (`etms/adhoc-mobile`) | Not started | Not started | Not started. Target v1.15.0; no deploy without separate approval |
| E4 | Deployed, switched off (`ETMS_ROUTING`): contracts, schema, matrix, solver v2 + corpus 36/36, worker/jobs, plans + publish via E3 | Deployed (route planner, behind flag) | — | Passed (re-check e83eb68: web optimise → review → publish at 390/1280 px) | Passed (re-check + deltas; condition: GraphHopper staging load test R-5 before enabling) | Deployed (2026-11-11 19:46 UTC, v1.13.0, off). **Enabling needs C3 benchmarks B1–B6 + R-5 load test + Python 3.14 on the host** |
| E5 | Deployed (driver API, notifications, relay; SOS WP 5.4; passenger self-booking WP 5.3; sim WP 5.5 + D1 settle grace) | Deployed (dispatcher review events, SOS lane) | Passed in source; **needs a native build** (EAS/O12 approval) + device/Maestro tests | Passed (re-checks; v1.14.0 QA fixes) | Passed (re-checks; v1.14.0 security + delta) | Deployed (v1.12.0 2026-11-11 16:08 UTC; completed in v1.14.0 2026-11-12 14:08 UTC) |
| E1b | Deployed (`etmsProvider` add-on, `X-Transport-Customer`, Super Admin access reason + access log) | Deployed (provider UI) | — | Passed (v1.14.0 QA) | Passed (v1.14.0 security + delta) | Deployed (2026-11-12 14:08 UTC, v1.14.0). Open: overlap rule per agreement (owner) |
| E6 | Not started (unblocked: E5 done) | Not started | Not started | Not started | Not started | Not started |
| E7 | Not started | Not started | Not started | Not started | Not started | Not started |
| E8 | Not started | Not started | Not started | Not started | Not started | Not started |
| E9 | Not started | Not started | Not started | Not started | Not started | Not started |

## Branch and worktree strategy

| Branch | Purpose | Base |
|---|---|---|
| `feature/hardening-v1.8.1` | D6 v1.8.1 (G1, G6, G8 web, G4 script) | origin/main f5b151b |
| `etms/e1a` | E1a integration branch; only the Lead merges into it | origin/main f5b151b + `docs/etms-e0` |
| `etms/e1a-<area>` | Per-agent branches in isolated worktrees (`D:\Vibhav\gps-app-wt\e1a-<area>`) | `etms/e1a` |
| `docs/etms-e0` | E0 / E0.5 documentation (merged into `etms/e1a`) | origin/main |

Rules: one integration branch per phase; agents work only in their own worktree and file area; the Lead reviews every
diff and runs the regression suite after each merge; no force-push; release to main only through the release
procedure (release branch → tag → main).

## Decision log (adopted 2026-11-11 from README §7 defaults, per owner instruction)

| ID | Documented default | Adopted value | Reason | Dependencies | Implementation impact |
|---|---|---|---|---|---|
| P1 | Several providers allowed; both sides approve in-app (Super Admin may draft); Super Admin creates customer companies in E1b; stops customer-owned | As default | Owner instruction to use the defaults; consistent with D1 | D1, E1a / E1b | `TransportServiceAgreement` with two-sided approval state; customer-company creation UI in E1b; stops carry the customer company id |
| P2 | Approve D2; one customer per trip in R1 (pooling later via passenger rows); fixed shuttles via `Route` + `RouteSchedule`, door-to-door daily trips with "repeat to date" | As default | Consistent with D2 | D2, E3 | `TransportTrip` 1:1 on `PlannedTrip`, single `customerCompanyId`; nullable `routeId` + `origin` (doc 15) |
| P3 | Accept global uniqueness for E1–E3 (`IDENTITY_IN_USE`); dual-role users get the fleet shell + "My commute" | As default | Consistent with D5 | D5, E2 | Passenger linkage refuses an email / mobile already owned in another company with `IDENTITY_IN_USE` |
| P6 | "Employee transport" group + menu keys + role templates seeded on enable (not global `SYSTEM_ROLES`); explicit actions, no drag library; no overall winner without configured weights; reposition the VeeTrax listing, no white-label in R1; country + site time zone in E8 | As default | Consistent with D4 and P6 | E1a (menus, module switch), E3 UI, E8 | New menu group and keys in `permissions.ts`; role templates seeded when the `etms` module is enabled for a company |
| C3 | Separate x86 VM (≥ 32 GB, no AVX) before E4 benchmarks | **Not adopted: needs a purchase / provisioning approval** | Paid infrastructure is excluded from the programme authorisation | E4 benchmarks, E7 load, E9 soak | E4 development runs on synthetic data locally; the benchmark sign-off stays blocked until a host is approved |
| D6 / G2 outbox | Doc 15 lists the outbox under E1a | **Delivered with G2 (v1.8.3), not E1a** | Avoids ETMS bypassing or duplicating the D6 notifier controls | G2 | E1a does not create the outbox table |

## Outstanding R1 requirement: ad-hoc trip creation (WP 3.9)

**Status: implementation authorised by the owner 2026-11-12 (D-A1..D-A4 approved, see below). Part of the approved R1 scope (doc 12 §5 "ad-hoc bookings (dispatcher on behalf)", doc 05
`POST /api/transport/bookings`, doc 07 bookings list); must not be dropped.** Recorded 2026-11-12 after an inspection
of v1.14.0 (586f199). Phase: **E3, new WP 3.9**, delivered as **v1.15.0**. It can run in parallel with E6.

**Requirement (owner, 2026-11-12):**
- A dispatcher creates an ad-hoc booking or trip without a recurring schedule.
- The booking has a passenger, a pickup, a destination or office, a date and a shift.
- Consent, eligibility, capacity and cut-off rules are validated.
- Vehicle and driver are assigned manually.
- Eligible ad-hoc bookings can be added to E4 optimisation drafts.
- The trip is published into the existing VeeTrax trip lifecycle.
- The trip works with the Passenger and Driver mobile sections, notifications, ETA and live tracking.
- Company and branch boundaries are kept.
- There are no duplicate bookings and no duplicate trip publishing.

### Owner decisions (approved 2026-11-12)

- **D-A1 late bookings:** dispatchers may book after the cut-off with a mandatory reason; server-enforced; the audit records cutoffAt, creation time, dispatcher and reason.
- **D-A2 destinations:** offices, approved company places, one-time map points and point-to-point journeys without an office end; no dummy offices.
- **D-A3 consent:** active passenger consent is required before a personal point (anything that is not a company place) is stored or used; the same rules on the dispatcher and passenger paths.
- **D-A4 notification:** the passenger is notified when a dispatcher books for them; generic push only, details through the authenticated API.

### Implementation log

| Step | Commit / branch | State |
|---|---|---|
| WP 3.9.1 contract (packages/shared) | 18784f2 | Done |
| WP 3.9.1 migration `20261121090000_etms_booking_journey` (journey enum, lateReason, COMMUTE-only duplicate index, P2P overlap exclusion) | 1d08467 | Done; scratch DB: deploy OK, `migrate diff` empty. **Production implication:** additive, lock_timeout 5 s, replaces one partial index (brief lock on TransportBooking) |
| WP 3.9.2 / 3.9.3 / 3.9.6 backend | `etms/adhoc-api` | In progress |
| WP 3.9.5 E4 exclusion reasons + BOOKING_CHANGED publish guard | `etms/adhoc-plan` | In progress |
| WP 3.9.4 web | `etms/adhoc-web` | In progress |
| WP 3.9.6 mobile | `etms/adhoc-mobile` | In progress |
| WP 3.9.7 integration, demo, QA, security | `etms/adhoc-r1` | Not started |

### Already implemented (do not rebuild)

| Area | What exists | Where |
|---|---|---|
| Booking API | `POST /api/transport/bookings`, Idempotency-Key required, `source = ADHOC`. Takes passenger, date, direction, optional shift, optional `pickup` / `drop` (lat/lng + label, or a company `poiId`), optional time window (≤ 12 h, not in the past), seats 1–6, `hold` (needs approval). Without points it uses the home point (only with routing consent) and the shift's site. Audited | `apps/api/src/etms/dispatch/bookings.service.ts` `create` |
| Booking checks | Active passenger profile in the caller's branches. Date ≤ 60 days ahead. One active booking per passenger, date and direction (409 `BOOKING_DUPLICATE`). Idempotent replay for the same user only. Per-user rate limit | same |
| Booking changes | `PATCH` before the cut-off (409 `AFTER_CUTOFF`); approve / reject / cancel / bulk approve | same; `BookingsPage.tsx` row menu |
| Web booking | Transport → Bookings → "New one-off booking": passenger, date, direction, shift, seats, needs approval, note. List filter "Ad-hoc / Scheduled", "Needs location" badge | `apps/web/src/features/transport/dispatch/BookingsPage.tsx` |
| Manual dispatch | Dispatch board: door-to-door trip on a chosen vehicle + driver, add passenger / add stop / reassign. Change-set checks: `CAPACITY_EXCEEDED`, `NO_SEATS_SET`, `NEEDS_LOCATION`, `CONSENT_REQUIRED`, vehicle / driver overlap (exclusion constraints), Idempotency-Key ledger, `expectedVersion` | `dispatch.service.ts`, `change-ops.ts`, `DispatchPage.tsx`, `dispatch-draft.ts` |
| Trip lifecycle | Publish creates `PlannedTrip` (origin ETMS) + `TransportTrip` + passengers atomically. The v1.8 tracker follows it (stop arrivals, ETA, alerts) | E3 WP 3.4 |
| E4 drafts | Plan creation takes every `PENDING_ASSIGNMENT` booking of the date / direction whatever its source, so ad-hoc bookings are included. Skipped reasons: `needs_location`, `consent_required`, `out_of_scope`. Publish refuses a booking that is no longer waiting (`INVALID_STATE`); publish is compare-and-set + replay | `etms/planning/plan-create.ts`, `plan-rules.ts`, `plans.service.ts` |
| Passenger | `GET /me/transport/bookings`, `trips`, `trips/:id/vehicle` (vehicle only inside the trip window, ETA). Mobile Bookings / Trips / trip detail; self-booking (WP 5.3, cut-off enforced) | `me-transport.service.ts`, `apps/mobile/src/features/transport/passenger/` |
| Driver | Duty / trip screens work on any published ETMS trip, whatever the booking source | `apps/mobile/src/features/transport/driver/` |
| Notifications | `TRIP_ASSIGNED`, `TRIP_CHANGED`, `TRIP_CANCELLED`, `TRIP_DELAYED`, `TRIP_STARTING_SOON` via the outbox relay | `etms/notifications/transport-notify-relay.service.ts` |

### Missing (genuine gaps)

| # | Gap | Effect today |
|---|---|---|
| A1 | The web dialog has no pickup, destination or time-window fields, and the shift is mandatory in the UI (optional in the API). There is no place / map-pin picker for ETMS | A dispatcher can only book "home ↔ shift office". Another pickup or destination needs the API |
| A2 | No booking edit in the web, although the `PATCH` API exists | "Needs location" bookings can't be fixed from the web, and the dispatch board skips them |
| A3 | Cut-off not applied to dispatcher creation: a late booking gets a `cutoffAt` in the past, carries no flag or reason, and can't be edited afterwards | Late bookings are silent and can't be told apart; the rule is undefined |
| A4 | Eligibility is only "active profile in the caller's branch". There is no check that the shift or destination matches the passenger's office or pickup mode (door vs shuttle stop) | Bookings outside the passenger's entitlement are accepted |
| A5 | A dispatcher-entered personal point (not a company place) is stored without a consent check; it is refused only later, at assignment (`CONSENT_REQUIRED`) | The address is stored without consent (owner decision L7), and the dispatcher finds out late |
| A6 | E4 plan creation selects only bookings whose office end equals the plan's site and, with a shift filter, the same `shiftId`. Others are filtered in the query and **not reported** in `skippedBookings` | Ad-hoc bookings with another destination or no shift disappear from drafts without a reason |
| A7 | The destination is limited by the R1 model: every booking is IN / OUT with an office end. A point-to-point ride (e.g. airport) has no defined place | Owner decision D-A2 |
| A8 | No "booking created for you" message to the passenger (WP 3.7 covers booking assigned / changed / cancelled, which the trip notifications send) | The passenger learns of an ad-hoc ride only when it is assigned to a trip |
| A9 | No end-to-end test of an ad-hoc booking with its own points through dispatch → trip → driver → passenger vehicle / ETA, or through an E4 draft | No acceptance evidence for the requirement |

### Changes required

**Backend (apps/api, packages/shared)**
- B1 (A3): cut-off on create. Proposed default: a dispatcher may book after the cut-off only with a reason (≥ 10 characters). The booking is marked late (derived `createdAt > cutoffAt`, reason in the audit and note) and the response carries `afterCutoff: true`. Self-booking keeps refusing.
- B2 (A4): shared eligibility rule used by both the dispatcher and the self-service create. The profile is active and in branch; the shift is active; the office end is the passenger's site or a company place allowed for the company; door pickup is allowed only for door pickup mode, otherwise a company stop. Code `NOT_ELIGIBLE` with the reason.
- B3 (A5): personal point without consent. Refuse with `CONSENT_REQUIRED`, or accept as "needs location" without storing the point, according to owner decision L7. A company place is always allowed.
- B4 (A6): plan creation reports every booking of the date / direction it did not take (`other_site`, `other_shift`). A shift-less ad-hoc booking whose window falls inside the plan's window can join. Activation stays behind `ETMS_ROUTING`.
- B5 (A8, if approved): `BOOKING_CREATED` passenger notification through the existing outbox, with a generic payload (L4).
- No change to duplicate protection; add tests only (see T6).

**Web (apps/web)**
- W1 (A1): booking dialog.
  - Pickup: home (with consent) / company place / map pin.
  - Destination: shift office (default) / company place / map pin if D-A2 allows.
  - Optional time window; shift becomes optional when a window is given.
  - Consent and eligibility hints; late-booking reason field.
  - Reuse the `TransportMap.tsx` map, no external map hosts.
- W2 (A2): edit booking (pickup, destination, window, seats, note) using `PATCH`, including "set location" for "Needs location".
- W3: bookings list shows "after cut-off" and custom pickup / destination labels (privacy rules of the list unchanged).
- W4 (A6): route planner shows the new skipped reasons.

**Mobile (apps/mobile)**
- M1: passenger Bookings / Trips show a dispatcher-made ad-hoc booking with its own pickup and destination labels and an "Arranged by the transport desk" note. Check the existing screens; change only labels.
- M2 (if B5): handle the `BOOKING_CREATED` notification (open Bookings).
- Driver app: no change expected; covered by tests.
- Real-device acceptance still needs the EAS / O12 native build.

### Database changes

**None expected.** `TransportBooking` already has pickup / drop label, lat / lng and place, window, `cutoffAt`, `source`
and note. "Late" is derived. A migration is needed only if the owner wants true point-to-point rides without an office
end (D-A2: new direction value or nullable site end).

### Dependencies

- **E4:** B4 / W4 code ships with routing off. Acceptance runs on the local synthetic setup. Using it in production
  still needs C3 benchmarks B1–B6, the R-5 load test and Python 3.14 on the host (unchanged). Manual dispatch (the R1
  path) does not depend on E4.
- **E5:** uses the deployed driver API, notification relay, passenger trips / vehicle / ETA and the self-booking rules
  (B2 shares one validator with WP 5.3). Device acceptance needs the native build (EAS / O12).
- **Privacy:** B3 depends on L7; consent withdrawal affects open ad-hoc bookings the same way as scheduled ones.
- **Owner decisions:**
  - D-A1: late booking policy (proposed: allowed with a reason).
  - D-A2: destinations beyond company places / office.
  - D-A3 = L7: personal point without consent.
  - D-A4: `BOOKING_CREATED` notification yes / no.

### Tests and acceptance criteria

| # | Acceptance criterion | Test |
|---|---|---|
| T1 | A dispatcher books a passenger with no schedule: company-place pickup, office destination, date, shift → `PENDING_ASSIGNMENT`. With "needs approval" → `REQUESTED` | API unit + DB test; Playwright dialog |
| T2 | A map-pin pickup is stored only under the D-A3 rule; without consent it is refused or held as "needs location", never silently stored | DB test |
| T3 | Ineligible requests are refused with `NOT_ELIGIBLE` (wrong office, door pickup for a shuttle-only passenger, inactive passenger, other branch → 404) | API unit + isolation matrix |
| T4 | After the cut-off: refused without a reason; with a reason, created and flagged `afterCutoff`, audited. Self-booking still refused | DB test |
| T5 | Manual dispatch: put the booking on a vehicle + driver; capacity, seats, overlap and consent checks refuse with their codes; publish creates `PlannedTrip` + `TransportTrip` + passenger atomically | Existing E3 gate extended with an ad-hoc case |
| T6 | Double submit of the booking → 1 booking; second booking same passenger / date / direction → `BOOKING_DUPLICATE`; same change set twice → 1 trip; a booking in an E4 draft and dispatched manually → plan publish `INVALID_STATE`, no second seat | DB tests (concurrent) |
| T7 | E4: an eligible ad-hoc booking appears in a new draft; one with another office or shift is listed in `skippedBookings` with a reason | DB test (routing on in test only) |
| T8 | Lifecycle: under `sim:route` the trip runs; driver start / pickup / drop work; the passenger sees the trip, the vehicle only inside the window, and the ETA; `TRIP_ASSIGNED` reaches the passenger | E3 gate `--http` + driver / passenger bots |
| T9 | Isolation: other company → 404; other branch dispatcher can't see or book; provider dispatcher only through an agreement with the dispatch grant | Isolation matrix rows for every new / changed route |
| T10 | Web: create, edit, set location, late reason at 390 / 1280 px; no external map hosts | Playwright + `check-no-external-maps` |
| T11 | Mobile: ad-hoc booking labels in passenger Bookings / Trips; driver trip unchanged | jest-expo component tests; device test once the build exists |

Exit: T1–T11 pass, independent QA and security review pass, owner decisions D-A1..D-A4 recorded. Release as v1.15.0
through the normal release procedure (no production change until then).

## Phase log

- **2026-11-11 · v1.8.1:**
  - Implementation c217521: G1, G6, G8 web, G4 script, plus 3 review-fix rounds.
  - Tests: API 1,293, web 204, gate 23+41 and installer 53 tests pass.
  - Evidence: 0 external requests in 908 (v1.8.0: 350 to OpenFreeMap); gate PASS / FAIL demo.
  - Security review: PASS with conditions. Independent QA is in progress. Deployment is pending.
- **2026-11-11 · E1a:** integration branch created (2173669 = origin/main + docs). Backend groundwork started.
- **2026-11-11 08:12 UTC · v1.8.1 deployed to production (a393a2c, tag v1.8.1).**
  - Before deploy: backup 08:08 UTC, plus a restore test into a scratch DB (17/17 tables match, 0 errors). `MARTIN_URL` added; `.env` saved to `/root/api.env.before-v1.8.1`.
  - Release: the new `release.sh` build check reported OK with style base `app.veetrax.com`. The health gate passed 11/11 checks (5 units, API, gateway, tracking, GraphHopper, Photon, Martin).
  - Post-deploy:
    - Built bundle: 0 outside map hosts.
    - System Health: map services all OK; returns 401 without a token.
    - Production browser capture across 8 pages: 729 requests, all to app.veetrax.com.
    - No service restarts.
  - `main` fast-forwarded to a393a2c.
  - Open: share-page capture on production waits for the test device to reconnect.
  - Open: WARN `valkey.aof`, expected while G4 production AOF is held.
- **2026-11-11 · E1a backend merged** (20a718d): agreements, `TransportServiceAgreement` migration, authorisation scope, module switch, role templates. API 1,308 / web 193 tests pass. The E1a web agent is running.
- **2026-11-11 · E4:** compatibility review (doc 17) done. Optimiser service ported without Valhalla (pytest 18/18). RoutingProvider wrapper done (API 1,292), no behaviour change.
- **2026-11-11 · D6:** v1.8.2 G5 (2ea2bda) and v1.8.3 G2+G3 (b798831) built, then merged on top of v1.8.1 (v1.8.3 includes v1.8.2). Tests: API 1,322 / 1,381. Independent QA and security reviews are running. G7-A is being built.
- **2026-11-11 09:31 UTC · v1.8.2 deployed (a92fa45, tag v1.8.2).**
  - Backup taken at 09:27 UTC.
  - Health gate PASS 11/11; build check OK; no migrations.
  - `vt:sessions:revoked` has 1 subscriber; no service restarts.
  - Production smoke test: logout closes the live socket in 465 ms, and reconnecting with the revoked token is refused ("Session ended").
  - QA: 100/100 revocation runs, isolation 20/21 (1 SKIP for missing test data). Security: PASS.
  - `main` fast-forwarded to a92fa45.
- **2026-11-11 · E1a:** QA FAIL (BUG-1 = Sec F2, BUG-2 = F8, two exit criteria missing) and Security PASS WITH CONDITIONS (F1 High, R-12). A fix branch `etms/e1a-secfix` is running; it also covers the isolation-matrix generator and the CI DB job. E1a won't deploy until a re-check passes.
- **2026-11-11 · E2:** backend done (`20261115090000_etms_people`; 10k-row import in 4.0 s; 1,384 API tests) and web done (239 web tests). A gap round is running on `etms/e2-gaps`. QA and security follow once E1a's final version is merged.
- **2026-11-11 · v1.8.4 (G7-A):** built (c7258fa): GPG to the public key only, uploads included, restore drill, systemd timer, freshness check. 83/83 drill tests. **Blocked: the owner's public key and fingerprint.**
- **2026-11-11 10:05 UTC · v1.8.3 deployed (f42d076).**
  - Migration `notifier_durability`; health gate PASS 11/11.
  - Indexes and columns verified; no notify issues.
  - QA re-check PASS WITH ISSUES (low residuals). Security conditions met.
- **2026-11-11 10:10 UTC · v1.9.0 = E1a deployed (9b86444).**
  - Migration `etms_accounts`; health gate PASS.
  - 0 agreements, 8 constraints, 4 indexes; no company has ETMS.
  - Browser check: 754 requests, all to app.veetrax.com.
  - QA re-check PASS WITH ISSUES; security re-check PASS WITH CONDITIONS. C2 met (0 roles affected); C1 reproduced locally (fresh `_test` DB, 21/21); the GitHub PR run is pending the owner.
- **2026-11-11 11:57 UTC · v1.10.0 = E2 deployed (7d55411).**
  - Migration `etms_people`: 5 tables plus the consent evidence trigger; health gate PASS; ETMS off.
  - QA re-check PASS WITH ISSUES: 55/55 security checks, B1–B10 fixed, 27/27 DB tests. Security re-check PASS WITH CONDITIONS.
  - **No real passenger data until the owner confirms L5 (erasure, including audit rewrite / `evidenceRef` / legal hold) and accepts the manual reset-link residual.**
  - Residuals: 33 untranslated strings; the dispatcher "approximate" label; `evidenceRef` kept on erase.
  - `main` fast-forwarded to 7d55411.
- **2026-11-11 15:23 UTC · v1.11.0 = E3 deployed (493befe, tag v1.11.0).**
  - Reviews: QA PASS WITH ISSUES → fixes (B1–B5, R1, R2, N1) → re-check passed. Security FAIL (H1 + M1–M6) → fixes → re-check PASS WITH CONDITIONS (N1–N5) → fixes → round 2 passed (ND1 fixed in 4f3c922). Harness defects HD1/HD2 fixed.
  - WP 3.8 gate (`npm run etms:gate -- --http`): 1,606 passed, 0 failed (AC1–AC10, AC3b sim-trip, HTTP, bots, ISO 1,293). API 2,994 / web 278 tests; web build + check-no-external-maps OK.
  - Before deploy: backup 15:19 UTC (ok); `.env` saved to `/root/api.env.before-v1.11.0`; `CREATE EXTENSION btree_gist` (1.8). PlannedTrip had 0 rows, so the migration lock had no impact.
  - Release: migrations `etms_bookings_trips` + `planned_trip_origin` applied; health gate PASS 11/11.
  - Post-deploy: 0 pending migrations; both EXCLUDE constraints present; public health 200; ETMS and planned-trips routes 401 without a token; no outside map hosts in the bundle; no customer company has `etms` (platform only, as before).
  - `main` fast-forwarded to 493befe.
  - Owner decisions open before real passenger data: L5 (erasure incl. vehicle history residue), L7 (address labels in booking lists / CSV without consent), consent withdrawal cancels bookings vs "needs location", the 20 change-sets/min limit, and the N5 place-creation residual.
- **2026-11-11 · E5:** backend (d78183b, 728b013, 64c1c46) + mobile merged onto E3 as `etms/e5` (76b38f7). API 3,718 / mobile 50 / DB 42 tests. Security PASS WITH CONDITIONS (M1 backdated arrival, M2 delay flood, M3 screenshot blocking); QA PASS WITH ISSUES (B1–B4 Medium relay defects). Fix round running. Not in branch: SOS (WP 5.4), passenger self-booking (WP 5.3), Maestro / sim scenarios (WP 5.5).
- **2026-11-11 16:08 UTC · v1.12.0 = E5 deployed (2589b58, tag v1.12.0).**
  - Reviews: Security PASS WITH CONDITIONS (M1–M3, L1–L7) → fixes → re-check PASS → leftovers R-1..R-4 fixed → delta review PASS. QA PASS WITH ISSUES (B1–B8) → fixes → re-check PASS (E3 gate PASS on the branch).
  - Final checks on 2589b58: API 3,768 tests; WP 3.8 gate `--http` 2,305 passed / 0 failed; web build + check-no-external-maps OK; mobile 52; DB 56–73.
  - Before deploy: backup 16:04 UTC (ok); `.env` saved to `/root/api.env.before-v1.12.0`; no new env vars. TransportTripEvent / NotificationLog had 0 rows (no lock impact, nothing for the widened sweeper to pick up).
  - Release: migration `20261117090000_etms_driver_ops` applied; health gate PASS.
  - Post-deploy: 0 pending migrations; no errors in API / notifier logs; driver, passenger and transport routes 401 without a token; relay running (`vt:etms:notify:hwm` advancing, lag 5 min as designed).
  - `main` fast-forwarded to 2589b58.
  - Open: mobile native build (screenshot blocking, passenger/driver shells) needs owner approval for EAS + the O12 `eas.json` URL change; device / Maestro tests; Expo web route/session gaps (web only); I1 stray test PDF; I2 bookings stay ASSIGNED after trip completion (blocks erasure until the window ends).
- **2026-11-11 19:46 UTC · v1.13.0 = E4 deployed, route optimisation OFF (d848537, tag v1.13.0).**
  - Built by 7 parallel agents: E4-A contracts + schema (P4/P6), E4-B matrix (P7), E4-C solver v2 + corpus (WP 4.3/4.4), E4-D P1 evidence + P2 + salvage, E4-E worker/jobs (P8), E4-F plans + publish via E3 (P9), E4-G web planner (P10). P0: bundle of the old routing branches at `D:\Vibhav\routing-branch-bundle\` (owner to copy off-disk).
  - Reviews:
    - Security PASS WITH CONDITIONS (M1 deadlock, L1–L9) → fixes → re-check (R1–R4) → fixes → delta PASS; D1 fixed by the Lead with a failing-first DB test.
    - QA FAIL on the web planner (B1–B3, mock hid request mismatches) → fixes + DTO contract tests → re-check PASS WITH ISSUES → closed.
  - Final checks on d848537 / 48200ee:
    - API 4,390, DB suites under the CI regex 83/83, `migrate diff` empty.
    - E3 gate `--http` 2,648 / 0 failed.
    - Web 312, mobile 52, optimiser 103 + corpus 36/36.
    - Real-process E2E 100/102 (remaining 2 closed), web Playwright against the real API optimise → review → publish at 390/1280 px.
  - Before deploy: backup 19:43 UTC (ok); `.env` saved to `/root/api.env.before-v1.13.0`; TransportTrip had 0 rows.
  - Release: migrations `routing_engine_v2`, `etms_planning_links`, `e4_security_hardening` applied; health gate PASS 11/11.
  - Post-deploy:
    - 0 pending migrations; 3 E4 triggers present.
    - API now binds 127.0.0.1:4000 only (unreachable from outside; Caddy unaffected).
    - Plan / job / capabilities routes 401 without a token; routing worker inactive.
    - Gateway restarted clean, 0 spooled positions, tracker reconnected. The "cache connection lost" line came from the old process during shutdown.
  - `main` fast-forwarded to d848537.
  - **Before enabling `ETMS_ROUTING` in production:**
    - C3 staging benchmarks B1–B6 and the GraphHopper load test with tracking traffic (R-5).
    - Python 3.14 + the optimiser venv on the host (R-9).
    - Installer run to add the two hardened units.
    - Owner review of the R2 schema decisions.
    - An escort field in the data model if escort rules are wanted.
- **2026-11-12 11:46 UTC · v1.13.1 deployed (175f78f, tag v1.13.1), routing still OFF.**
  - E4 E2E fixes plus owner decisions 1 (max ride), 2 (75-booking limit), 3 (pin = vehicle) and 5 (publish gate). Decision 4: no optimisation benchmarks or load tests against production GraphHopper; all go to C3.
  - Backup db-20261112T114303Z; `.env.pre-v1.13.1` saved; health gate PASS. `main` = ed2b101 (merge commit).
- **2026-11-12 14:08 UTC · v1.14.0 deployed (586f199, tag v1.14.0 = main), routing still OFF.**
  - Contents: E5 SOS (WP 5.4), passenger self-booking (WP 5.3), sim tooling + D1 settle grace (WP 5.5), E1b provider UI, plus the security, QA and delta review fixes.
  - Migrations `20261120090000_etms_incidents` and `20261120100000_etms_fleet_allocation` applied. Backup db-20261112T140359Z; `.env.pre-v1.14.0` saved. Rollback to v1.13.1 tested OK with the new tables present.
  - Tests at release: API 4,958; DB 22 suites 151/151; `migrate diff` empty; web 371 + build; mobile 90 + 14.
  - Production smoke on the synthetic company "VeeTrax ETMS Test (internal)": logins, self-booking, SOS → lane → acknowledge → resolve.
  - Not in this release: `etms/e4-gates` (5e1bc99).
  - Open owner items:
    - SOS visibility (L3).
    - Transport admin can't create driver logins (D2).
    - Overlap rule per agreement (E1b).
    - Driver list after auto-close (L4).
    - Privacy L5 / L7 / consent withdrawal.
    - EAS / O12 build and devices.
    - C3 purchase.
    - Python 3.14 on production.
    - E4 L4 / L5.
- **2026-11-12 · Ad-hoc trip creation recorded as an outstanding R1 requirement (E3 WP 3.9).** Inspection of v1.14.0 found gaps A1–A9; plan, dependencies and acceptance T1–T11 are in the section above. Assessment only: no code or production change. Target v1.15.0.
