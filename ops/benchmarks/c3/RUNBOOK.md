# C3 benchmark kit: B1–B6 and the R-5 tracking-isolation test

Purpose: the measurements that doc 12 §7 requires **before any production enablement request** for E4 route
optimisation ("benchmarks B1–B6 meet targets on staging"), plus the R-5 / R-3 load test (doc 06 §6, doc 13 ETR-29,
ETR-31, ETR-38). Everything here runs on the **C3 staging host** only. Production is never a target (doc 11 §5.4
rule 1); every script refuses it.

Status: prepared 2026-11-12, **never run against a host**. Only the dry runs were exercised (see "Verification").

## 1. Files

| File | Bench | Runs on | What it does |
|---|---|---|---|
| `lib/guard.sh` | all | – | Safety guard sourced by every script (section 3) |
| `lib/guard.ts`, `lib/c3guard.py` | all | – | The same guard for the TS / Python helpers; they refuse to run unless `guard.sh` passed |
| `lib/capped.sh` | B4, B5 | C3 host | Runs a command under the optimiser unit's caps: `CPUQuota=150%`, `MemoryMax=3G`, `MemorySwapMax=0`, nice 10 |
| `b1-route-latency.sh` | B1 | load generator | `/route` latency c1 / c4 / c8, Chennai / Bengaluru / Delhi NCR (`helpers/b1-route-latency.ts`) |
| `b2-matrix-full.sh` | B2 | load generator (or C3 host for GH CPU-seconds) | Full matrices 100 / 200 / 400 via `apps/api/scripts/etms-matrix-bench.ts` (the API's real `MatrixBuilder`) |
| `b3-sparse-quality.sh` | B3 | C3 host | Full vs k = 20 / 40 / 60 sparse matrices (`helpers/export-matrix.ts`), solved and re-scored (`helpers/b3_quality.py`) |
| `b4-solve-scaling.sh` | B4 | C3 host | Solves 100 / 200 / 300 / 500 nodes x 10 / 30 / 60 / 120 s under the caps (`helpers/b4_solve.py`) |
| `b5-transit.sh` | B5 | C3 host | Python callbacks vs `RegisterTransitMatrix` (`options.transit`), same problems |
| `b6-mixed-load.sh` | B6 | load generator | Tracker `/route` + `/match` replay alone, then during matrix builds (`helpers/tracker-replay.ts`) |
| `r5-isolation.sh` | R-5 | load generator (+ ssh to C3) | Device ingest + tracker replay, then the same plus matrix builds and 500-node solves on the real `veetrax-optimizer` unit |
| `run-all.sh` | all | – | Runs them in order with one results stamp; `--dry-run`, `--only B1,B4` |
| `config.example.env` | all | – | Every setting, with the TBD inputs marked |
| `helpers/evaluate.mjs` | B2, B6, R-5 | – | Pass/fail evaluation of the collected files |

Problems and points are synthetic only: jittered grids around public city centres (`matrix-test-kit.syntheticPoints`)
and the seeded corpus generator (`services/routing-optimizer/corpus_gen.py`). No names, homes or addresses.

## 2. Pass thresholds

Only numbers written in a document are used. Where a document gives none, the kit says **TBD (owner)** and does not
invent one.

| Check | Threshold | Source |
|---|---|---|
| B1 `/route` latency, calc_points=false | p95 **< 20 ms at c4**, every city | doc 06 §7 benchmark plan (proposed target) |
| B2 full matrix | **200 x 200 < 60 s** (COMPLETE), every city; CPU-seconds recorded | doc 06 §7 |
| B3 sparse k-nearest | **< 3 % worse** than the full matrix, every k; no extra unassigned stops | doc 06 §7 |
| B4 solve scaling | **300 nodes FEASIBLE, 0 hard-constraint violations in 60 s** | doc 06 §7 |
| B4 (also) | 500 pax / 40 veh **≤ 60 s**; **never above timeLimitS + 10 %** | doc 11 §5.2 |
| B4 (also) | no solve killed under **MemoryMax=3G** / CPUQuota=150 % | doc 06 §7 production limits; doc 16 §3.1 (D3 target ≤ 3 GB / 1.5 cores) |
| B5 callbacks vs `RegisterTransitMatrix` | **measure** (no pass/fail) | doc 06 §7 |
| B6 mixed load | tracker `/route` p95 **not > 2 x baseline** | doc 06 §7 |
| B6 `/match` p95 | reported; **threshold TBD (owner)** (doc 06 §7 names map matching in the load but sets a limit for `/route` only) | – |
| B6 / R-5 replay rates | "at production rates": **TBD (owner/ops)**, from production GraphHopper access logs. Required input, no default | doc 06 §7 (no number) |
| R-5 1 | tracker `/route` p95 under load ≤ 2 x baseline | doc 06 §7 B6 |
| R-5 2 | every 500-pax / 40-veh solve FEASIBLE in ≤ 60 s (+10 %), no 503 / reset | doc 11 §5.2 |
| R-5 3 | optimiser unit: no restart, no OOM kill, `MemoryPeak` < 3G | doc 06 §7 limits; doc 16 §3.1 |
| R-5 4 | `/api/health/tracking` 200 at every poll | doc 14 G6 (release health gate) |
| R-5 5 | positions **0 lost** | doc 11 §5.2 |
| R-5 6 | `vt_queue_oldest_pending_seconds` p95 ≤ 3 s under load (**proxy**) | doc 11 §5.2 "fix → dispatcher map p95 ≤ 3 s". The true fix-to-map latency needs the E7 live-board socket probe, which is not in this kit |
| R-5 load shape | 1,000 devices at a 10 s fix interval | doc 11 §5.1 (live dispatch workload) |
| Gate | doc 12 §7: B1–B6 meet targets on staging before any enablement request; doc 11 §5.4 rule 5 (2 consecutive runs) applies to E9 sign-off | doc 12 §7, doc 11 §5.4 |

Not in scope: B7 (needs the `foot` profile, owner decision O3), B8 (GH re-import), B9 (ETA calibration drives).

## 3. Safety guard (every script)

A script refuses (exit 3) unless all of these hold:
1. `C3_TARGET` is set, and neither it, what it resolves to, nor any of `C3_GH_URL`, `C3_API_URL`, `C3_OPTIMIZER_URL`,
   `C3_GATEWAY_HOST`, `C3_SSH` is production (`*.veetrax.com` including app. and us., or `103.176.85.69`). The machine
   running the script must not be production either (hostname and `hostname -I`).
2. `C3_CONFIRM_NOT_PRODUCTION=yes`.
3. The measured CPU has no AVX (`grep -c avx /proc/cpuinfo` = 0, doc 16 §3.1): the local CPU for on-host scripts, the
   C3 host's over `ssh $C3_SSH` for off-box scripts. With `C3_ALLOW_AVX=1` it runs, and every result and verdict is
   labelled **"AVX present, not production-comparable"**.
4. On-host scripts: the marker file `/etc/veetrax/c3-staging` exists (off-box scripts check it over ssh).

Helpers started directly (without their `.sh`) refuse too. Tunnels (`127.0.0.1:18989`) cannot be told apart from a
tunnel to production: the marker and AVX checks over `C3_SSH` are the protection there, so open tunnels only to
`$C3_SSH`.

Dry run: `--dry-run` or `C3_DRY_RUN=1`. Same checks (a missing marker or the ssh checks are only warnings), then the
plan is printed, problem sizes are validated against the solver limits, and nothing is sent.

## 4. Prerequisites (owner decision C3)

1. **Host** (doc 16 §3.1): 6 vCPU x86-64 with **AVX hidden or absent**, ≥ 27 GiB RAM, SSD ≥ 200 GB, a separate
   physical host (doc 16 §3.2: capped WSL2 on the dev PC is not production-class and gives labelled pre-checks only).
2. **Stack:** Ubuntu 24.04 built **only** with `ops/deploy/linux/install-ubuntu.sh`, the `ops/deploy/linux/*.service`
   units and `ops/deploy/linux/maps/` (GraphHopper 11.1 India `-Xmx8g`, Photon `-Xmx3g`, Martin), the same memory
   flags as production, Valkey 7.2. With `ETMS_ROUTING=on` **only on this host** so `veetrax-optimizer` and
   `veetrax-routing-worker` are installed with their caps; `release.sh` builds the optimiser venv (Python 3.14, hashed
   lock).
3. **Database:** `veetrax_etms_test` from migrations + seed + synthetic data (doc 11 §5.4 step 2, §6). No copy of
   production data.
4. **Load generator:** a second machine (doc 11 §5.4 rule 4) with this repo at the same commit, `npm ci`, Node 22+,
   ssh access to the C3 host. On-host scripts additionally need the optimiser venv on the C3 host.
5. **Inputs to obtain first:** production tracking rates for `/route` and `/match` (owner/ops, from production
   GraphHopper access logs, read by someone with production access; the kit never reads production).

## 5. Procedure

Record every step's start time and anything unusual in `results/<stamp>/notes.md`.

1. Copy `config.example.env` to a private file outside the repo, fill it in, `chmod 600`, then
   `set -a; source ~/c3/c3.env; set +a`.
2. On the C3 host, as root: `install -m 644 /dev/null /etc/veetrax/c3-staging` (the marker), and check
   `grep -c avx /proc/cpuinfo` = 0. Never create this file anywhere else.
3. Record the host state: `systemctl status veetrax-*`, `free -g`, `nproc`, GraphHopper `/info`, `git rev-parse HEAD`.
4. Open the tunnels from the load generator: `ssh -N -L 18989:127.0.0.1:8989 -L 18090:127.0.0.1:8090 "$C3_SSH"`.
   Copy the C3 host's `/etc/veetrax/optimizer.env` and the API's `METRICS_TOKEN` into 0600 files named in the config.
5. Register the simulator devices on the C3 host (R-5):
   `npm run sim:register -w @veetracer/api -- --count 1000 --imei-start 868120007000001` (C3 database only).
6. Dry run everything: `bash ops/benchmarks/c3/run-all.sh --dry-run` on the load generator and
   `bash ops/benchmarks/c3/run-all.sh --dry-run --only B3,B4,B5` on the C3 host. Fix every MISSING / WARN line.
7. Quiet host: no other load, routing jobs idle.
8. Run, with one stamp (`export C3_STAMP=$(date -u +%Y%m%dT%H%M%SZ)` on both machines):
   1. load generator: `bash b1-route-latency.sh` (B1 needs GraphHopper otherwise idle);
   2. load generator: `bash b2-matrix-full.sh` (or on the C3 host with `C3_GH_PID` for GH CPU-seconds);
   3. C3 host: `bash b4-solve-scaling.sh`, then `bash b5-transit.sh` (API stack idle; about 15 + 10 min);
   4. C3 host: `bash b3-sparse-quality.sh`;
   5. load generator: `bash b6-mixed-load.sh` (2 x 5 min);
   6. load generator: `bash r5-isolation.sh` (2 x 10 min + drain).
9. Repeat step 8 once more on another day (two consecutive passing runs, as doc 11 §5.4 rule 5 asks for E9).

## 6. Recording results

Each script writes to `results/<stamp>/<id>/` (git-ignored): `meta.json` (target, AVX label, kernel, CPUs, memory,
git SHA), raw JSON / JSONL, a CSV, the log and `verdict.txt` (`PASS` / `FAIL` / `MEASURED`). For the evidence of
record, copy the folder into `docs/employee-transport/evidence/<date>-c3-benchmarks/` with a `results.md` (the table
of section 2 with measured values and verdicts) and `results.json`, following the `docs/reliability/evidence/`
convention (doc 11 §5.3). Results labelled "AVX present, not production-comparable" are never evidence of record.

## 7. Abort criteria

Stop the run (Ctrl-C; the scripts kill their background loads on exit) and record why when:
- any guard refusal, or the host turns out to be anything but the C3 host;
- the C3 host swaps, or any non-optimiser VeeTrax unit restarts or is OOM-killed;
- GraphHopper errors exceed 1 % of requests in a baseline phase (the measurement is invalid);
- `/api/health/tracking` turns CRITICAL in a baseline phase (the host is not healthy enough to measure);
- disk free on the C3 host drops below 10 %.

A failed threshold is not an abort: finish the run and report it.

## 8. Cleanup

- Stop the tunnels; delete the token copies (`shred -u`).
- On the C3 host: remove the simulator devices if the host is shared
  (`DELETE` via the chaos-run pattern, C3 database only), flush nothing in Valkey that the kit did not create
  (the kit writes no Valkey keys itself; the matrix builds use no cache).
- Keep `/etc/veetrax/c3-staging` while the host is the C3 host; remove it when the host is repurposed.
- `results/` stays local until copied into the evidence folder.

## 9. Verification of this kit (2026-11-12, dev PC, no traffic)

- `bash -n` on every script; `node --check helpers/evaluate.mjs`; `tsc --noEmit` over the TS helpers (with the
  apps/api tsconfig); `py_compile` on the Python helpers (WSL venv, Python 3.14.4).
- Guard: refuses with no target, an `app.veetrax.com` / `us.veetrax.com` / `103.176.85.69` target or service URL, a
  missing confirmation, and an AVX CPU without `C3_ALLOW_AVX=1`; helpers refuse without the shell guard.
- Dry runs of B1–B6, R-5 and `run-all.sh` pass with `C3_ALLOW_AVX=1` (the dev PC has AVX); problem sizes 100 / 200 /
  300 / 500 build within the solver limits (104 / 204 / 304 / 504 nodes, 13 / 25 / 30 / 40 vehicles).
- `evaluate.mjs` b2 / b6 / r5 checked against hand-made fixture files (pass and fail cases).
- Indicative local pre-check (E4 gates task 2, dev PC WSL, **AVX present, not production-comparable**): one 500-stop /
  50-vehicle synthetic solve (30 s) under the repo's `veetrax-optimizer.service` (DynamicUser, full sandbox) peaked at
  about 120 MB for the whole unit (HTTP process + one spawn worker), far below `MemoryMax=3G`. B4 / R-5 still decide.
