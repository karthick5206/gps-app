# 17 · Routing-branch compatibility review (E4 prep step 1)

| Item | Value |
|---|---|
| Status | **Review report. Proposed, needs owner review before WP 4.0.** Nothing was implemented, merged, rebased, checked out or pushed. No branch, ref, schema or database was changed. |
| Executes | `15` §11 (routing-branch compatibility review plan), steps R1 (partly), R2–R6, R7 (Python part), R8. `12` §7 prep step 1. |
| Authority | README §5 **D3**: GraphHopper is the only road engine; Valhalla is out of scope (not even as a parked fallback); OR-Tools, jobs, metering and ETA labels are ported **selectively** onto a fresh branch from main **after** this review; only the clashing `RouteStop` is renamed. D1 (tenancy), D2 (`PlannedTrip` + `TransportTrip`, no trip status enum), D5 (identity) apply. |
| Main | `origin/main` **f5b151b** = v1.8.0. Migration head `20261113090000_routes_planned_trips`. |
| Branches | `feature/routing-engine` **19150e8**; `feature/routing-r0` **948cb44** (an ancestor of `feature/routing-engine`, verified with `git merge-base --is-ancestor`). Merge-base with `origin/main`: **07077b6** (release 1.3). 38 commits ahead, 78 behind. |
| Method | Read only, from refs: `git log`, `git show`, `git diff`, `git ls-tree`, `git grep`, `git merge-tree --write-tree` (the last writes tree objects into the object store only; no ref, index or working tree is touched). Optimiser sources were copied file by file with `git show` into the session scratchpad to run `pytest` (§6). |
| Short refs | `02`, `06`, `12`, `15` = the docs of this folder. **(V)** = verified in this review against the refs above. |

---

## 0. Summary

- **The branch cannot be merged or rebased.** `git merge-tree` reports content conflicts in 5 files; the branch migration `CREATE TABLE "RouteStop"` fails on every v1.8 database; both branch migrations sort before main's deployed migrations.
- **Three hard incompatibilities** besides the `RouteStop` clash:
  1. **Env-var collision.** The branch's `ValhallaAdapter` reads `ROUTER_URL` / `ROUTER_TOKEN` / `ROUTER_TIMEOUT_MS`. On production, main's `RoutingService` already uses `ROUTER_URL=http://127.0.0.1:8989` for **GraphHopper**. Switching v2 on there would send Valhalla requests (`/sources_to_targets`, `/locate`, `/status`) to GraphHopper.
  2. **The engine layer is Valhalla only.** That covers the matrix, `/locate` snapping, disconnected-point isolation, chunk sizes, the costing names, polyline precision 6, the graph version taken from Valhalla `/status`, `engine: 'valhalla'` literal types and the 1.60 ETA factor fitted against Valhalla.
  3. **Publish targets the branch tables, not `PlannedTrip` / `TransportTrip`.** `plans.service.ts` `publish` only flips `RoutePlan.status` to `PUBLISHED`. This conflicts with D2.
- **The Python optimiser is engine-agnostic** (V). `solve()` takes `matrix.durationsS` / `distancesM` (n × n, `null` = forbidden arc). Only `optimizer/valhalla.py` and the `--valhalla` CLI flag are coupled to an engine. **pytest re-run here: 16 passed** (§6).
- **Salvage:** port as is: optimiser core, usage metering, coverage polygon, `private-url.ts`, `API_HOST`, MiniMap attribution. Port with changes: schema (6 models), jobs/worker, access, plans, ETA labels, flags mechanism, shared contracts. Rewrite: the engine and matrix layer of `routing-v2.service.ts` and the web planner. Drop: the Valhalla adapter, the `ops/routing` Valhalla pipeline, the proxy, the hosting and E2E kits, and the Windows deploy-script edits.
- **Effort to port the accepted parts:** about **44–64 person-days** (§5.2). This excludes the new ETMS work that `12` §7 already plans: solver extensions (WP 4.3), the corpus (WP 4.4), publish into `PlannedTrip`, and benchmarks.
- **Blockers for E4:** E3 (`TransportTrip`, the publish path) must be merged first. The custody decision O7 is still open, and the branch is still a single local copy. Four ownership decisions (§2.6) need the schema owner and, for purge semantics, the owner. The staging host C3 is needed for the benchmarks. None of these blocks porting the optimiser service or the `RoutingProvider` wrapper.

---

## 1. Inventory

### 1.1 Branch facts (V, re-recorded 2026-11-11)

| Fact | Value |
|---|---|
| Tips | `feature/routing-engine` 19150e8 (2026-11-09); `feature/routing-r0` 948cb44 |
| Remote copies | `git branch -r --contains feature/routing-engine` → **none** |
| Upstream | `feature/routing-engine` → `origin/main`. `feature/routing-r0` → **no upstream** today. This differs from `15` §11.5, which says both track `origin/main`. |
| Worktrees | `D:/Vibhav/gps-app/.claude/worktrees/agent-ae5a7738419cf355c` (routing-engine @ 19150e8), `…/agent-a8909a5041d444892` (routing-r0 @ 948cb44). **Uncommitted changes in these were not inspected** (`git status` in a worktree is outside this brief); the Lead should run `git -C <worktree> status --short` (`15` §11.3 R1). |
| Size | 202 files, +28,469 / −20 since 07077b6; of which docs (`docs/routing/**`, 69 files, and root `ROUTING_*.md`) 72 files, +10,973 |

### 1.2 The 38 commits by area

| Area | # | Commits |
|---|---|---|
| R0 discovery docs (= all of `feature/routing-r0`) + merge | 12 | 17b6c38 architecture/ADR-R-001; b3865ae API contracts; 6b2eeb4 proposed Prisma models; 83f8f91 graph pipeline; bc367c2 runbook; 316cb9f cost estimate; fff177a test corpus; 408a40b R0 report; c0dc0f1 risk register; 3a41b20 decision log; 948cb44 progress; f220ff1 merge into routing-engine |
| Valhalla graph pipeline and ops tooling | 4 | 096e274 OSM → versioned Valhalla graph; 2e43976 Photon trial; 4634a86 matrix tuning / ETA calibration / geocoder set / API probe; b443b6d E2E benchmark kit, Valhalla auth proxy, concurrency probes, geocoder corpus v2 |
| Optimiser service (Python) | 1 (+1) | 115db2a OR-Tools VRP POC; ac9deaa added token / allow-list / slots (shared with the API row) |
| Database | 1 (+2) | a029293 migration 1 (5 tables); c665684 migration 2 (jobs + versions); ac9deaa schema comment and field edits |
| API routing v2 + worker | 7 | 8eedf3b v2 POC behind `ROUTING_ENGINE_V2`; 29129b5 Valhalla maneuver text; cca7213 R1/R2 coverage, graph-versioned cache, metering, isolated chunked matrix, calibrated ETA; 57665b7 per-company access, route-plans API; c665684 R5 editing/history, R6 jobs; 0a8b26b R4 geocoder eval, R7 ETA calibration, R8 India build; ac9deaa separate worker, engine/optimiser auth, per-band ETA, matrix chunking |
| Web | 4 | 0d562ac route planner POC behind `routingV2`; 09d5de6 planner map sizing; b678e2a plans tab, ETA labels, drivers can't route ad hoc; ead2fd9 plan editor + job progress |
| Independent fixes / hardening | 3 | be6ad20 **RR-14** share-page ETA `[lng, lat]` (`share-eta.ts`); bea7af0 RR-08 OSM attribution on alert MiniMap; 00978a7 `API_HOST` loopback binding |
| Retention | 1 | 6196e77 trim routing plans, finished jobs, usage |
| Phase docs, results, screenshots | 5 | c5237b6 POC benchmark; 6baa491 phase 2; 9174c74 phase 3 probe and screenshots; 18a6a03 phase 3 readiness review; 19150e8 phase 4 runbook, readiness checklist |

### 1.3 Models and enums (branch `schema.prisma`, appended after `StockMovement`)

| Model | Columns (abridged) | FKs (onDelete) | Logical keys (no FK) |
|---|---|---|---|
| `RoutePlan` | `id, companyId, branchId?, name, planDate (Date), status RoutePlanStatus, costing ('auto'), graphVersion?, depot Json?, options Json, version Int, createdById?` | `companyId → Company` **Restrict**; `createdById → User` **SetNull** (relation `RoutePlanCreatedBy`) | `branchId` |
| `RouteAssignment` | `planId, companyId, objectId?, driverId?, assigneeUserId?, vehicleLabel, seq, distanceM?, durationS?, adjustedDurationS?, startS?, endS?, geometry? (polyline6)` | `planId → RoutePlan` **Cascade**; `assigneeUserId → User` **SetNull** (`RouteAssignee`) | `companyId`, **`objectId`**, `driverId` |
| `RouteStop` (branch) | `planId, companyId, assignmentId?, ref, name?, lat, lng, demand, serviceS, timeWindows Json?, sequence?, etaS?, unassignedReason?` | `planId → RoutePlan` **Cascade**; `assignmentId → RouteAssignment` **SetNull** | `companyId` |
| `RoutingJob` | `companyId, planId?, userId?, kind, status RoutingJobStatus, input/result/error Json?, progress, attempts, maxAttempts (3), timeoutS (120), cancelRequested, idempotencyKey?, lockedBy?, lockedUntil?, startedAt?, notBefore?, createdAt, finishedAt?` | `companyId → Company` **Restrict**; `planId → RoutePlan` **SetNull** | `userId` |
| `RoutingUsage` | PK `(companyId, day)`; `routes, matrixCells, optimizeJobs, cacheHits` | `companyId → Company` **Restrict** | — |
| `RoutePlanVersion` | `planId, companyId, version, changeType, snapshot Json, changedById?` | `planId → RoutePlan` **Cascade** | `companyId`, `changedById` |

Enums: `RoutePlanStatus { DRAFT, OPTIMIZING, PLANNED, PUBLISHED, COMPLETED, CANCELLED }`, `RoutingJobStatus { QUEUED, RUNNING, SUCCEEDED, FAILED, CANCELLED }`.
Back-relations added on existing models: `Company.routePlans / routingJobs / routingUsage`; `User.routePlansCreated (RoutePlanCreatedBy) / routeAssignments (RouteAssignee)`.

### 1.4 Migrations: exact SQL (V)

**`20261110110000_routing_engine_v2/migration.sql`**

```sql
-- CreateEnum
CREATE TYPE "RoutePlanStatus" AS ENUM ('DRAFT', 'OPTIMIZING', 'PLANNED', 'PUBLISHED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RoutingJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "RoutePlan" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "branchId" UUID,
    "name" TEXT NOT NULL,
    "planDate" DATE NOT NULL,
    "status" "RoutePlanStatus" NOT NULL DEFAULT 'DRAFT',
    "costing" TEXT NOT NULL DEFAULT 'auto',
    "graphVersion" TEXT,
    "depot" JSONB,
    "options" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RoutePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteAssignment" (
    "id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "objectId" UUID,
    "driverId" UUID,
    "assigneeUserId" UUID,
    "vehicleLabel" TEXT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "distanceM" INTEGER,
    "durationS" INTEGER,
    "adjustedDurationS" INTEGER,
    "startS" INTEGER,
    "endS" INTEGER,
    "geometry" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RouteAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteStop" (
    "id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "assignmentId" UUID,
    "ref" TEXT NOT NULL,
    "name" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "demand" INTEGER NOT NULL DEFAULT 0,
    "serviceS" INTEGER NOT NULL DEFAULT 0,
    "timeWindows" JSONB,
    "sequence" INTEGER,
    "etaS" INTEGER,
    "unassignedReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RouteStop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutingJob" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "planId" UUID,
    "userId" UUID,
    "kind" TEXT NOT NULL,
    "status" "RoutingJobStatus" NOT NULL DEFAULT 'QUEUED',
    "input" JSONB,
    "result" JSONB,
    "error" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "RoutingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutingUsage" (
    "companyId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "routes" INTEGER NOT NULL DEFAULT 0,
    "matrixCells" INTEGER NOT NULL DEFAULT 0,
    "optimizeJobs" INTEGER NOT NULL DEFAULT 0,
    "cacheHits" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RoutingUsage_pkey" PRIMARY KEY ("companyId","day")
);

-- CreateIndex
CREATE INDEX "RoutePlan_companyId_planDate_idx" ON "RoutePlan"("companyId", "planDate");
CREATE INDEX "RoutePlan_companyId_status_idx" ON "RoutePlan"("companyId", "status");
CREATE INDEX "RouteAssignment_planId_idx" ON "RouteAssignment"("planId");
CREATE INDEX "RouteAssignment_companyId_assigneeUserId_idx" ON "RouteAssignment"("companyId", "assigneeUserId");
CREATE INDEX "RouteStop_assignmentId_idx" ON "RouteStop"("assignmentId");
CREATE UNIQUE INDEX "RouteStop_planId_ref_key" ON "RouteStop"("planId", "ref");
CREATE INDEX "RoutingJob_companyId_createdAt_idx" ON "RoutingJob"("companyId", "createdAt");

-- AddForeignKey
ALTER TABLE "RoutePlan" ADD CONSTRAINT "RoutePlan_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoutePlan" ADD CONSTRAINT "RoutePlan_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RouteAssignment" ADD CONSTRAINT "RouteAssignment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "RoutePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RouteAssignment" ADD CONSTRAINT "RouteAssignment_assigneeUserId_fkey" FOREIGN KEY ("assigneeUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RouteStop" ADD CONSTRAINT "RouteStop_planId_fkey" FOREIGN KEY ("planId") REFERENCES "RoutePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RouteStop" ADD CONSTRAINT "RouteStop_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "RouteAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RoutingJob" ADD CONSTRAINT "RoutingJob_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoutingJob" ADD CONSTRAINT "RoutingJob_planId_fkey" FOREIGN KEY ("planId") REFERENCES "RoutePlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RoutingUsage" ADD CONSTRAINT "RoutingUsage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

(Repeated `-- CreateIndex` / `-- AddForeignKey` comment lines are folded; every statement is shown verbatim.)

**`20261110120000_routing_jobs_plan_versions/migration.sql`**

```sql
-- AlterEnum
ALTER TYPE "RoutingJobStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "RoutingJob" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "lockedBy" TEXT,
ADD COLUMN     "lockedUntil" TIMESTAMPTZ(3),
ADD COLUMN     "maxAttempts" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "notBefore" TIMESTAMPTZ(3),
ADD COLUMN     "progress" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "startedAt" TIMESTAMPTZ(3),
ADD COLUMN     "timeoutS" INTEGER NOT NULL DEFAULT 120;

-- CreateTable
CREATE TABLE "RoutePlanVersion" (
    "id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "changeType" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoutePlanVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoutePlanVersion_companyId_createdAt_idx" ON "RoutePlanVersion"("companyId", "createdAt");
CREATE UNIQUE INDEX "RoutePlanVersion_planId_version_key" ON "RoutePlanVersion"("planId", "version");
CREATE INDEX "RoutingJob_status_lockedUntil_idx" ON "RoutingJob"("status", "lockedUntil");
CREATE UNIQUE INDEX "RoutingJob_companyId_idempotencyKey_key" ON "RoutingJob"("companyId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "RoutePlanVersion" ADD CONSTRAINT "RoutePlanVersion_planId_fkey" FOREIGN KEY ("planId") REFERENCES "RoutePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

### 1.5 APIs (V, `apps/api/src/routing-v2/routing-v2.controller.ts`)

| Controller | Endpoints | Guard / permission |
|---|---|---|
| `@Controller('routing')` `RoutingV2Controller` | `GET capabilities`; `POST routes`; `POST matrix` (sync, ≤ 50 locations / 2,500 cells); `POST optimize` (202); `POST matrix/jobs` (202, ≤ 200 × 200); `GET jobs/:id`; `POST jobs/:id/cancel`; `GET usage`; `GET/PUT settings`; `POST settings/apply-role-defaults` | `RoutingV2EnabledGuard` (404 unless `ROUTING_ENGINE_V2=on`) on every endpoint **except `capabilities`**; `route_plans` / `settings` permissions |
| `@Controller('route-plans')` `RoutePlansController` | `GET /`, `POST /`, `GET :id`, `PATCH :id`, `DELETE :id`, `POST :id/optimize` (202), `GET :id/history`, `POST :id/stops`, `PATCH/DELETE :id/stops/:stopId`, `PUT :id/sequence`, `POST :id/recalculate`, `POST :id/assignments`, `PATCH/DELETE :id/assignments/:assignmentId`, `POST :id/publish`, `POST :id/cancel` | `route_plans` view / create / edit / delete |

Main already has `@Controller('routing')` (`POST /routing/estimate-gaps`). The two controllers share a prefix but have no path collision.

### 1.6 Worker process

`apps/api/src/routing-worker/main.ts` + `routing-worker.module.ts` (imports `RoutingV2Module`, so it pulls in `ValhallaAdapter`). Started by `node dist/routing-worker/main.js` (`package.json` script `start:routing-worker`). It exits unless `ROUTING_ENGINE_V2=on`. Jobs: the `RoutingJob` row is the source of truth; a Valkey stream `vt:routing:jobs` (consumer group, `MAXLEN ~10000`) feeds the workers; the sweeper lock is `vt:routing:jobs:sweeper` and presence keys are `vt:routing:worker:*`. Claims are conditional with a lease and heartbeat (`lockedBy` / `lockedUntil`); per-company `Idempotency-Key`; retry with back-off (`notBefore`); per-job timeout; cooperative cancel; graceful SIGTERM (`ROUTING_WORKER_GRACE_MS` 30 s). `ROUTING_WORKER_MODE` embeds the consumer in the API (off by default). No systemd unit exists on the branch. Main's production is now Ubuntu/systemd (`ops/deploy/linux/*.service`).

### 1.7 `services/routing-optimizer` (Python)

| Item | Value (V) |
|---|---|
| Files | `optimizer/{__init__,solver,server,cli,valhalla}.py`, `bench_optimizer.py`, `tests/test_solver.py`, `tests/test_server.py`, `pytest.ini`, `run.sh`, `.gitignore`, `requirements*.txt`, `requirements.lock` |
| Deps | `requirements.txt`: `ortools==9.15.6755` (comment: Python 3.14, the release with cp314 wheels). `requirements-dev.txt`: `pytest==9.2.0` |
| Lockfile | `requirements.lock`, 14 pins, **no hashes**: absl-py 2.5.1, immutabledict 4.3.1, iniconfig 2.3.1, numpy 2.5.4, ortools 9.15.6755, packaging 26.3, pandas 3.1.1, pluggy 1.7.0, protobuf 6.33.6, Pygments 2.21.0, pytest 9.2.0, python-dateutil 4.0.0, typing_extensions 4.16.0, tzdata 2026.6 |
| Solver | `solve(problem)`, a pure function: CVRPTW on a given matrix; start/end depot per vehicle; one capacity dimension; multiple time windows; service time; vehicle shift; `maxDurationS`; drop penalty × priority; pre-check reasons; `provenOptimal` only when proved. Python transit callbacks (`RegisterTransitCallback`), not `RegisterTransitMatrix`. `LIMITS` 500 stops / 50 vehicles / 600 locations / 120 s |
| Server | stdlib HTTP; `OPTIMIZER_TOKEN` ≥ 24 chars (refuses to start otherwise); `OPTIMIZER_ALLOW` CIDR list; `OPTIMIZER_CONCURRENCY` slots, then 429; body ≤ 8 MB; `OPTIMIZER_HOST` / `OPTIMIZER_PORT` (default 127.0.0.1:8090) |
| Tests | `test_solver.py`: 7 functions + 1 parametrised with 5 cases = 12 items; `test_server.py`: 4 → **16 items**. This resolves the `06` §1.3 validation note ("8 + 4 = 12 vs 16 passed"): the note counted functions, not parametrised cases. |
| Engine coupling | `valhalla.py` (`/sources_to_targets`), `cli.py --valhalla`, `bench_optimizer.py` (7 references); the docstring in `solver.py` only |

### 1.8 Ops scripts, flags, other files

- `ops/routing/` (≈ 60 files). Valhalla graph pipeline `00`–`80-*.sh` (prereqs, fetch, build, smoke, publish, rollback, status, health, backup), `lib-serve.sh`, `config.env`, India build attempt/resume scripts, matrix tuning/concurrency/accuracy/bench scripts, `provider-benchmark.sh`, `proxy/` (Valhalla bearer-token nginx proxy), `e2e/` (paid-host benchmark kit, "prepared, not run"), `eta/calibrate.py` + `gtfs_reference.py`, `geocoder/*` (Photon trial, corpora, evaluation), `service-area/build-india-coverage.py`, `optimizer_capacity.py`, `api_probe*.mjs`, `smoke.py`, `bench.py`.
- **API flags/env:** `ROUTING_ENGINE_V2` (master switch, 10 references), `ROUTER_URL`, `ROUTER_TOKEN`, `ROUTER_TIMEOUT_MS` (**shared names with main**), `ROUTING_GRAPH_VERSION`, `ROUTING_GRAPH_BBOX`, `ROUTING_MATRIX_ROW_CHUNK`, `ROUTING_MATRIX_PARALLEL`, `ROUTING_CACHE_TTL_SEC`, `ROUTING_ETA_FACTORS`, `ROUTING_JOB_RETENTION_DAYS` (30), `ROUTING_USAGE_RETENTION_DAYS` (400), `ROUTING_WORKER_CONCURRENCY` (2), `ROUTING_WORKER_GRACE_MS`, `ROUTING_WORKER_MODE`, `OPTIMIZER_URL`, `OPTIMIZER_TOKEN`, `API_HOST`; test-only `ROUTING_LIVE_VALHALLA_URL`, `ROUTING_WORKER_PROCESS_TEST`, `ROUTING_WORKER_TEST_REDIS_URL`. **Only `API_HOST` was added to `.env.example`.**
- **Web flags:** UI flag `routingV2` in `OFF_BY_DEFAULT` (`apps/web/src/lib/flags.ts`); a new `MenuDef.featureFlag?: FeatureFlag` (`'routing_v2'`) with `menuFeatureOn()` in `nav.ts`, also used in `router.tsx`.
- **Other API files:** `config/api-host.ts` (+ spec); `main.ts` binds `API_HOST` (loopback default); `retention.service.ts` (+ `routingRetentionSteps`, `tolerateMissingTable`); `access-rules.spec.ts` (+ `route_plans` expectations); `routing/routing-axis.spec.ts` (new); `routing/routing.service.ts` (comment only: shape is `[lng, lat]`).
- **Web:** `features/route-planner/{RoutePlannerPage (904 lines), PlanEditor (274), planner-utils (+test)}`; `live-share/share-eta.ts` (+test) and `PublicSharePage.tsx` (RR-14); `alerts/MiniMap.tsx` (RR-08).
- **Shared:** `packages/shared/src/routing.ts` (384 lines, contracts); `index.ts` export; `live-share.ts` comment; `permissions.ts` (`route_plans`, `featureFlag`, Manager preset).
- **Deploy:** `docker-compose.yml` (`API_HOST: 0.0.0.0`); four Windows scripts (`deploy-release.ps1`, `deploy-veetrax-domain.ps1`, `update-api-only.ps1`, `update-web-api.ps1`): health checks change from `localhost` to `127.0.0.1`.
- **Docs:** `docs/routing/**` (69 files); root `ROUTING_DECISION_LOG.md`, `ROUTING_PROGRESS.md`, `ROUTING_RISK_REGISTER.md`.

---

## 2. Schema conflicts with v1.8.0

### 2.1 The `RouteStop` clash (V)

| Aspect | Main (v1.8.0) | Branch |
|---|---|---|
| Model / table | `model RouteStop` / `"RouteStop"`, created by `20261113090000_routes_planned_trips` | `model RouteStop` / `"RouteStop"`, created by `20261110110000_routing_engine_v2` |
| Meaning | stop of a master `Route` (`routeId, seq, name, lat, lng, radiusM, offsetMin, waitMin, geofenceId?`) | stop of a day plan (`planId, companyId, assignmentId?, ref, …, timeWindows, etaS, unassignedReason`) |
| Constraint names | `RouteStop_pkey`, `RouteStop_routeId_seq_key`, `RouteStop_routeId_fkey` | `RouteStop_pkey` (**same name**), `RouteStop_planId_ref_key`, `RouteStop_assignmentId_idx`, `RouteStop_planId_fkey`, `RouteStop_assignmentId_fkey` |
| Relation fields | `Route.stops RouteStop[]` | `RoutePlan.stops RouteStop[]`, `RouteAssignment.stops RouteStop[]` |
| Prisma accessor | `prisma.routeStop` (main `planned-trips/routes.service.ts`) | `tx.routeStop` / `prisma.routeStop` |

Consequences: the schemas cannot be combined (duplicate model); the branch `CREATE TABLE "RouteStop"` and `RouteStop_pkey` fail on every v1.8 database; one accessor would have two meanings.

**Branch code that actually uses the accessor (V, `git grep 'routeStop|RouteStop\b'`):**
- `apps/api/src/routing-v2/plans.service.ts`: 8 lines (220, 231, 252, 256, 282, 284, 336, 447)
- `apps/api/src/routing-v2/routing-v2.service.ts`: 3 lines (373, 393, 398)
- `apps/api/src/routing-v2/routing.int.spec.ts`: 6 lines (178, 179, 361 table name, 364, 373, 386)
- `apps/api/src/routing-v2/plan-history.ts:23` reaches the stops through `include: { stops: true }`. The relation name is unchanged, so this needs no edit.

**Correction to `15` §11.2.** `routing-v2.controller.ts`, `PlanEditor.tsx` and `packages/shared/src/routing.ts` reference only the DTO type `RouteStopViolation`, not the model. `routing-v2.dto.ts`, `plan-history.ts` and `access.spec.ts` contain no `RouteStop` token at all. The code rename therefore touches **3 files** plus the schema and the migration. `RouteStopViolation` should still be renamed `RoutePlanStopViolation`, to keep names unambiguous next to main's `RouteStop`.

**Proposed rename (D3 working name):**

| Branch | Port |
|---|---|
| `model RouteStop` / table `"RouteStop"` | `model RoutePlanStop` / `"RoutePlanStop"` |
| `RouteStop_pkey` | `RoutePlanStop_pkey` |
| `RouteStop_planId_ref_key` | `RoutePlanStop_planId_ref_key` |
| `RouteStop_assignmentId_idx` | `RoutePlanStop_assignmentId_idx` |
| `RouteStop_planId_fkey`, `RouteStop_assignmentId_fkey` | `RoutePlanStop_planId_fkey`, `RoutePlanStop_assignmentId_fkey` |
| `prisma.routeStop` (branch code) | `prisma.routePlanStop` |
| relation fields `RoutePlan.stops`, `RouteAssignment.stops` | unchanged |
| shared `RoutePlanStopDto` | unchanged (already unambiguous) |
| shared `RouteStopViolation` | `RoutePlanStopViolation` |

### 2.2 Other name collisions (V, re-checked against f5b151b)

- **Prisma models / enums.** `RoutePlan`, `RouteAssignment`, `RoutingJob`, `RoutingUsage`, `RoutePlanVersion`, `RoutePlanStatus` and `RoutingJobStatus` do not exist on main. Main has `Route`, `RouteStop`, `RouteSchedule`, `PlannedTrip*`, `PlannedTripStatus`, `PlannedStopStatus`, `Trip`, `Stop`. No other clash.
- **Shared package exports.** No exported name in branch `routing.ts` collides with any export in main's `packages/shared/src/*.ts` (`join` of the export lists is empty). `LatLng` is imported from main's `geo.ts`.
- **Relation names on `User` / `Company`.** `RoutePlanCreatedBy`, `RouteAssignee`, `routePlans`, `routingJobs`, `routingUsage` and `routeAssignments` are free on main. The conflict is textual only (both sides appended to the same blocks).
- **Valkey keys.** `vt:route:v2:*`, `vt:routing:*` do not overlap main's `route:eta:*` / `route:est:*`.
- **Menu keys and paths.** `route_plans` at `/route-planner` does not clash with main's `routes` (`/routes`) or `plannedTrips` (`/planned-trips`). Both sides import `RouteIcon` in `nav.ts`, which gives a duplicate import.
- **Env vars.** **`ROUTER_URL` / `ROUTER_TOKEN` / `ROUTER_TIMEOUT_MS` do clash** (§4.1).

### 2.3 Migration ordering

- The branch folders `20261110110000_*` and `20261110120000_*` sort after main's `20261110100000_sim_management` but **before** `20261112090000_stock_sales`, `…100000_messaging_settings`, `…110000_stock_inventory_link`, `…120000_stock_supplier_payments` and `20261113090000_routes_planned_trips`. Prisma would treat them as unapplied, out-of-order migrations on every deployed database, and the first one fails on `"RouteStop"`.
- **Rule (`15` §9.1, R3).** The branch migrations are never applied to any shared database. Any local database that ran them is reset, not migrated. The port regenerates **one** migration with `prisma migrate diff --from-schema-datasource/--from-migrations … --to-schema-datamodel …` against main's schema plus the renamed models. `RoutingJobStatus` is created with `CANCELLED` directly (no `ALTER TYPE … ADD VALUE`, which also cannot run inside a transaction on older PostgreSQL). All index and constraint names are regenerated.
- **Proposed folder names.** E4 runs after E1a–E3, whose migrations (`15` §9.1: `20261114090000_alert_notified_at`, `20261114100000_notification_log_delivery`, `202612xx…_etms_accounts`, `_etms_people`, `_etms_bookings_trips`, `_planned_trip_origin`) will then be main's head. Indicative names: `<head+1>_routing_engine_v2` (the six tables), then `<head+2>_etms_planning_links` (`TransportTrip.routePlanId`, snapped coordinates, `15` §10). Example: if E3 lands as `20261220090000_planned_trip_origin`, use `20261221090000_routing_engine_v2` and `20261221100000_etms_planning_links`. The folders are re-dated at PR merge time if another migration landed first.

### 2.4 FK dependency map

**What its `RouteStop` references (V):** `RoutePlan` (`planId`, Cascade), `RouteAssignment` (`assignmentId`, SetNull). Logical key: `companyId` (no FK).
**What references its `RouteStop` (V):** **nothing**. No FK in the branch points at it.
**What references main's `RouteStop` (V):** nothing. Main's `RouteStop` points only at `Route` (`RouteStop_routeId_fkey`, Cascade); `geofenceId` has no FK. `PlannedTripStop` copies values and has no FK to `RouteStop`.
**Cross-links between the branch tables and main's routing tables:** none (V). No branch FK points into `Route`, `RouteStop`, `RouteSchedule` or `PlannedTrip*`.

```
Company ─Restrict─< RoutePlan ─Cascade─< RouteAssignment ─SetNull─< RoutePlanStop (assignmentId)
   │                    ├─Cascade─< RoutePlanStop (planId)
   │                    ├─Cascade─< RoutePlanVersion
   │                    └─SetNull─< RoutingJob (planId)
   ├─Restrict─< RoutingJob (companyId)
   └─Restrict─< RoutingUsage (companyId)
User ─SetNull─< RoutePlan.createdById ; User ─SetNull─< RouteAssignment.assigneeUserId
logical (no FK): RouteAssignment.companyId / objectId / driverId ; RoutePlanStop.companyId ;
                 RoutePlanVersion.companyId / changedById ; RoutingJob.userId ; RoutePlan.branchId
future (E4, etms_planning_links): TransportTrip.routePlanId ─SetNull→ RoutePlan
main (unchanged): Route ─Cascade─< RouteStop ; Route ─Cascade─< RouteSchedule ; PlannedTrip ─Cascade─< PlannedTripStop / PlannedTripEvent
```

### 2.5 Purge, retention and convention findings (V against `15` §1)

| # | Finding | Proposed port change |
|---|---|---|
| S-1 | `RoutePlan.createdById` has an FK to `User` (SetNull). `15` §1.1 says actor columns have **no FK** (`PlannedTrip`, `Route` pattern). | Drop the FK and the `RoutePlanCreatedBy` relation; keep the plain column. |
| S-2 | `RouteAssignment.objectId` without FK is the purge planner's `TrackedObject` logical key, so a **vehicle purge deletes plan assignments** (their stops go to `assignmentId NULL`). | Decide in R2 (§2.6 Q-c). Recommended: keep historic plans readable → add FK `objectId → TrackedObject` **SetNull** (an FK disables the logical-key walk) and FK `driverId → Driver` SetNull. |
| S-3 | `RouteAssignment.assigneeUserId` duplicates D5's `Driver.userId` (driver login = `Driver.userId`). | Drop `assigneeUserId` and its index; resolve "driver sees own routes" through `driverId → Driver.userId`. `access.service.ts` changes with it. |
| S-4 | `RoutePlanStatus.COMPLETED` is an execution state; under D2 execution lives on `PlannedTrip` / `TransportTrip` milestones. | Drop `COMPLETED` (plan states: `DRAFT, OPTIMIZING, PLANNED, PUBLISHED, CANCELLED`); "completed" is derived from the trips. |
| S-5 | `RoutingJob.planId` (SetNull FK) has no index → plan delete scans `RoutingJob`. | Add `@@index([planId])`. |
| S-6 | `RoutePlanStop` carries passenger pickup coordinates (customer personal data, `15` §1.6) under an operator `companyId`. | D1 decision (§2.6 Q-a): add `customerCompanyId` (FK Company, Cascade per `15` §1.2 naming rule) and `bookingId?` (FK `TransportBooking` SetNull), or keep stops passenger-free (link via booking only). |
| S-7 | Retention: the branch deletes `RoutePlan` older than the company retention by `planDate`, finished jobs after 30 d, usage after 400 d; `tolerateMissingTable` hides a missing table. | Port. Align the plan retention with L3 (`15` Q1), and drop `tolerateMissingTable` once the migration ships with the code (a missing table should then be an error). |
| S-8 | Reachability: all six tables are reached by a company purge (FK `companyId` or the `companyId` logical key via a plan). | Keep; add the six tables to the `15` §9.6 reachability lint. |

### 2.6 Interaction with the E3 tables (`15` §5) and `PlannedTrip`

- **`TransportTrip`** (E3) has no `routePlanId` yet; `15` §5.5 / §10 add `routePlanId` FK **SetNull** → `RoutePlan` in E4 (`etms_planning_links`). A plan purge then leaves executed trip headers intact. Recommended addition for traceability: `TransportTrip.routeAssignmentId` FK SetNull (one assignment → one trip), unique per `(routeAssignmentId)` to make re-publish idempotent (`06` §5 "idempotent publish").
- **`PlannedTrip`** (`origin = 'ETMS'`, nullable `routeId`, `15` §7.1): a plan publish creates, per `RouteAssignment`, one `PlannedTrip` + `PlannedTripStop` rows (from `RoutePlanStop.sequence/etaS`) + one `TransportTrip`, in the `15` §8.4 publish transaction. **No FK** from `PlannedTrip` to any plan table (keeps v1.8 untouched; the link lives on `TransportTrip`).
- **`TransportTripPassenger`** (E3) keys passengers to `PlannedTripStop` by `(tripId, seq)`; plan stops map onto it at publish. If S-6 keeps `bookingId` on `RoutePlanStop`, publish copies it to the passenger row.
- **`TransportChangeSet`** (E3 idempotency ledger) vs `RoutingJob.idempotencyKey`: different purposes (publish vs. optimise); both stay, no shared table.
- **`RouteAssignment` must not become a second execution record (D2)**: after publish it is read-only proposal history; edits go through the E3 trip-change path. The branch's `publish` (status flip only) is replaced.

Open ownership questions for R2 (schema owner + routing agent; Q-c needs the owner):

| # | Question | Recommended default |
|---|---|---|
| Q-a | Passenger data on plan stops (D1) | `customerCompanyId` + `bookingId?` on `RoutePlanStop`; plan itself operator-owned (`companyId` = operator) |
| Q-b | Driver identity on assignments (D5) | `driverId` FK `Driver`; drop `assigneeUserId` |
| Q-c | Vehicle purge vs plan history | FK SetNull on `objectId` / `driverId` (history kept) |
| Q-d | Menu key: `route_plans` vs `etms_*` keys (`02` §3.1, `15` §7.4) | Rename to the ETMS planning key chosen in `15` §7.4 (e.g. `etms_planning`); drop the branch's Manager preset in `SYSTEM_ROLES` (ETMS uses per-company templates, `15` Q4) |

---

## 3. Code conflicts

`git merge-tree --write-tree origin/main feature/routing-engine` (V): **content conflicts in 5 files**: `apps/api/prisma/schema.prisma`, `apps/web/src/features/shell/nav.ts`, `ops/deploy/windows/deploy-release.ps1`, `packages/shared/src/index.ts`, `packages/shared/src/permissions.ts`. Six more files are modified on both sides and auto-merge textually: `.gitattributes`, `apps/api/.env.example`, `apps/api/package.json`, `apps/api/src/app.module.ts`, `apps/api/src/routing/routing.service.ts`, `apps/web/src/app/router.tsx`. Since nothing is merged, each is re-applied by hand on the port branch.

| File | Main since 07077b6 | Branch | Conflict | Porting strategy |
|---|---|---|---|---|
| `apps/api/prisma/schema.prisma` | routes/planned trips (incl. `RouteStop`), stock, SIM, messaging models; relations on `Company`/`User` | 6 models, 2 enums, relations on `Company`/`User` | **Textual + semantic** (duplicate `RouteStop`) | Write the models fresh on main with §2.1 rename and §2.5 changes; regenerate migration (§2.3) |
| `packages/shared/src/permissions.ts` | `MenuGroup` + `stock`; `MenuDef.partnerOnly`; keys `plannedTrips`, `routes`, `stock`, `sa_sim_cards`; `PERSONAL_HIDDEN_MENUS` += routes/plannedTrips; role presets | `MenuDef.featureFlag`, `FeatureFlag = 'routing_v2'`, key `route_plans`, Manager preset | Textual (same blocks) + design | Add `featureFlag` beside `partnerOnly` only if ETMS menus need build flags (ETMS uses company feature `etms`; likely reuse that instead); menu key per Q-d; no `SYSTEM_ROLES` change |
| `apps/web/src/features/shell/nav.ts` | `buildNav(perms, personal, reseller)` + `partnerOnly` filter; icons `PackageIcon`, `RouteIcon`, `CardSimIcon` | `menuFeatureOn()`, `FEATURE_UI_FLAG`, `RouteIcon` import, filter in `buildNav` | Textual; duplicate `RouteIcon` import | Re-apply `menuFeatureOn` into main's `buildNav` filter (if kept); one icon import |
| `apps/web/src/app/router.tsx` | pages `sa_sim_cards`, `stock`, `routes`, `plannedTrips`; detail route `/planned-trips/:id` | page `route_plans`; `MENUS.filter(menuFeatureOn)` | Auto-merges; semantic only (`PAGES: Record<MenuKey,…>` must include every key) | Add the planner page under the final key; keep the feature filter with the nav change |
| `packages/shared/src/index.ts` | + `stock`, `sim`, `report-insights`, `messaging`, `planned-trips` | + `routing` | Textual (adjacent lines) | Append `export * from './routing'` |
| `apps/api/src/app.module.ts` | + `StockModule`, `PlannedTripsModule`, `SimsModule`; `HealthController` moved out | + `RoutingV2Module` | Auto-merges | Register the new module (renamed, e.g. `RoutePlanningModule`) after `RoutingModule` |
| `apps/api/src/routing/routing.service.ts` | + `routeVia` / `viaGraphHopper` / leg fill (+60 lines) | comment only (shape `[lng, lat]`) | Auto-merges | Comment comes with the G1 RR-14 fix; in E4 this class becomes the wrapper over `GraphHopperProvider` (`06` §3) and `ROUTER_ENGINE` default `valhalla` → GraphHopper only |
| `apps/api/.env.example` | + `TRACKER_SERVER_URL` comment | + `API_HOST` comment | Auto-merges | Port with the `API_HOST` PR; E4 adds the routing / optimiser vars (new names, §4.1) — the branch never documented them |
| `apps/api/package.json` | + `sim:route` | + `start:routing-worker` | Auto-merges | Add the worker script in WP 4.2 |
| `.gitattributes` | + `ops/valkey/** eol=lf` | + `ops/routing/config.env`, `ops/routing/*.py`, `services/routing-optimizer/**` eol=lf | Auto-merges | Keep only `services/routing-optimizer/** text eol=lf` (ops/routing is dropped) |
| `ops/deploy/windows/deploy-release.ps1` | maintenance flag, readiness semantics, `/api/health/tracking` | `localhost` → `127.0.0.1` in the health loop | **Textual** (same line) | Production is Ubuntu (`ops/deploy/linux`); only needed if the Windows scripts are still maintained when `API_HOST` lands — then re-apply the one-word change on main's new line |
| Branch-only, unchanged on main: `main.ts`, `retention.service.ts`, `access-rules.spec.ts`, `flags.ts` (+test), `live-share.ts`, `PublicSharePage.tsx`, `MiniMap.tsx`, `docker-compose.yml`, three other Windows scripts | — | see §1.8 | none textual | `main.ts`/`docker-compose`/Windows: with `API_HOST`. `retention`: with WP 4.0. `access-rules.spec`: only if a system preset is kept (Q-d says no). `flags.ts`: `OFF_BY_DEFAULT` pattern if a UI flag is used. RR-14 files: G1, not E4. `MiniMap.tsx`: one-line, port any time |

---

## 4. Engine coupling (Valhalla) and the GraphHopper rewrite

### 4.1 Every Valhalla dependency (V)

| # | Where | Dependency | GraphHopper action |
|---|---|---|---|
| E-1 | `routing-v2/valhalla.adapter.ts` (227 lines) | `POST /route` (Valhalla JSON, `costing`, maneuvers), `POST /sources_to_targets` (matrix), `POST /locate` (on-road check), `GET /status` (`tileset_last_modified` → graph version), Valhalla error codes (170–172, 442–443 no route; 150–158 limits), circuit breaker, bearer token | **Drop the adapter.** Write `GraphHopperProvider` (`06` §3): `/route` (`points_encoded=false` or 1e5 decode), legs via main's `routeVia`, `/nearest` replaces `/locate`, `/info` (`data_date` / build) replaces `/status`, `/match` already in main. Keep the circuit-breaker and `private-url` patterns |
| E-2 | `routing-v2/routing-v2.service.ts` (19 refs) | `chunkedMatrix` (row chunks `ROUTING_MATRIX_ROW_CHUNK`=25 × `ROUTING_MATRIX_PARALLEL`=2), `isolatedMatrix` + `findDisconnected` (Valhalla refuses the whole matrix if one point is disconnected), `validPoints` via `/locate`, `routeThrough` / `sequenceGeometry` chunked to Valhalla's per-request location limit, `capabilities.engine='valhalla'` | **Rewrite** the matrix as M1 (`06` §2.2): N×M `/route` with `calc_points=false&instructions=false`, ≤ 4 in flight with back-pressure on GH p95, sparse k-nearest + depot legs, cache per `(graphVersion, profile, a, b)`. GH fails per pair, so a failed cell is simply `null` (no isolation pass needed). Keep: graph-versioned route cache key, coverage check, usage metering calls, `buildProblem` → `OptimizerProblem` mapping, `saveToPlan` (renamed models) |
| E-3 | Env names `ROUTER_URL`, `ROUTER_TOKEN`, `ROUTER_TIMEOUT_MS` | **Collide with main's `RoutingService`**; production `ROUTER_URL` = GraphHopper 127.0.0.1:8989 (`ops/deploy/linux/maps/README.md`) | One engine config for both (`ROUTER_URL` + `ROUTER_ENGINE=graphhopper`), read by the provider; no second URL. `ROUTER_TOKEN` dropped (GH on loopback has no auth; keep the private-URL refusal) |
| E-4 | `packages/shared/src/routing.ts` | `ROUTING_COSTINGS = ['auto','truck','motorcycle','bicycle','pedestrian']` (Valhalla costings); `engine: 'valhalla'` and `'valhalla' \| null` literal types; `RoutePlan.costing` default `'auto'` | Replace with `RoutingProfile = 'car' \| 'van' \| 'bus' \| 'foot'` (`06` §3), only `car` available until O3 / B8; rename DB column `costing` → `profile` default `'car'`; `engine: 'graphhopper' \| null` |
| E-5 | `routing-v2/polyline.ts` | Decoder at precision 6 (Valhalla); `RouteAssignment.geometry` stored as polyline6 | Store GeoJSON `[lng,lat]` like main's `Route.path`/`PlannedTrip.path` (JSON) or polyline at GH precision 1e5; recommended JSON for consistency with the publish target |
| E-6 | `routing-v2/eta.ts` | `DEFAULT_ETA_FACTORS = { short_lt10km: 1.6 }` fitted against **Valhalla** free-flow (Chennai GTFS) | Keep band/time machinery and labels; **default factors empty** (everything `calibrated:false`) until B9 fits GH factors; map `EtaModel.kind` to `06` §3 `source` values |
| E-7 | `ROUTING_GRAPH_VERSION` written by `ops/routing/40-publish.sh` | Graph version from the Valhalla pipeline | Derive from GH `/info` (OSM data date + GH version, e.g. `gh-11.1/india-2026-11-10`); main's maps runbook owns re-imports |
| E-8 | Tests: `routing-v2.spec.ts` (16 Valhalla refs, 1 live test via `ROUTING_LIVE_VALHALLA_URL`), `worker-process.int.spec.ts` (5 refs, fake Valhalla) | Fixtures in Valhalla JSON | Rewrite fixtures for GH JSON; live test against staging GH nightly (WP 4.4) |
| E-9 | `services/routing-optimizer/optimizer/valhalla.py`, `cli.py --valhalla`, `bench_optimizer.py` | Matrix fetch from Valhalla | Drop `valhalla.py` and the flag (CLI keeps "matrix in file"); bench feeds synthetic / GH-built matrices |
| E-10 | `ops/routing/*` (graph build/publish/rollback, matrix tune/concurrency/accuracy, proxy, e2e kit, India build) | Valhalla operations | Drop; benchmark ideas reused for B1–B3 against GH |
| E-11 | `optimizer.adapter.ts` imports `FetchLike` from `valhalla.adapter.ts` | type only | Move `FetchLike` to a neutral module |

### 4.2 Is the optimiser engine-agnostic?

**Yes (V).** `solver.validate()` requires `matrix.durationsS` (n × n, n ≤ 600) and optional `matrix.distancesM`, non-negative numbers or `null` (`null` → `UNREACHABLE` = forbidden arc via the time dimension). Stops and vehicles reference `locationIndex`. Nothing in `solver.py` or `server.py` calls an engine; only `valhalla.py` / `cli.py` do. With a sparse M1 matrix, cells not computed must be filled by the API before calling the solver: either a bounded estimate (haversine × detour factor, flagged as estimate and **never shown to users as an ETA**) or `null` (forbidden). Recommended: `null` for k-nearest misses plus guaranteed depot legs, and measure quality loss in B3. The solver's limits (600 locations, 8 MB body) fit `06` §7 zone sizes.

---

## 5. Salvage decision per component

### 5.1 Decision table

Effort = person-days for the port only (code + tests on the port branch), not the new ETMS features.

| Component | Decision | Reason | Effort (d) |
|---|---|---|---|
| `optimizer/solver.py`, `server.py`, `__init__.py`, tests, `pytest.ini`, `requirements*.txt`, `requirements.lock` | **Port as is** (drop `valhalla.py`, `--valhalla`; add hashes to the lock; CI job) | Engine-agnostic, secure-by-default, 16/16 pass | 1–2 |
| `run.sh`, `bench_optimizer.py` | Port with changes | `run.sh` targets WSL `~/.venvs`; production needs a systemd unit (`CPUQuota=150%`, `MemoryMax=3G`, `06` §7); bench without Valhalla | 1 |
| Solver extensions (max ride time, allowed vehicles, 2nd capacity, fixed cost, `RegisterTransitMatrix`) | New work (WP 4.3) | Not on the branch | (8–12, not counted) |
| Schema: 6 models, 2 enums | **Port with changes** | Rename `RouteStop`→`RoutePlanStop`; S-1…S-6; `costing`→`profile`; regenerated, re-dated single migration | 3–4 |
| `RoutingJob` + `jobs.service.ts` + `routing-worker/*` | **Port with changes** | Proven lease/idempotency/cancel design with real-process tests; decouple worker module from the engine adapter; systemd unit; flag rename | 3–5 |
| `RoutingUsage` + `usage.service.ts` | Port as is | Small, engine-neutral (rename `costing` usage fields if any) | 0.5 |
| `routing-v2.service.ts` engine part (route, matrix, isolation, chunking, capabilities) | **Rewrite** | Valhalla-specific (§4.1 E-2); becomes `RoutingProvider` + `GraphHopperProvider` + M1 matrix + cache | 8–12 |
| `routing-v2.service.ts` non-engine part (`buildProblem`, `startOptimize`, `saveToPlan`, cache key) | Port with changes | Reusable mapping; renamed models | 2–3 |
| `valhalla.adapter.ts`, `polyline.ts` (precision 6) | **Drop** | D3; GH equivalents exist in main (`route-estimate.ts`, `route-via.ts`) | 0 |
| `optimizer.adapter.ts`, `private-url.ts`, `routing-v2.errors.ts` | Port as is (move `FetchLike`) | Engine-neutral hardening | 0.5–1 |
| `eta.ts` | Port with changes | Keep band machinery + labels; empty default factors (E-6) | 1 |
| `service-area/coverage.ts` + `india-coverage.ts` | Port as is | Cheap input validation | 0.5 |
| `access.service.ts` (+ spec) | Port with changes | Menu key (Q-d), D5 driver identity via `Driver.userId`, D1 operator/customer scope; keep audited Super Admin support mode; the "apply role defaults" endpoint writes `RolePermission` rows — re-decide under `15` §7.4 | 3–4 |
| `plans.service.ts`, `plan-history.ts`, `routing-v2.controller.ts`, `routing-v2.dto.ts` | Port with changes | Renamed model; `publish` rewired to `PlannedTrip` + `TransportTrip` (the rewiring itself is main-phase work); drop `COMPLETED`; guard `capabilities` too | 5–7 |
| `routing.int.spec.ts` | Port with changes | Renamed table/accessor, `_test` DB guard, new publish expectations | 1–2 |
| `packages/shared/src/routing.ts` | Port with changes | Profiles, engine literal, `EtaModel` per `06` §3, `RoutePlanStopViolation`, limits kept | 2 |
| Retention steps | Port with changes (S-7) | L3 alignment | 0.5 |
| Web `RoutePlannerPage.tsx`, `PlanEditor.tsx` | **Rewrite** (salvage pieces: per-vehicle colouring, job progress/cancel, history, violation labels) | Built for generic stops; ETMS dispatcher UX (`07`) is passenger-centric | 6–9 |
| Web `planner-utils.ts` (+test) | Port with changes | Pure helpers, adapt to DTO changes | 1 |
| `flags.ts` `OFF_BY_DEFAULT`, `MenuDef.featureFlag`, `menuFeatureOn` | Port with changes (or drop in favour of company feature `etms`) | Mechanism useful, flag name changes | 0.5–1 |
| `config/api-host.ts` + `main.ts` + `docker-compose.yml` (+ Windows health checks) | **Port as is**, separate small PR (`12` §7 step 2a) | Independent hardening; check Caddy/systemd proxy to 127.0.0.1 on the Ubuntu server first | 1 |
| RR-14 `share-eta.ts` (+test), `PublicSharePage.tsx` | Port as is — **under G1, not E4** (`12` §7) | Live production bug still present on main (`PublicSharePage.tsx:139`) | (0.5, G1) |
| RR-08 `MiniMap.tsx` attribution | Port as is (any small PR) | One line; OSM licence | 0.1 |
| `ops/routing/eta/calibrate.py`, `gtfs_reference.py` | Port with changes (for B9) | Method reusable; fit against GH | 1–2 |
| `ops/routing/geocoder/*` corpora + eval | Keep as **test data** only | Pickup-address QA with Photon | 0.5 |
| `ops/routing/optimizer_capacity.py`, `matrix_accuracy.py` idea | Rewrite for B3/B4 | Valhalla inputs | 2–3 |
| `ops/routing` Valhalla pipeline, `proxy/`, `e2e/`, India build, provider benchmark, matrix tune | **Drop** | D3; hosting premise superseded | 0 |
| `docs/routing/**`, `ROUTING_*.md` | Do not port; keep in the custody bundle as reference | Stale premises (4 GB host, Valhalla) | 0 |
| `routing/routing-axis.spec.ts` | Port as is (check against main's `route-via` specs) | Axis-order regression guard | 0.2 |

### 5.2 Effort total

| Bucket | Person-days |
|---|---|
| Port as is (optimiser core, usage, coverage, adapters/errors, API_HOST, MiniMap, axis spec) | 4–6 |
| Port with changes (schema/migration, jobs/worker, non-engine service, ETA, access, plans/API, int spec, shared contracts, retention, planner-utils, flags, run/bench, calibration scripts, geocoder data) | 24–34 |
| Rewrite (engine/matrix layer, web planner, benchmark scripts) | 16–24 |
| **Total port** | **≈ 44–64** (~9–13 person-weeks for one agent; less elapsed time in parallel per the `12` §7 WP split) |

Not included: WP 4.3 solver extensions (8–12 d), WP 4.4 corpus, publish into `PlannedTrip`/`TransportTrip` (main phase), benchmarks B1–B6/B9 on staging, GH profile re-import (E4b).

---

## 6. Test status

| Suite | Branch claim | Re-run here | Result / note |
|---|---|---|---|
| Optimiser `pytest` (`tests/test_solver.py`, `tests/test_server.py`) | "pytest 16 passed" (ROUTING_PROGRESS phase 4) | **Yes.** Sources copied with `git show` into the session scratchpad (`…/scratchpad/optimizer-src/services/routing-optimizer`); run in WSL Ubuntu with the **pre-existing** venv `/root/.venvs/routing-optimizer` (Python 3.14.4). `pip freeze` of that venv is **identical to `requirements.lock`** (verified by diff). Nothing was installed (no global software, no pip install). | **16 passed in 12.66 s** (2026-11-11). Windows has no Python (only the Store alias). |
| API Jest `routing-v2.spec.ts` | 33 (doc) | No | 36 `it/test` lines; 1 live Valhalla test (skipped without `ROUTING_LIVE_VALHALLA_URL`) |
| `access.spec.ts` | 21 (doc) | No | 11 `it/test` lines (some may be `.each`) |
| `routing.int.spec.ts` (real PostgreSQL) | 13 | No | 13 lines; needs a `_test` DB with the branch migrations |
| `worker-lifecycle.spec.ts` / `worker-process.int.spec.ts` | 4 / real-process | No | 4 / 1 (`describe` with SIGKILL recovery, 5 workers → 1 execution; needs Valkey) |
| `api-host.spec.ts`, `routing-axis.spec.ts` | — | No | 4 / 1 |
| Web Vitest `planner-utils.test.ts`, `share-eta.test.ts`, flags tests | 9 / — | No | 10 / 2 |

**Why the TypeScript suites were not run.** Running them needs the branch tree with its `node_modules` and a database. That means a checkout or a clone, which the brief forbids. `15` §11.3 R7 assigns this to a **disposable clone made from the custody bundle** in an off-repo directory, after O7 approval.

**Can they run on main after porting?**
- The optimiser `pytest` runs unchanged, minus the CLI round-trip if `--valhalla` handling changes; that test does not use the flag. CI needs a Python 3.14 job with the locked wheels (`ortools` cp314; check wheel availability for the CI image).
- `routing-v2.spec.ts`: the engine cases (≈ 16 Valhalla references) are rewritten for GH; the cache-key, coverage, ETA and limit cases port with renames.
- `routing.int.spec.ts`: ports with `routePlanStop` and new publish assertions; it must run against `20261113090000` plus the E1a–E3 and E4 migrations.
- The worker tests port as is once the module no longer imports the Valhalla adapter (fake engine → fake provider).
- `access.spec.ts` changes with Q-d / D5. `planner-utils`, `share-eta`, `api-host` and `routing-axis` port as is or nearly so.

---

## 7. Porting plan for E4 (fresh branch from main)

Preconditions: E3 merged (TransportTrip, publish transaction, `planned_trip_origin`); this report reviewed by the owner; O7 custody done; R2 answers (§2.6). The old branches stay untouched throughout.

| Step | Work | Merge gate |
|---|---|---|
| P0 | **Custody** (§8) + Lead runs `git -C <each routing worktree> status --short`; re-record tips 19150e8 / 948cb44 | bundle verified, SHA-256 recorded |
| P1 | Disposable clone from the bundle (off-repo): run branch Jest/int/pytest suites, record counts (`15` R7) | evidence filed; no code moves from the clone except by copy into PRs below |
| P2 | Branch `etms/e4-routing` from current `origin/main`. Small independent PR: `API_HOST` (+ docker-compose, Windows health checks if still used), MiniMap attribution | api + web CI green; production proxy confirmed to target 127.0.0.1; ops review |
| P3 | WP 4.3a: optimiser service as is (no `valhalla.py`), hashed lock, CI pytest job, systemd unit template with caps | 16/16 in CI; no engine import in `services/routing-optimizer` |
| P4 | WP 4.0 contracts: `packages/shared/src/routing.ts` rewritten (profiles, `EtaModel`, `RoutePlanStopViolation`) | shared + web typecheck |
| P5 | WP 4.1a: `RoutingProvider` + `GraphHopperProvider` wrapping `RoutingService` with **unchanged behaviour**; `ROUTER_ENGINE` GraphHopper only; single `ROUTER_URL` | existing `route-estimate`, `route-via`, live-share, tracker specs green; no change in v1.8 behaviour |
| P6 | WP 4.0 migration `<head+1>_routing_engine_v2` (renamed `RoutePlanStop`, §2.5 changes) + `<head+2>_etms_planning_links` | **merge-gated**: fresh-DB `migrate deploy`, drift check (`15` §9.5), planner/reachability tests for the 6 tables, owner review of R2 |
| P7 | WP 4.1b: M1 matrix builder + graph-versioned cache + degraded results | B1–B3 targets on staging (C3) |
| P8 | WP 4.2: jobs/worker/usage port; retention steps; systemd `veetrax-routing-worker.service` + optimiser unit with caps | worker-lifecycle + real-process spec green; chaos R4 (worker kill) and R5 (engine down) pass |
| P9 | Plans service/API/access port (renamed), `publish` → `PlannedTrip` + `TransportTrip` (`15` §8.4) | int spec green; R1 manual-dispatch E2E passes **with the optimiser stopped** |
| P10 | WP 4.5 web planner (salvaged pieces) behind ETMS flags | Playwright scenario compare; 0 ETAs with a live source when engine down |
| Exit | `12` §7 exit criteria (30/30 corpus, R4/R5, benchmarks B1–B6 before any production request) | owner |

Flags: keep everything off by default. Recommended: reuse the ETMS switches (`ETMS` env, company feature `etms`, web ETMS flag) plus a dedicated `ETMS_ROUTING=on` for the planner/worker, instead of `ROUTING_ENGINE_V2` / `routingV2` (Lead to confirm).

**Risks**
- R-1 single copy of the branch until P0 (disk loss, `branch -D`, re-clone).
- R-2 accidental merge/push: `feature/routing-engine` tracks `origin/main`; `push.default` unset protects only plain `git push`.
- R-3 env collision (`ROUTER_URL`) reintroduced if any branch module is copied wholesale.
- R-4 a branch migration applied to a shared DB (would fail on `RouteStop`, or leave unapplied out-of-order entries).
- R-5 GH M1 matrix too slow/CPU-heavy on the shared production host (B2/B6).
- R-6 uncalibrated ETAs shown as commitments (keep `calibrated:false` defaults; drop 1.60).
- R-7 plan tables becoming a second execution record (D2) if publish is not rewired.
- R-8 test drift: branch suites quoted, not re-run (only pytest re-run so far).
- R-9 Python 3.14 / ortools cp314 wheel availability in CI and on the Ubuntu server.

---

## 8. Custody (recommendation only; not performed)

The branches exist **only in `D:\Vibhav\gps-app\.git`** (no remote contains them). Recommended owner-approved step, as in `15` §11.6:

```powershell
# 1. Bundle both branches to a location OUTSIDE the repository (ideally a second physical disk)
git -C D:\Vibhav\gps-app bundle create E:\veetrax-custody\routing-engine-2026-11-11.bundle feature/routing-engine feature/routing-r0
# 2. Verify and record evidence (paths and hashes only; never commit the bundle)
git bundle verify E:\veetrax-custody\routing-engine-2026-11-11.bundle
Get-FileHash E:\veetrax-custody\routing-engine-2026-11-11.bundle -Algorithm SHA256
#    expected tips: feature/routing-engine 19150e8, feature/routing-r0 948cb44
# 3. Optional: encrypt with the owner-held key (O8) and scan for secrets (optimiser tokens are generated outside the
#    repo by run.sh, but check) before any off-site copy; no upload without owner approval.
# 4. Optional owner action: remove the origin/main tracking
git -C D:\Vibhav\gps-app branch --unset-upstream feature/routing-engine
```

`E:\veetrax-custody\` is a placeholder for the owner's chosen medium. Uncommitted changes in the two agent worktrees (if any) are **not** in a bundle; the Lead checks them first (P0).

---

*Prepared by the Routing and Optimisation agent, 2026-11-11. Read-only review; the Lead commits this document.*
