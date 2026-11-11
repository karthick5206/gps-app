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
| D6 v1.8.3 (G2+G3) | In review (fixes f42d076) | — | — | Passed with issues → re-check running | Passed with conditions (fixed) | Not started |
| D6 v1.8.4 (G7-A), G8 mobile, G4 prod AOF | In progress (G7-A) | Not started | Not started | Not started | Not started | Blocked (owner public key; AOF window) |
| E1a | Passed (merged 20a718d) | In progress | Not started | Not started | Not started | Not started |
| E2 | Not started | Not started | Not started | Not started | Not started | Not started |
| E3 | Not started | Not started | Not started | Not started | Not started | Not started |
| E4 | In progress (review doc 17 done; optimiser + RoutingProvider on etms/e4-optimizer) | Not started | Not started | Not started | Not started | Not started |
| E5 | Not started | Not started | Not started | Not started | Not started | Not started |
| E6 | Not started | Not started | Not started | Not started | Not started | Not started |
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
