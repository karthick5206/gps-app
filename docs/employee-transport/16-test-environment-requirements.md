# 16 · ETMS isolated test-environment requirements (E0.5, item 5)

E0.5 planning deliverable · worktree `D:\Vibhav\gps-app-wt\etms` at **v1.8.0 (f5b151b)** · 2026-11-11.

**Status: requirements only.** Nothing in this document has been provisioned, installed, configured or run. No server,
database or Valkey instance was contacted while writing it. Everything that costs money, changes a server, or changes a
developer machine's global configuration (for example `.wslconfig`) needs separate owner authorisation (README §1.1:
"Not authorised: … infrastructure changes"). Each statement is marked **V** (verified from the repo, a Lead production
check, or a read-only look at the dev PC's hardware) or **P** (proposed). Estimates are marked **est.** and must be
measured before anyone relies on them.

> **Lead answer: production versions** (installed 2026-11-10, verified on `veetrax-prod`). Test tiers must match
> these: Node **v24.22.2**, PostgreSQL **18.6** (PGDG) + TimescaleDB **2.31.0** (telemetry off), Valkey **7.2.13**
> (Ubuntu package, `appendonly no`), Caddy **2.11.9**, OpenJDK **21.0.13**, GraphHopper **11.1**, Photon **1.3.0**
> (India dump `photon-db-india-1.0`, 2026-11-03), Martin **1.16.1**, Planetiler **0.10.2**. Ubuntu **24.04.5**,
> kernel 6.8.0-40. CPU: QEMU virtual model **without AVX** (x86-64-v2), 6 vCPU.

Short references follow README §3: `11` = [11-testing-and-acceptance.md](11-testing-and-acceptance.md), `12` =
[12-phased-implementation-plan.md](12-phased-implementation-plan.md), `13` =
[13-risks-dependencies-and-estimates.md](13-risks-dependencies-and-estimates.md), `VALIDATION` =
[VALIDATION.md](VALIDATION.md). "09-TS" = `docs/modernization/09-test-strategy.md` in the main checkout.

---

## 0. Facts this document is built on

### 0.1 Production (Lead-verified, 2026-11-11)

| Item | Value |
|---|---|
| OS / CPU / RAM | Ubuntu 24.04, 6 vCPU **without AVX**, 27 GiB RAM, 16 GiB available |
| Maps | GraphHopper 11.1 India, profile `car` CH + LM, RSS 8.6 GB (`-Xms2g -Xmx8g`); Photon 1.3 India, 1.1 GB (`-Xmx3g`); Martin 1.16.1 + Planetiler 0.10.2 India `pmtiles`; Java 21 (`ops/deploy/linux/maps/README.md`) |
| Data stores | PostgreSQL 18 + TimescaleDB; Valkey 7.2, `appendonly no`, `maxmemory-policy noeviction` (`install-ubuntu.sh` l.51–57) |
| Runtime | Node.js 24 (`install-ubuntu.sh` l.23–26), systemd units with `--max-old-space-size=512` |
| Owner rule | Nothing leaves the server for maps, routing or geocoding |

### 0.2 Dev PC and existing test assets (V)

| Item | Fact | Consequence |
|---|---|---|
| Dev PC hardware | AMD Ryzen 7 8845HS, 8 cores / 16 threads (**has AVX / AVX2 / AVX-512**), **28.8 GB RAM**, no `.wslconfig` (so WSL2 gets its default limit, about half the host RAM, ≈14 GB), D: 222 GB free | The dev PC **cannot** host a 27 GiB production mirror next to Windows (§3.2) and cannot reproduce "no AVX" |
| WSL stack | PostgreSQL 18 and **Valkey 9** run as systemd services in one WSL distro. The PM2 dev processes (api :4000, gateway :5023/5027/5030, web, keep-alive) run on Windows against DB `veetracer` and Valkey db 0 | Valkey version ≠ production; one Valkey server is shared by the dev stack and the isolated instance |
| Isolated instance | DB `veetrax_assess`, Valkey **db 1** on that shared Valkey, API :4100, web :5174, gateway :5123 / 5127 / 5130 / 6908 (09-TS §2) | Fine for functional tests. **Not** fine for drills that kill, restart, wipe or reconfigure Valkey: those hit db 0 too (§2.2) |
| Chaos evidence | `docs/reliability/test-evidence.md`: Node 22.23.4, PostgreSQL 18, **private Valkey 9.0.4** (TLS run: 9.1.3), 26,521 / 26,521 positions, 0 lost | The baseline was not produced on production versions (Node 24, Valkey 7.2): one more reason for C6 |
| Probe evidence | `docs/modernization/tenant-isolation-probes.md`: PASS 20 / FAIL 0 / INFO 7 / SKIP 1 on 2026-11-09, :4100. F-1 (socket survives logout) is INFO | Probe defaults hard-code company / vehicle ids of `veetrax_assess` (`tenant-isolation-probe.ts` l.37–39) and its header says `veetracer_assess` (doc drift) |
| CI | `.github/workflows/ci.yml`: jobs `api`, `web` on **Node 22**, no service containers, no mobile | §5 |
| Env templates | `apps/api/.env.example` sets `GEOCODER=nominatim` + public Nominatim URL; `apps/web/.env.example` sets OpenFreeMap styles; `ROUTER_ENGINE` defaults to `valhalla` when unset (`routing.service.ts` l.22) | A test env copied from the examples breaks the owner rule (§8) |
| Migrations | 59 migrations; the init migration creates the TimescaleDB extension and hypertable **only if the extension is available** (`20261018002831_init` l.507–509) | A plain `postgres` image silently gives non-hypertable tables. Test tiers must assert the extension is present |

---

## 1. Environment tiers and what each is for

### 1.1 Tier definitions (P)

| Tier | Where | Data | Maps / routing | Purpose | Never used for |
|---|---|---|---|---|---|
| **T1 Developer unit** | Developer's machine, no services | In-memory fakes (existing pattern) | None | Pure rules, reducers, mappers, policy tables, timelines (`route-drive.spec.ts`) | Anything needing PostgreSQL / Valkey |
| **T2 CI** | GitHub Actions `ubuntu-latest`, PostgreSQL 18 + TimescaleDB and Valkey 7.2 service containers | Migrated empty `_test` DB + per-spec fixtures | None (haversine matrices, fake geocoder) | Every PR: typecheck, unit, DB integration, isolation matrix, mobile typecheck | Load, chaos, real maps, screenshots of record |
| **T3 Local isolated instance** | Dev PC, WSL (§2) | `veetrax_assess` (app runs) and `veetrax_*_test` (destructive specs, chaos), synthetic only | Local GraphHopper (three-metro extract), local Photon, local Martin, plus a mandatory "routing off" mode (§2.3–2.5) | Functional acceptance of D6 (G1–G8 test-side evidence) and R1 (E1a–E3); C6 baselines; drills that are safe on one machine | Performance numbers of record, CPU-sensitive benchmarks |
| **T4 Staging** (blocked on owner decision C3) | Separate production-class host (§3) | Synthetic only, production volume | Full India GraphHopper / Photon / Martin built like production | E4 benchmarks B1–B6 (+ B8), E7 load, E9 soak, production-volume restore timing (G7 RTO) | Anything with production data or production credentials |
| **T5 Production smoke** | Production, after an owner-approved deploy | Production (read-only) | Production | Post-deploy confirmation only: health endpoints, one config read, one screenshot | Tests that write, load, chaos, synthetic data, simulators |

### 1.2 Which tier proves what

✔ = tier of record (its evidence is what the Lead accepts); ○ = supporting / early signal; — = not used.

| Gate / phase | T1 unit | T2 CI | T3 local | T4 staging | T5 prod smoke |
|---|---|---|---|---|---|
| G1 share-page bug | ✔ mapper test | ✔ runs it | ✔ Playwright before / after, 3 synthetic shares | — | ✔ one screenshot after deploy |
| G2 lost alert notifications | ✔ notifier logic | ✔ DB-int sweeper test | ✔ new chaos scenario + existing suite | — | — |
| G3 misleading `SENT` | ✔ per-provider test | ✔ | ✔ `SKIPPED` rows on a run | — | ✔ read-only check: no new `SENT` for console / unset mailer |
| G4 Valkey AOF + recovery | — | — | ✔ drill on a **private** Valkey 7.2 | ○ AOF rewrite / disk at production volume | ✔ `CONFIG GET appendonly` after the window |
| G5 logout closes sockets | ✔ gateway test | ✔ | ✔ probe 20 runs + probe suite | — | — |
| G6 routing / map health | ✔ check tests | ✔ | ✔ stop / start GH, Photon, Martin; `release.sh` dry run on systemd WSL distro | ○ | ✔ release gate passes on the real deploy |
| G7 backup **and** restore | — | ✔ secret / dump scan | ✔ restore drill, synthetic data | ✔ RTO at production volume (if C3 decided) | ✔ backup freshness visible after deploy |
| G8 builds without external maps | — | ✔ env / `eas.json` lint | ✔ emulator + browser capture against T3 tiles | — | ✔ capture of the owner-approved production build |
| C6 baselines | — | ○ probe later in CI (E1a 1a.3) | ✔ isolation probe + chaos run | — | — |
| E1a | ✔ policy matrix L1 | ✔ matrix L2, completeness guard, DB job | ✔ probe 20/20, Playwright role logins | — | — (no deploy, D8) |
| E2 | ✔ import validation | ✔ unique constraints, purge | ✔ 10k import ≤ 60 s, Playwright wizard | — | — |
| E3 | ✔ recurrence / DST / cut-offs | ✔ double submit, publish transaction | ✔ **R1 end-to-end run** (`sim:route` + bots + Playwright), routing on and off | ○ burst SLO (see §9 Q12) | — |
| E4 benchmarks B1–B6, B8 | — | ✔ corpus with haversine, pytest (from E4 only) | ○ functional dry run on the three-metro graph | ✔ **only tier of record** | — |
| E7 load / E9 soak, chaos with ETMS | — | — | ○ | ✔ | — |

---

## 2. Local isolated instance requirements (T3)

### 2.1 Versions that must match production

| Component | Production | T3 requirement | Today on the dev PC | Gap |
|---|---|---|---|---|
| PostgreSQL | 18 | 18, same major; minor recorded in evidence | 18 (V) | none, but record minor |
| TimescaleDB | installed (version not in repo) | **same extension version** as production; every test run asserts `SELECT extversion FROM pg_extension WHERE extname='timescaledb'` is not null | installed (assumed from the chaos runs) | Lead to supply the production `extversion` (read-only) |
| Valkey | 7.2 | **7.2.x, same patch** as production, as a **private process** on its own port | 9.x shared server | **Yes**: new private Valkey 7.2 needed |
| Node.js | 24 | 24 for the processes under test (api, gateway, processor, notifier, summarizer, harnesses) | 22.23.4 in the evidence (V) | **Yes** |
| Java | 21 | 21 for GraphHopper 11.1, Photon 1.3.0, Planetiler 0.10.2 | not checked | verify |
| GraphHopper / Photon / Martin | 11.1 / 1.3.0 / 1.16.1 | same jars / binary; same `graphhopper.yml` except paths, port and heap | not installed for main (the routing branch used Valhalla, out of scope per D3) | install |
| OS | Ubuntu 24.04 | **Recommended:** a second, dedicated WSL distro `Ubuntu-24.04` (`veetrax-test`), built with the same apt sources as `install-ubuntu.sh` (PGDG, TimescaleDB packagecloud, `valkey-server`), so package versions match production without hand builds | Ubuntu 26.04 distro (dev stack) | owner approval (installs software on the dev PC) |

Why a separate distro rather than more services in the dev distro (P):
- `apt install valkey-server` in the 26.04 distro gives Valkey 9, not 7.2; the 24.04 distro with production's apt sources
  gives production's package set.
- A drill can then `kill -9` / restart / wipe the test Valkey and PostgreSQL cluster without touching the dev stack's
  services.
- systemd can be enabled in that distro, so G6's `release.sh` dry run and the unit files in `ops/deploy/linux/` run as on
  production.

Limits that stay (V for WSL behaviour): all WSL2 distros share **one VM, one memory limit and one network namespace**.
Ports must therefore never collide across distros (§2.2), and `wsl --shutdown` or a `.wslconfig` change stops the dev
stack's databases too. Neither is allowed without the developer's consent.

If the owner prefers not to add a distro: run Valkey 7.2 built from the upstream 7.2 source tag as a private
`valkey-server` on its own port inside the dev distro, and a second PostgreSQL 18 cluster (`pg_createcluster 18 test
--port 5433`). Same isolation, less OS parity.

### 2.2 Isolation rules (P, mandatory)

| # | Rule |
|---|---|
| I1 | **Databases:** the app instance uses `veetrax_assess`; destructive specs, chaos and restore drills use databases whose name ends in `_test` (`veetrax_ci_test`, `veetrax_etms_test`, `veetrax_chaos_test`, `veetrax_restore_test`). The `veetracer` database is never opened by any test, script or harness. |
| I2 | **Valkey:** never db 0, never the shared dev server on :6379 for anything except the transitional functional use of db 1. Every drill that kills, restarts, wipes, `FLUSH*`es or `CONFIG SET`s Valkey (G2, G4, C6 chaos, R1 / R10) runs on the **private Valkey 7.2** only. The chaos harness already does this with its own instance on :6390 (`chaos-run.ts` l.100). |
| I3 | **Ports** (all bound to 127.0.0.1 unless a device emulator needs LAN access): API 4100, web 5174, gateway 5123 / 5127 / 5130 / 6908 (existing). New for T3: private Valkey 7.2 **6392**, test PostgreSQL cluster **5433** (if a second cluster is used), GraphHopper **18989** (admin 18990), Photon **12322**, Martin **13000**. Media / attachment listeners: set `MEDIA_PORT`, `ATTACH_PORT` to `0` (disabled) and `MEDIA_HTTP_PORT` to a free port (the example's 4110 is close to 4100 and must not clash with the dev stack). Chaos harness ports stay as coded (6390 / 6391 / 14100 / 14121 / 15023 / 15432). Before each run, a port check proves none of these is already in use. |
| I4 | **PM2 dev processes are untouched:** no `pm2 restart/stop/delete/save`, no edits to `ops/run/ecosystem.config.cjs`, no change to the Cloudflare tunnel config. T3 processes run under their own process manager (a separate PM2 home via `PM2_HOME`, or systemd in the test distro), never in the dev PM2 list. The isolated instance is **never exposed through the tunnel**. |
| I5 | **Safety guards in code** (exist today and stay): probes refuse `:4000`; chaos refuses a non-`_test` DB; int specs check `_test`. New shared guard (§5.3) refuses `veetracer`, db 0 and the dev Valkey port. |
| I6 | **No outbound map / messaging traffic:** `GEOCODER=photon` with the local URL (or `none`), `ROUTER_ENGINE=graphhopper` with the local URL (or `ROUTER_URL` unset for routing-off runs), self-hosted map styles, no SMS / mail / Arattai / push credentials, `OTP_DEV_ECHO=true`, `MAIL_DEV_ECHO=true`. |
| I7 | **Clean slate per acceptance run:** `veetrax_*_test` databases are dropped and re-created from migrations + seed + synthetic generator; `veetrax_assess` is only re-seeded with owner-visible notice because the golden fixture is a copy of it (`11` §1.1). |

### 2.3 Routing for tests (GraphHopper)

**Options compared**

| Option | What | RAM (est.) | Production impact | Privacy | Fidelity | Verdict |
|---|---|---|---|---|---|---|
| A. None / straight lines | `ROUTER_URL` unset; `sim:route` with `path: null` or bundled hand-drawn paths (`chennai-route.json` needs no GraphHopper, V) | 0 | none | none | No road geometry, no GH ETA cap, no map matching | **Required as a second mode** (E3 exit: "everything works with GraphHopper stopped"; R5), but cannot prove G1 or G6 |
| B. Local GraphHopper, city / multi-metro extract | GraphHopper 11.1, same `graphhopper.yml` (paths, port 18989, heap changed), `car` CH + LM | Chennai metro: serving heap ≈ 0.5 GB, RSS < 1 GB. Three metros (Chennai + Bengaluru + Delhi NCR): heap ≈ 1–1.5 GB, RSS ≈ 1.5–2 GB. Tamil Nadu: serving ≈ 1.5–2 GB RSS, but import with CH + LM preparation likely needs ≈ 3 GB heap (est., scaled from India's 8.6 GB RSS by road-network share) | none | synthetic coordinates stay on the PC | Same engine, version, profile and config as production; only coverage differs | **Recommended** |
| C. Read-only SSH tunnel to production GraphHopper | `ssh -L 18989:127.0.0.1:8989 veetrax-prod` | 0 locally | **Real**: CPU on a 6-vCPU no-AVX box that serves live ETA capping and map matching; benchmark-style or E2E bursts compete with customers | Synthetic only, so no PII leaves, **but** a production SSH key must live on the test tier, which breaks §8 and the tier boundary | Exact production graph | **Rejected** for T3 / T4. Also contrary to `11` §5.4 rule 1 and this phase's "no server connections" |

**Can a city-only extract run in about 2 GB?** Estimated **yes for serving** a Chennai or three-metro graph with
`-Xmx2g`; Tamil Nadu is borderline at 2 GB and should be imported once with a larger heap (≈ 3 GB) and then served with
`-Xmx2g`. Geofabrik publishes India as zones (for example `asia/india/southern-zone`), not per state (verify at
download time); per-city extracts are cut locally with the free `osmium-tool` from the **same `india-latest.osm.pbf`
vintage production uses**, so road data matches. These are estimates: the first install must record import peak heap,
graph-cache size and RSS after 1,000 route calls in the evidence folder.

**Recommendation (P):** Option B with a **three-metro extract** (bounding boxes, approximate):
Chennai `79.95,12.75,80.40,13.35`; Bengaluru `77.35,12.75,77.85,13.25`; Delhi NCR `76.80,28.30,77.60,28.90`,
merged into one `.pbf`. Reason: G1's acceptance requires synthetic shares in **Chennai, Bengaluru and Delhi NCR** with
GraphHopper on (`12` §2.1), and the `11` §6 generator presets are Chennai and Bengaluru, so a Chennai-only or Tamil Nadu
graph cannot pass G1. Cross-metro routes simply fail (no path), which is acceptable. Cap: `-Xms512m -Xmx2g`. Every R1
acceptance run is executed twice: routing on (Option B) and routing off (Option A). US sites (Dallas, Phoenix) are not
needed before E8: US DST tests are time-zone tests and do not need roads.

### 2.4 Geocoding (Photon)

| Option | Fit |
|---|---|
| India Photon 1.3 dump, as production (`photon-db-india-1.0-latest`) | Same data and version; ≈ 1.1 GB RSS observed in production, capped at `-Xmx2g` locally; disk to be measured (production `du` of `photon_data` to be supplied by the Lead) |
| City-only Photon index | Photon dumps are published per country. A city index means running a Nominatim import of the extract and exporting it to Photon: heavy, slow and a second pipeline to maintain. **Not recommended** unless disk on the test tier is short |
| Fake geocoder | A small fixture HTTP server that answers `/api` and `/reverse` for the synthetic sites and cluster centroids. **Recommended for T2 (CI)** and for deterministic Playwright snapshots |

**Recommendation (P):** T3 runs the India Photon 1.3 dump on :12322 (download once, the only outbound connection, as in
the maps README); T2 uses the fake geocoder. E2's "home pin via Photon" acceptance runs on T3.

### 2.5 Tiles

| Option | Fit |
|---|---|
| Same self-hosted stack, small area | Planetiler 0.10.2 on the three-metro `.pbf` (minutes, not hours; `-Xmx2g`), Martin 1.16.1 on :13000, styles produced by `ops/deploy/linux/maps/make-styles.sh` rewritten to the T3 host. Web build env `VITE_MAP_STYLE_*` and mobile `EXPO_PUBLIC_MAP_STYLE_*` point at T3 |
| None | Map canvases blank; fine for API, unit and most Playwright flows |
| OpenFreeMap / public styles | **Forbidden** in every test tier (owner rule; G8) |

**Recommendation (P):** self-hosted small-area tiles on T3, because G8 needs a capture of real map use with zero
foreign hosts, and G1 / E3 screenshots need a basemap. CI and unit tiers use none. Planetiler's `--download` fetches
Natural Earth and water polygons once per build; record that in the evidence as an expected build-time connection.

### 2.6 T3 memory budget (est., inside the default ≈ 14 GB WSL limit)

| Process | Budget |
|---|---|
| Dev stack (existing PG 18 + Valkey 9 in the dev distro) | ≈ 2 GB |
| Test PG cluster + private Valkey 7.2 | ≈ 1.5 GB |
| GraphHopper three-metro | ≤ 2 GB |
| Photon India | ≤ 2 GB |
| Martin | < 0.1 GB |
| **Total in WSL** | **≈ 7.5 GB**; Node processes under test run on Windows or in the test distro (5 × ≤ 0.8 GB) |

No `.wslconfig` change is needed for T3. Planetiler / GraphHopper imports run one at a time.

---

## 3. Staging requirements (T4, for when the owner decides C3)

### 3.1 Hardware and software (production-class)

| Item | Requirement |
|---|---|
| CPU | 6 vCPU x86-64, **AVX hidden or absent** (verify `grep -c avx /proc/cpuinfo` = 0). If AVX cannot be hidden, every benchmark result is labelled "AVX present, not production-comparable" |
| RAM | ≥ 27 GiB to the guest (mirror production), ideally 32 GiB host |
| Disk | SSD, ≥ 200 GB (est.: India `.pbf`, GraphHopper graph-cache, Photon India, Planetiler temp files, PostgreSQL with production-volume synthetic history). Lead to supply production `du` figures to firm this up |
| OS / stack | Ubuntu 24.04; built **only** with `ops/deploy/linux/install-ubuntu.sh`, the `ops/deploy/linux/*.service` units and `maps/`; same memory flags (`-Xmx8g`, `-Xmx3g`, `--max-old-space-size=512`, `timescaledb-tune --memory 8GB`); Valkey 7.2, AOF state recorded per run |
| Optimiser (E4) | OR-Tools worker with explicit `MemoryMax=` / `CPUQuota=` (D3 target ≤ 3 GB / 1.5 cores) |
| Load generators | Off-box (`11` §5.4 rule 4) |

### 3.2 Host options

| Option | Feasibility | Verdict |
|---|---|---|
| **Capped WSL2 on the dev PC** (`.wslconfig` `memory=27GB`, `processors=6`, the README C3 default and `11` §5.4 option B) | **Not feasible as production-class (V):** the host has 28.8 GB in total, so 27 GB to WSL leaves Windows < 2 GB. `.wslconfig` is global (one VM for all distros, including the dev stack) and applies only after `wsl --shutdown`, which stops the dev databases. The CPU has AVX. A reduced profile (`memory=20GB`, `processors=6`, India GraphHopper at `-Xmx8g`, PostgreSQL tuned to ≈ 3 GB, dev work paused) is possible for **E4 functional pre-checks**, with every number labelled "indicative, not of record" | Usable only as a pre-check |
| **Separate VM on another physical host** (≥ 32 GB RAM, x86, CPU model without AVX, e.g. a KVM / Proxmox `-cpu` model that omits AVX) | Production-class | **Recommended** for E4 benchmarks of record, E7 load and E9 soak |
| Mintplus Windows server 166.0.242.121 | It is the planned production target, so using it for staging blurs the tier boundary; RAM / CPU flags unknown | Only as a load generator, if the owner agrees (`13` C3 default) |
| Free cloud tier | Any free tier with ≥ 24 GB (some are ARM-only) is not x86 / no-AVX, so benchmarks would not be comparable; account terms may need a card | Not recommended without an owner decision; no provisioning under this document |

### 3.3 Network isolation

1. No route to production: firewall denies the production IP; no production SSH keys, `.env` or certificates on staging.
2. Inbound: SSH key-only from an allow-list; web / API reachable only on the LAN or through an SSH tunnel. No public DNS
   name, no Cloudflare tunnel.
3. Outbound: **default deny**; temporarily allowed only for package installs and for the map data downloads listed in
   `maps/README.md` (Geofabrik, Photon dump, Planetiler sources) during a build window, then closed again. With egress
   closed, any attempt to reach an external map, geocoding or messaging host fails visibly, which doubles as a proof
   of the owner rule.
4. No messaging provider credentials; push disabled or pointed at a fake receiver.

### 3.4 Data

Synthetic only (§4), at production volume for E7 / E9 and the G7 RTO measurement (record count targets from production's
row counts, which the Lead may supply as aggregate numbers only). No production dump is ever restored to staging (§8).

### 3.5 Building the maps on staging

Follow `ops/deploy/linux/maps/README.md` exactly, with the **same `.pbf` vintage as production** (Lead to supply the
production file date so routes and timings are comparable): Geofabrik `india-latest.osm.pbf` → GraphHopper 11.1
import (CH + LM, 30–60 min, `-Xmx8g`), Planetiler 0.10.2 India `pmtiles` (`-Xmx4g`, 1–2 h), Photon 1.3 India dump,
`make-styles.sh`, Martin 1.16.1. Never copy `graph-cache`, `photon_data` or `india.pmtiles` from production: that needs
production access. Record import times and peak memory; they also answer O3 / B8 (foot / van re-import cost).

---

## 4. Synthetic data

### 4.1 Generators (P; implemented in WP 2.5 `apps/api/scripts/etms-synth/`, seeded PRNG, `11` §6)

| Entity | Generation rule |
|---|---|
| Companies | Tenant A "Synthetic Corp Chennai (test)" and tenant B "Synthetic Corp Bengaluru (test)", corporate-managed (R1); for E1b also 2 provider companies × 3 customers. Names always end in "(test)". Existing "Beta Transport (assessment)" stays as the non-ETMS control tenant |
| Sites | Public landmarks only (`11` §6: OMR / Sholinganallur, Guindy, Perungudi; Whitefield, Electronic City, Manyata; Delhi NCR added for G1, e.g. Cyber City Gurugram ≈ 28.49, 77.09) |
| Passengers / employees | Syllable-generated names, `synthetic: true`, e-mails `@example.test`. Home pins from 10–20 residential cluster centroids per city with Gaussian jitter (σ 300–800 m), 3–25 km commute; label `Synthetic Home #00123, <cluster>`, never a street address. Snapped to roads only with the **local** GraphHopper `/nearest` on T3 / T4 |
| Phone numbers | India `+91 00000 xxxxx` (100,000 numbers), **pending owner OK** (`11` Q9). The existing normalisers reject a leading 0 (`packages/shared/src/mobile-tracker.ts` l.12–14, `notifier/arattai.ts` l.47), so such numbers can never be routed by those senders; OTP login stores the raw string (`auth.service.ts` l.76–98) and works with `OTP_DEV_ECHO`. US `+1 555-01xx` |
| Shifts | India 06:00–15:00, 14:00–23:00, 22:00–07:00 IST; US 07:00–16:00, 15:00–00:00 America/Chicago incl. a DST week; 20 % leave / WFH, 5 % ad-hoc |
| Vehicles | Mix sedan 4, SUV 6, tempo traveller 12, minibus 26, bus 40 seats; plates `TN 00 TS 0001` style (non-issued series), tagged synthetic |
| Devices | GT06 IMEIs from the simulator range `86812000xxxxxxx` registered with `sim:register --count N --imei-start …` (V: `register.ts`); one device per vehicle |
| Drivers | Synthetic names, licence expiries incl. expired ones (blocking tests), `Driver.userId` link from E2 |

### 4.2 How `sim:route` drives vehicles (V today, P extensions)

- Today: `sim:route` drives GT06 devices along a route file, a scenario (`on-time`, `late-stop`, `deviation`,
  `skip-stop`, `unscheduled-stop` on `chennai-route.json`), ad-hoc `--stops`, or a path from `--router-url` (local
  GraphHopper only: `http://127.0.0.1:18989`). Multi-vehicle with `--imei-start / --count / --stagger`; time
  compression with `--speed-factor` (max 6 at 30 km/h). Fix timestamps are wall clock. Target: the T3 gateway
  `--host 127.0.0.1 --port 5123`, never :5023.
- Proposed (WP 3.8 / 5.5, `11` §6): `--trip <id>` / `--trip-file` (published ETMS trip), passenger events in scenarios,
  fleet mode `--plan`, new `etms-*` scenarios. For R1 (no driver app) the bot records dispatcher outcomes through the
  dispatcher API at `arrive` events; GPS alone never sets `BOARDED`.
- `gt06-sim` (random driving around Chennai) remains the load generator for T4.

### 4.3 Volumes

| Use | Companies | Passengers | Vehicles / devices | Other |
|---|---|---|---|---|
| T2 CI fixtures | 2 + control tenant | 20 | 4 | Hand-written per spec; isolation fixtures 2 providers × 3 customers from E1b |
| T3 functional (E1a–E3, D6) | 2 + control | **200** (E3 exit) | 20 | 1 recurring week IST + 1 US DST week; 10k and 50k import files (E2) |
| T3 C6 chaos | seed + 40 simulator devices | — | 40 | As in the 2026-11-09 run |
| T4 load (E7 / E9) | 3–5 customers | 5,000 booking burst; 50,000 import | **1,000** vehicles | 50 dispatcher sockets, 2,000 ETA pollers (`11` §5.1) |
| T4 restore timing (G7 RTO) | — | — | — | Synthetic position history sized to production row counts |

---

## 5. CI additions (T2)

### 5.1 Changes (P; implemented under WP 1a.3 unless noted, needs O4 approval for service containers)

| # | Change | Detail |
|---|---|---|
| C-1 | Node 24 | `actions/setup-node` `node-version: 24` in both jobs (production runs Node 24; CI runs 22 today) |
| C-2 | New job `api-db` | `services:` PostgreSQL 18 with TimescaleDB (official `timescale/timescaledb` image tag for PG 18, pinned to production's extension version) and `valkey/valkey:7.2` pinned to production's patch; health checks `pg_isready` / `valkey-cli ping`. Steps: `npm ci`, `build:shared`, `prisma generate`, `prisma migrate deploy` against `TEST_DATABASE_URL`, assert TimescaleDB present, then `jest --ci --testRegex '\.(int|integration)\.spec\.ts$' --runInBand` |
| C-3 | One env var | `TEST_DATABASE_URL=postgresql://ci:ci@localhost:5432/veetrax_ci_test` and `TEST_REDIS_URL=redis://localhost:6379/1`. The five DB-gated specs move from `REPORTS_TEST_DATABASE_URL`, `PURGE_TEST_DATABASE_URL`, `INVENTORY_IT_DATABASE_URL` to the single variable (old names accepted for one release) |
| C-4 | `_test` guard helper | `apps/api/src/test/scratch-db.ts`: refuses unless the DB name matches `/_test$/`; refuses `veetracer` and `veetrax_assess` explicitly; refuses Valkey db 0 and the dev port 6379 unless db ≥ 1 in CI; `stock/stock.db-test.ts` folded in (no guard today) |
| C-5 | New job `mobile` | `npm ci`, `build:shared`, `npm run typecheck -w @veetracer/mobile` (script exists, V), `npx tsc --noEmit` in `apps/tracker` (no script today); jest-expo + RNTL tests added when they exist (E3 WP 3.6 / E5 WP 5.5, O4) |
| C-6 | Hygiene check | A short script (no new dependency) that fails if tracked files match dump / key / archive patterns (`*.dump`, `*.sql.gz`, `*.age`, `*.gpg`, `*.pem`, `*.key`, `*.pbf`, `*.pmtiles`) or contain the OpenFreeMap host in an env file (supports G7, G8). A dedicated secret scanner is an O4 tool decision |
| C-7 | Routing-branch pytest | **Not added before E4.** `services/routing-optimizer` is not in main; it arrives only through the fresh-branch selective port after the compatibility review (D3, C4). WP 4.3 then adds a `python` job with pytest and the haversine corpus (`11` §2.3) |
| C-8 | Isolation probe in CI | Not as the black-box script (it needs a seeded running stack and hard-coded ids); superseded by the E1a matrix HTTP level (`11` §3.1) |

### 5.2 CI time impact (est.)

| Job | Today (est.) | After | Wall-clock effect |
|---|---|---|---|
| `api` | ≈ 5–7 min | unchanged apart from Node 24 | 0 |
| `api-db` (new, parallel) | — | npm ci ≈ 2 min (services start during it), migrate 59 migrations ≈ 0.5 min, DB specs ≈ 1–2 min (more as E1a–E3 add specs) | ≈ +0–1 min if it is not the longest job; ≈ 4–6 billable min |
| `mobile` (new, parallel) | — | npm ci ≈ 2 min, two typechecks ≈ 1–2 min | 0 wall; ≈ 3–4 billable min |
| `web` | ≈ 4–5 min | unchanged | 0 |

Net: **≈ +1 min wall clock, ≈ +8–10 billable minutes per PR** (consistent with `11` Q4's "about 5 extra minutes"
when counted per job). If the repository is private, Actions minutes count against the plan's free quota; at 100 PRs /
pushes a month that is ≈ 1,000 extra minutes, which must stay inside the free allowance (no paid overage without owner
approval, §9 Q5).

---

## 6. Baseline re-runs required by C6

Both baselines are re-run on **T3**, on production versions (Node 24, PostgreSQL 18 + TimescaleDB at production's
version, Valkey 7.2), from the commit under test, **before** they are used as E1a / E5 / E9 acceptance baselines
(`VALIDATION` C6). Today's figures are manual 2026-11-09 runs on Node 22 / Valkey 9.

### 6.1 Isolation probe (20/20)

| Step | Procedure |
|---|---|
| 1 | Record versions (`node -v`, `psql --version`, `extversion`, `valkey-server --version`, `git rev-parse HEAD`, OS) into `env.md` |
| 2 | Build `apps/api` and `apps/web` from the commit; start the isolated instance on :4100 / :5174 / :5123… with `REDIS_URL` → private Valkey 7.2 (:6392), `DATABASE_URL` → `veetrax_assess` |
| 3 | Confirm the probe's fixtures exist (tenant A demo company, tenant B "Beta Transport (assessment)", viewer with 3 vehicles, one A document / expense photo / driver event, partner with one allocated customer, A webhook delivery). Pass company / vehicle ids and credentials **through env** (`A_COMPANY_ID`, `B_COMPANY_ID`, `A_VEHICLE_ID`, `*_EMAIL`, `*_PASS`), not the script defaults |
| 4 | Feed live data: `npm run sim -w @veetracer/api -- --count 20` pointed at the instance's GT06 port 5123 (the socket probes need `live:batch` traffic) |
| 5 | Run `npx tsx scripts/tenant-isolation-probe.ts` (BASE_URL `http://localhost:4100/api`) **twice**, the second run after an API restart |
| 6 | **Pass:** both runs PASS 20 / FAIL 0, exit 0. Before G5 is merged, F-1 stays INFO; after G5, F-1 must read PASS, so the post-G5 baseline becomes **21 PASS / 0 FAIL** (see §9 Q13) |

### 6.2 Chaos run (zero loss)

| Step | Procedure |
|---|---|
| 1 | Versions into `env.md` as above. Build `apps/api` (`npm run build`) |
| 2 | Create `veetrax_chaos_test` (name ends in `_test`, required by the harness), `prisma migrate deploy`, `prisma/seed.ts`, `register.ts --count 40 --imei-start 868120009000001` |
| 3 | The harness starts its own Valkey with `wsl -e bash -lc 'valkey-server …'` (`chaos-run.ts` l.80–103), i.e. whatever `valkey-server` the **default** WSL distro has: Valkey 9 today. To run 7.2, either (a) a small harness change adds `--wsl-distro veetrax-test` (code change, under D6 / E1a authorisation), or (b) the private 7.2 build is first on that login shell's `PATH`. The docker mode (`--cache-ctl docker:…`) is not acceptable for the baseline because it cannot run `cache-restart-empty` |
| 4 | Run all ten scenarios with the 2026-11-09 parameters: `CHAOS_DATABASE_URL=… npx tsx scripts/chaos/chaos-run.ts --devices 40 --interval 2 --prolonged-min 11 --out <evidence dir>` (≈ 25 min) |
| 5 | **Pass:** every scenario and the WHOLE RUN row show **Lost 0, Dup rows 0**; health transitions as in `test-evidence.md` §2.1 (503 during cache / DB faults, 200 otherwise); the harness's Valkey uses AOF `everysec` (the post-G4 target). Production runs AOF off until G4; that worst case is covered by `cache-restart-empty` (Valkey wiped), which must also show 0 lost |
| 6 | Run a second time; both runs must pass. Differences in drain time > 2× are noted, not failed |

### 6.3 Evidence format (both)

Dated folder `docs/employee-transport/evidence/<YYYY-MM-DD>-c6-isolation-probe/` and `…-c6-chaos/`, following the
`docs/reliability/evidence/` convention: `results.md` (table as produced; the probe's stdout table copied verbatim),
`results.json` (chaos native; probe: rows transcribed until the script gains a JSON option), `env.md` (versions, commit,
ports, DB / Valkey names), raw logs (`harness.log`, `api.log`, `gateway.log`, `processor.log`, probe stdout). Tokens,
passwords and JWTs redacted (commit `0a92ec5` pattern). One `PROGRESS.md` row per baseline: item · risk · commit ·
"probe 20/20 ×2" / "chaos 0 lost ×2".

---

## 7. Per-gate environment mapping (G1–G8)

| Gate | Item to prove | Tier | Environment details | Evidence |
|---|---|---|---|---|
| G1 | Coordinate mapper unit test | T1 / T2 | — | Jest / node:test output |
| G1 | Road line on the road, 3 shares | T3 | Local GraphHopper three-metro (§2.3), local tiles; shares created in synthetic tenant A for Chennai, Bengaluru, Delhi NCR | Playwright before / after screenshots, 1440 / 390 |
| G1 | After deploy | T5 | One screenshot of a share page on production. Creating a share link is a write: done by the owner or an operator, not by an agent | Screenshot + deploy record |
| G2 | Sweeper / no-XACK logic | T1 / T2 | `api-db` job with Valkey 7.2 container | Jest output |
| G2 | "XADD `vt:notify` fails after alert commit": 100 % notified within 2 min, 0 lost, 0 dup | T3 | New chaos scenario on the private Valkey 7.2 + `veetrax_chaos_test`; existing ten scenarios still 0 lost | Chaos `results.md` / `.json` |
| G3 | Status matches provider outcome | T1 / T2 | Fake providers | Jest output |
| G3 | `SKIPPED` rows with reason | T3 | No provider credentials (I6) | SQL extract from `veetrax_assess` |
| G3 | No new false `SENT` | T5 | Read-only aggregate query on production by the Lead, owner-approved | Query + count |
| G4 | `kill -9` + restart keeps streams and groups; `cache-restart-empty` passes with AOF on; AOF rewrite and disk measured; AOF restore onto a fresh Valkey | **T3**, private Valkey 7.2 only (never the shared server, I2) | `appendonly yes`, `appendfsync everysec` as in the G4 change; 40-device simulator load during the drill | Drill log (`XLEN`, `XINFO GROUPS` before / after), chaos results, `du` of the AOF dir |
| G4 | AOF rewrite at production volume | T4 (if available) | Production-volume stream (`POSITIONS_STREAM_MAXLEN` default 2,000,000) | Rewrite time, disk, latency spike |
| G4 | Applied in production | T5 | Approved maintenance window | `CONFIG GET appendonly` output |
| G5 | Socket closed ≤ 5 s after logout / revoke, 20 / 20 runs | T3 | Isolated instance + simulator traffic | Probe output; Jest gateway test (T2) |
| G6 | Each map service stopped → check raised ≤ 2 min, cleared after restart | T3 | Local GraphHopper :18989, Photon :12322, Martin :13000 are required for this | Logs / screenshots of raise and clear |
| G6 | `release.sh` fails when unhealthy, passes when healthy | T3 (test distro with systemd) | Units from `ops/deploy/linux/` installed in the test distro under a non-production prefix | Dry-run transcript, exit codes |
| G7 | No dump, archive, key or secret in Git | T2 | Hygiene check C-6 | CI log |
| G7 | Backup → restore into empty `veetrax_restore_test`, manifest counts equal | **T3** (non-production host) | Backup of a **synthetic** T3 database made with the reconciled G7 scripts; key generated for the test tier only | Drill log with counts and timings |
| G7 | RTO ≤ 2 h at production volume | T4 | Synthetic data sized to production row counts | Timing log. A drill with a **real** production backup is a separate owner decision (§9 Q7) |
| G7 | Backup freshness WARN after 26 h | T3 | Fake `last-status.json` aged 27 h | Screenshot / log |
| G8 | 0 foreign hosts during 5 min of map use (mobile) | T3 | Android emulator (free), build pointing `EXPO_PUBLIC_SERVER_URL` and `EXPO_PUBLIC_MAP_STYLE_*` at the T3 host; capture with the emulator's built-in `-tcpdump` | Host list summary |
| G8 | 0 requests to `openfreemap.org` (web) | T3 | Web built with `VITE_MAP_STYLE_*` → T3 Martin styles; Playwright HAR of live map + share page | HAR host summary |
| G8 | Production build | T5 | Owner-approved preview build with `https://app.veetrax.com`; map viewing only | Host list, build id, `eas.json` diff |

---

## 8. Access, secrets and data handling

| # | Rule |
|---|---|
| S1 | **No production secrets in any test tier:** no production `.env`, `JWT_SECRET`, database or Valkey passwords, SSH keys to `veetrax-prod`, Razorpay, SMTP / Zoho, Smartping, Arattai, Expo / FCM / APNs credentials, backup encryption keys. Each tier generates its own throwaway `JWT_SECRET` |
| S2 | **No production data in any test tier:** no production dump, export, screenshot of customer data, or copy of production `graph-cache` / `photon_data` is moved to T1–T4. The only data imports are public OSM-derived downloads (Geofabrik, Photon dump, Planetiler sources) |
| S3 | **Env files outside Git:** the root `.gitignore` already ignores `.env` and `.env.*` except `.env.example` (V). Test env files are named `apps/api/.env.assess`, `apps/api/.env.test`, `apps/web/.env.assess` (all ignored), or kept outside the repo under `%USERPROFILE%\.veetrax-test\` and passed with `--env-file`. They are never derived from production files. The examples' public Nominatim and OpenFreeMap defaults must be overridden (I6) |
| S4 | **Suggested `.gitignore` additions** (a separate, owner-approved change, not made here): `*.dump`, `*.sql.gz`, `*.age`, `*.gpg`, `*.pem`, `*.key`, `*.pbf`, `*.pmtiles`, `graph-cache/`, `photon_data/` |
| S5 | **CI:** service-container credentials are throwaway values in the workflow file (`ci-only-not-a-secret` pattern); CI needs **no GitHub secrets** for tests. No CI job may hold credentials to any running environment |
| S6 | **Probe and seed credentials:** pass through env; the script defaults are seed values for the isolated instance only and are not reused anywhere else |
| S7 | **Evidence redaction:** tokens, passwords, JWTs, cookies and IMEIs of real devices (there should be none) redacted before an evidence folder is committed; raw harness output stays under `apps/api/var/` (ignored) |
| S8 | **Synthetic marking:** every generated row carries `synthetic: true` or a "(test)" name; e-mails `@example.test`; phones per §4.1 |
| S9 | **Staging access:** named individuals only, SSH keys, no shared passwords; staging keys never valid on production and vice versa |

---

## 9. Open questions

| # | Question | Recommended default |
|---|---|---|
| Q1 | **C3 staging host** (README C3, updated in E0.5). The C3 default "capped WSL2 for E3–E4" cannot be production-class on this PC (28.8 GB total, AVX present, `.wslconfig` global). Which separate x86 host (≥ 32 GB, AVX hideable) will serve E4 benchmarks and E9? | Separate VM on another physical host before E4 benchmarks; reduced WSL2 profile only for labelled pre-checks. **Unresolved.** |
| Q2 | Lead to supply, read-only from production: Valkey 7.2 patch, TimescaleDB `extversion`, PostgreSQL minor, Java build, `india-latest.osm.pbf` date, `du` of map data | Supply before T3 is built. **Partly answered** by the Lead box (Valkey 7.2.13, TimescaleDB 2.31.0, PostgreSQL 18.6, OpenJDK 21.0.13); the `.pbf` date and `du` figures remain a Lead task (not an owner decision) |
| Q3 | **(README O13)** May a second WSL distro (`Ubuntu-24.04`, `veetrax-test`) be installed on the dev PC, plus a `--wsl-distro` option for `chaos-run.ts`? | Yes (free, isolated from the dev stack) |
| Q4 | **(README O14)** Is `+91 00000 xxxxx` acceptable for synthetic Indian phones (`11` Q9)? | Yes, unless the SMS provider gives a reserved test range |
| Q5 | **(README O15)** Is the GitHub repository private, and does the plan's free Actions quota cover ≈ +1,000 min / month? | Confirm before C-2 / C-5 land; no paid overage |
| Q6 | **(README O15)** Move CI and the dev PC's test processes to Node 24 now (production version)? | Yes, in WP 1a.3 |
| Q7 | **(README L8)** G7: is a restore drill of a **real** production backup required (on a controlled non-production host, then destroyed), or does a synthetic-data drill plus production-volume RTO on staging satisfy G7? | Synthetic drill on T3 + volume timing on T4; real-backup drill only on an owner-controlled host with production-grade access rules |
| Q8 | **(README O18)** Who performs the T5 steps that touch production (G1 share link creation, G3 aggregate query, G8 production build capture)? | The owner or Lead, after each approved deploy; agents never |
| Q9 | G8 builds: EAS cloud (free quota) or local `expo run:android` / `eas build --local`? | Local build for T3; EAS only for the owner-approved production profile |
| Q10 | Photon on T3: is the India dump acceptable on disk, or is a city index worth a Nominatim pipeline? | India dump |
| Q11 | O4 tool approvals relevant here: Playwright, jest-expo + RNTL, k6, a secret scanner | Approve (free, dev-only) |
| Q12 | **E3 burst SLO:** `11` §7 E3 says "Burst SLO met on staging", while `12` §5 makes the whole E3 test gate the `veetrax_assess` run with no staging dependency (and `13` ETR-37 says staging is needed by E3) | Measure the burst on T3 as indicative for E3; staging confirmation moves to E4 prep / E9. **Resolved by the Lead (E0.5):** E3 = T3 indicative; SLO of record on staging at E9 (`12` §5, §12; `13` ETR-37; Lead note in `11` §7) |
| Q13 | **Probe baseline count:** `12` G5 asks for "F-1 → PASS; 20/20 probes still PASS". After G5, F-1 becomes a PASS row, so the probe reports 21 PASS | Define the baseline as "0 FAIL, all 20 original rows PASS, F-1 PASS after G5". **Resolved by the Lead (E0.5):** adopted in `12` G5 / E1a and `14` G5 (21 PASS) |

### 9.1 Contradictions with `11` / `12` found while writing this

> **Lead resolution (E0.5 integration, 2026-11-11):** item 1 → README C3 default changed to a separate host (still
> unresolved), `12` §7, `13` ETR-37 / §2, Lead note in `11` §5.4; item 2 → `12` G4 now requires a private Valkey 7.2 drill
> instance; item 3 → resolved as in Q12; item 4 → resolved as in Q13; item 6 → `12` §2 exit criteria and E1a, `13`
> ETR-46, VALIDATION C6 require re-runs on production versions.

1. `11` §5.4 option B and README C3 default (capped WSL2 `memory=27GB`, `processors=6`) are not feasible on the dev PC
   (V: 28.8 GB host RAM, AVX present, global `.wslconfig`) (Q1).
2. `12` G4 says "on the test instance: `kill -9` Valkey": the isolated instance's Valkey (db 1) shares the server with
   the dev stack's db 0, so the drill must use a private Valkey 7.2 (I2).
3. `11` §7 E3 needs staging for the burst SLO; `12` §5 does not (Q12).
4. `12` G5 "20/20 still PASS" versus 21 PASS rows after the fix (Q13).
5. Not a contradiction but a dependency: G1 requires Bengaluru and Delhi NCR shares, so a Chennai-only routing extract
   (the brief's example) cannot pass it; hence the three-metro extract (§2.3).
6. The chaos and probe baselines that `11` and `12` cite were produced on Node 22 / Valkey 9, not on production versions;
   C6 re-runs must use Node 24 / Valkey 7.2 (§6).
