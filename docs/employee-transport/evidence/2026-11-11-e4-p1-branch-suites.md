# E4 P1 evidence (2026-11-11): the old routing branches' own test suites

Doc 17 §7 step **P1** (`15` §11.3 R7): run the Jest, integration and pytest suites of `feature/routing-engine` and
`feature/routing-r0` in a disposable clone made from the custody bundle, and record the counts. Agent E4-D.
Nothing from the clone was committed; code reaches E4 only by copy into the `etms/e4-salvage` commits.

## 1. Sources and custody

| Item | Value |
|---|---|
| Bundle | `D:\Vibhav\routing-branch-bundle\routing-branches-20261111.bundle` |
| Bundle SHA-256 | `4300de86e02d80cd3d4ad57ee3b22e2ecf8778bc3d3efbfbb6de5e546d5f87dd` (re-computed before cloning: match) |
| `feature/routing-engine` | `19150e8ebbaf25ac9c89d9b31ba45adba3abd352` |
| `feature/routing-r0` | `948cb447da80568d6bb9389241ab4d9eb3aadbdb` (12 docs-only commits on top of `e86a9da`) |
| Clone | `git clone <bundle> D:\Vibhav\routing-p1-clone` (outside the repo), local branches made from `origin/feature/*` in the clone only. **Deleted after the run.** |
| Old branches / worktrees | Read only. After the run: both refs unchanged (19150e8 / 948cb44), both worktrees clean (`git status --short` empty) |
| Tooling | Node 22.23.4, npm 10.9.9 (`npm ci` in the clone, no global installs); Python 3.14.4 in the pre-existing WSL venv `/root/.venvs/routing-optimizer` (nothing installed) |
| Databases | Scratch only: `veetrax_e4d_engine_test`, `veetrax_e4d_r0_test` (PostgreSQL 18 in WSL; plus `veetrax_e4d_usage_test` for the salvage DB test in §5), created empty, migrated with **each branch's own migrations**, seeded with the branch seed (scratch Super Admin password), **dropped afterwards**. No shared database (`veetracer`, `veetrax_assess`, …) was touched. |
| Valkey | Not used by any suite that ran. The branch seed was given `REDIS_URL=…/14`; db 0 untouched. PM2 untouched. |

## 2. Results

### 2.1 `feature/routing-engine` @ 19150e8

| Suite | Command (in the clone) | Result |
|---|---|---|
| API Jest, default (no DB env) | `npx jest --ci` | **1,043 passed, 31 skipped, 0 failed** (1,074 tests; 115 suites passed, 4 skipped) |
| API Jest, with the scratch DB | `PURGE_TEST_DATABASE_URL=<veetrax_e4d_engine_test> npx jest --ci --runInBand` | **1,061 passed, 13 skipped, 0 failed** (117 suites passed, 2 skipped) |
| Inventory integration (needs a seeded DB) | `INVENTORY_IT_DATABASE_URL=<same> npx jest inventory.integration` after `npm run db:seed` | **11 / 11 passed** |
| Routing integration on PostgreSQL | `routing-v2/routing.int.spec.ts` (branch migrations `20261110110000_*`, `20261110120000_*` applied to the scratch DB) | **13 / 13 passed** |
| Web (node --test) | `npm test -w @veetracer/web` | **128 / 128 passed** |
| Optimiser pytest | `python -m pytest -rA` in `services/routing-optimizer` (WSL venv) | **16 passed in 11.93 s** (`test_server.py` 4, `test_solver.py` 12 incl. 5 parametrised) |

**All runnable tests pass: 1,072 of 1,074 API tests (1,061 + the 11 inventory tests), 128 web, 16 pytest.**
The two API tests that cannot run need Valhalla, which is out of scope (README §5 D3):

| Not run | Guard | Why |
|---|---|---|
| `routing-v2.spec.ts` › live Valhalla (1) | `ROUTING_LIVE_VALHALLA_URL` | needs a Valhalla server |
| `routing-worker/worker-process.int.spec.ts` (1, real processes, SIGKILL recovery) | `ROUTING_WORKER_PROCESS_TEST=1` + `_test` DB + `ROUTING_LIVE_VALHALLA_URL` + built `dist/routing-worker/main.js` | needs a Valhalla server; must be re-targeted to a fake / GraphHopper engine when the worker is ported (P8) |

Routing-related suites (with the scratch DB):

| Spec | Passed | Skipped | Doc 17 §6 said |
|---|---|---|---|
| `routing-v2/routing-v2.spec.ts` | 35 | 1 (live Valhalla) | 33 (doc) / 36 `it` lines |
| `routing-v2/access.spec.ts` | 22 | 0 | 21 (doc) / 11 `it` lines (`.each`) |
| `routing-v2/routing.int.spec.ts` | 13 | 0 | 13, not run |
| `routing-worker/worker-lifecycle.spec.ts` | 4 | 0 | 4 |
| `routing-worker/worker-process.int.spec.ts` | 0 | 1 | 1, needs Valkey (and, in fact, Valhalla) |
| `config/api-host.spec.ts` | 4 | 0 | 4 |
| `routing/routing-axis.spec.ts` | 1 | 0 | 1 |
| `access/access-rules.spec.ts` | 9 | 0 | — |
| `retention/retention.spec.ts` | 1 | 0 | — |
| `purge/purge-financial.int.spec.ts` | 5 | 0 | — |

### 2.2 `feature/routing-r0` @ 948cb44

`feature/routing-r0` is the R0 discovery work: 12 docs-only commits (`docs/routing/**`, `ROUTING_*.md`) on top of
`e86a9da`. It has no routing code, no optimiser (`services/` does not exist there) and no routing migrations, so its
suites are those of the application at `e86a9da`.

| Suite | Command (in the clone) | Result |
|---|---|---|
| API Jest, default | `npx jest --ci --forceExit` | **870 / 870 passed**, 0 skipped (101 suites) |
| API Jest, with a scratch DB | `PURGE_TEST_DATABASE_URL=… INVENTORY_IT_DATABASE_URL=<veetrax_e4d_r0_test>` (50 branch migrations applied, branch seed run) `npx jest --ci --runInBand --forceExit` | **870 / 870 passed** (no DB-guarded suite exists at this commit) |
| Web (node --test) | `npm test -w @veetracer/web` | **95 / 95 passed** |
| Optimiser pytest | — | not applicable (no `services/routing-optimizer` on this branch) |

### 2.3 Summary

| Branch | API Jest | Integration (PostgreSQL) | Web | pytest | Not runnable |
|---|---|---|---|---|---|
| `feature/routing-engine` 19150e8 | 1,061 passed + 11 inventory = 1,072 / 1,074 | 13 / 13 routing, 5 / 5 purge-financial, 11 / 11 inventory | 128 / 128 | 16 / 16 | 2 (live Valhalla, D3) |
| `feature/routing-r0` 948cb44 | 870 / 870 | none at this commit | 95 / 95 | n/a | 0 |

No test failed on either branch.

## 3. Failures and incidents during the run (none are branch defects)

1. **WSL idle shutdown.** The first integration attempts failed with `P1001 Can't reach database server` and
   `57P01 terminating connection due to administrator command`. The PostgreSQL log showed clean fast shutdowns and
   restarts about every 20 s, with the postmaster PID starting low each time: most likely the WSL distro stopping when
   no WSL process holds it (connections from Windows through the localhost relay do not). Keeping one
   `wsl.exe -e sleep` running for the duration of the tests stopped it. PM2's `wsl-db` keeper was not touched.
2. **`127.0.0.1` vs `localhost`.** From Windows, Prisma's query engine could not reach `127.0.0.1:5432` while the
   schema engine (`migrate deploy`) could; `localhost:5432` worked for both. The scratch URLs use `localhost`.
3. **Inventory integration** needs a seeded database (device models, Super Admin); it passed after the branch's own
   `db:seed` on the scratch DB.
4. **Jest open handles.** The full `--runInBand` run with the DB printed "Jest did not exit one second after the
   test run"; the results file was complete. Later runs used `--forceExit`. One leftover Jest process of this run
   (in the clone only) was stopped before the r0 install.

## 4. What this means for the port

- Doc 17 risk **R-8** ("branch suites quoted, not re-run") is closed: the branch is green on its own terms, including
  the 13 PostgreSQL integration cases (role matrix, cross-tenant denial, R5 edits / history / concurrency, R6
  idempotent enqueue and exactly-once execution under concurrent workers, purge and retention).
- The figures in doc 17 §6 differ slightly from the run: `routing-v2.spec.ts` has 35 runnable tests (+1 live),
  `access.spec.ts` 22. The integration and worker cases are the ones P6, P8 and P9 should carry over (with
  `RoutePlanStop`, the new publish target and a fake GraphHopper engine instead of a fake Valhalla).
- Nothing from the clone was copied except by hand into `etms/e4-salvage` (see that branch's commits).

## 5. P2 and salvage validation on `etms/e4-salvage` (for reference)

Branch `etms/e4-salvage` from `etms/e4`, rebased onto 3efa926 (P4 contracts + P6 schema). Commits: API_HOST,
MiniMap attribution, port-as-is salvage, salvage onto the P4 contracts and P6 schema.

| Check | Result |
|---|---|
| API `tsc --noEmit` | clean |
| API Jest (full) | **3,857 passed**, 46 skipped, 0 failed (186 suites; 3,796 on 3efa926 + 61 new) |
| New API specs | `config/api-host.spec.ts`, `routing/private-url.spec.ts`, `routing/routing.errors.spec.ts`, `routing/optimizer/optimizer.client.spec.ts`, `routing/service-area/coverage.spec.ts`, `routing/usage/routing-usage.service.spec.ts`, `routing/routing-axis.spec.ts` (61 tests) |
| Usage DB test | `routing/usage/routing-usage.db-test.ts` on `veetrax_e4d_usage_test` (all etms/e4 migrations from zero): **2 / 2** (25 concurrent increments sum exactly; switched off writes nothing). Database dropped. |
| Web `tsc -b` | clean |
| Web tests | **281 / 281** (+3: `features/alerts/mini-map-options.test.ts`) |
| Web build + `check-no-external-maps` | build OK; `check-no-external-maps: OK, 679 files scanned … no outside map hosts` |
