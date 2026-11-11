# ETMS E0: brief for all agents (Lead Architect, read first)

Source plan: `VeeTrax_Employee_Transportation_Complete_Plan.md` (owner's blueprint, 2026-11-11). This brief corrects
its outdated baseline and fixes shared terms, rules and file ownership. **E0 is discovery and architecture only.**

## 1. Inspected baseline (verified 2026-11-11)

| Item | Fact |
|---|---|
| Repository | `D:\Vibhav\gps-app`, GitHub `karthick5206/gps-app` |
| Branch / commit | `origin/main` = **f5b151b** = tag **v1.8.0** (deployed to production 2026-11-11) |
| Apps | `apps/api` (NestJS 11 + Prisma), `apps/web` (React 19 + Vite + Tailwind + MapLibre), `apps/mobile` (Expo, "VeeTrax"), `apps/tracker` (Expo + native Android tracker engine, "VeeTrax Tracker"), `packages/shared` |
| Production | **Ubuntu 24.04, 27 GiB RAM, 6 vCPU, 484 GB disk** at app.veetrax.com (not the 4 GB Windows server in the plan). systemd services api / gateway / processor / notifier / summarizer, PostgreSQL 18 + TimescaleDB, Valkey 7.2, Caddy. Runbook `ops/deploy/linux/`. |
| Routing in production | **Self-hosted GraphHopper 11.1, India, profile `car` (CH + LM)** on localhost:8989 via `apps/api/src/routing/routing.service.ts` (`ROUTER_ENGINE=graphhopper`). Geocoding: **self-hosted Photon 1.3 India** (`GEOCODER=photon`). Tiles: self-hosted Martin + Planetiler India. Owner's rule: **nothing leaves the server** (no third-party map/routing/geocoding calls). See `ops/deploy/linux/maps/README.md`. |
| Routes & planned trips (v1.8.0) | Shipped: `Route`, `RouteStop`, `RouteSchedule`, `PlannedTrip`, `PlannedTripStop`, `PlannedTripEvent`; live tracking in the processor (`apps/api/src/planned-trips/tracker/`); trip alerts (ROUTE_DEVIATION, TRIP_STOP_LATE, TRIP_STOP_SKIPPED, TRIP_NOT_STARTED, TRIP_COMPLETED); web Masters → Routes and Tracking → Planned trips; reports TRIP_PERFORMANCE / PLANNED_TRIPS. Spec: `docs/routes-trips/SPEC.md`. **No passengers yet** (spec §5 out of scope). |
| Unreleased routing work | Local-only branches **`feature/routing-engine`** (38 commits) and `feature/routing-r0` (docs). Valhalla + OR-Tools VRP worker (`services/routing-optimizer`), `apps/api/src/routing-v2/`, models `RoutePlan`, `RouteAssignment`, **`RouteStop` (name clash with v1.8.0)**, `RoutingJob`, `RoutingUsage`, `RoutePlanVersion`, migrations `20261110110000_routing_engine_v2`, `20261110120000_routing_jobs_plan_versions`. Behind `ROUTING_ENGINE_V2` and a web flag. Its own docs say "E2E benchmark prepared, not run". Not on GitHub, not in main. |
| *Correction (E0 review, 2026-11-11)* | "Tiles: self-hosted Martin" holds for the **production web build** only because its build env sets `VITE_MAP_STYLE_*`. The code defaults of web (`apps/web/src/features/live/map/map-style.ts` l.34–36) and mobile (`apps/mobile/src/lib/config.ts` l.8–10) are **OpenFreeMap** (`tiles.openfreemap.org`), and `apps/mobile/eas.json` sets no map style, so current mobile store builds most likely fetch third-party tiles. Likewise `RoutingService` defaults `ROUTER_ENGINE` to `valhalla` when unset (production sets `graphhopper`). Addressed by gate G8 (`12` §2). |
| Passengers | No Student / Passenger / Employee-passenger model in main. "Employee" today = staff attendance + phone tracker (`apps/api/src/attendance`, `mobile-tracker`). |

Read code from `origin/main` (`git show origin/main:<path>`, `git grep … origin/main -- <paths>`) or from the worktree
`D:\Vibhav\gps-app-wt\etms` (same commit). Read the routing branch with `git show feature/routing-engine:<path>`.

## 2. Shared terminology (use these words in every document)

| Term | Meaning |
|---|---|
| **Tenant** | Whatever the code really uses for isolation (Agent 1 verifies; probably `Company`). |
| **Corporate customer** | Organisation whose employees ride. |
| **Transport provider** | Operator running vehicles for one or more corporate customers. |
| **Service agreement** | Provider ↔ customer contract granting scoped access. |
| **Passenger** | An employee (later student) who rides. "Employee transport profile" = passenger data owned by the customer. |
| **Booking** | A passenger's request for a journey (ad-hoc or from a recurring schedule). |
| **Pickup point** | Door-to-door location (home) or a **shuttle stop**. |
| **Transport trip** | One vehicle run with ordered stops and passengers. Must be reconciled with v1.8.0 `PlannedTrip` (reuse vs new: decide with evidence). |
| **Route plan** | Optimiser output proposal (cf. `RoutePlan` on the routing branch) before publishing into trips. |
| **Routing adapter** | `RoutingProvider` interface over GraphHopper (production) and optionally Valhalla / OR-Tools. |

## 3. Rules for E0 agents

1. **Read-only on code.** Do not edit any file outside your own document(s) below; no schema, contract, route or
   navigation edits. Do not run migrations, connect to databases, the production server, or any external service.
2. Write only **your** file(s) in `D:\Vibhav\gps-app-wt\etms\docs\employee-transport\`. Do not commit (the Lead commits).
3. Every claim about the repository cites **exact path + symbol** (model, class, route, function). Mark sections
   **Verified (evidence)** vs **Proposed (design)**. Never claim something works without evidence (a test, code path,
   or the facts in §1).
4. Respect: India + US markets; reuse-first (no duplicate registries, services, queues, routing engines, databases);
   additive migrations; feature flags off; no paid infra; synthetic data only.
5. Keep documents decision-oriented: tables, short paragraphs, explicit open questions for the owner at the end.
6. Your final message to the Lead: ≤ 400 words, key findings + open questions + the file(s) you wrote.

## 4. File ownership

| Agent | Role | Writes |
|---|---|---|
| 0 Lead | Architecture, integration, acceptance | `README.md`, `02-target-architecture.md`, `05-api-and-event-contracts.md`, `12-phased-implementation-plan.md`, `13-risks-dependencies-and-estimates.md` |
| 1 | Platform & database auditor | `01-current-state-assessment.md`, `04-proposed-data-model-and-erd.md`, `03-database-model-inventory-and-reuse.md` |
| 2 | Routing & optimisation auditor | `06-routing-and-optimization.md` |
| 3 | Web UX / dispatcher architect | `07-web-dispatcher-ux.md` |
| 4 | Employee app architect | `08-employee-app.md` |
| 5 | Driver app architect | `09-driver-app.md` |
| 6 | Security, safety & privacy auditor | `10-security-safety-and-privacy.md` |
| 7 | QA, reliability & performance architect | `11-testing-and-acceptance.md` |

## 5. The twelve E0 questions (owner's §22)

1. Reusable Prisma models for Company/Tenant, User, Employee, Vehicle, Driver, Device, Notification, Audit, Billing? (Agent 1)
2. Actual tenant isolation mechanism? (Agents 1, 6)
3. Which Expo structure can host Employee and Driver experiences? (Agents 4, 5)
4. Routing APIs and DB models on the routing branch and in main? (Agent 2)
5. Which routing features work / remain blocked? (Agent 2)
6. Can ETMS use the existing GPS stream without duplicating telemetry? (Agents 1, 2, 7)
7. Which notification channels are implemented and operational? (Agents 1, 6)
8. Which new DB entities are genuinely required? (Agent 1)
9. How is provider-to-customer access authorised (today and proposed)? (Agent 6)
10. Driver vs employee mobile permissions? (Agents 4, 5, 6)
11. Durability of SOS and trip events through cache / queue outages? (Agents 6, 7)
12. Smallest useful E1–E3 release testable without production deployment? (Lead, from all)
