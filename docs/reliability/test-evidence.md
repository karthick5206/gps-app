# Test evidence: cache outage resilience

Branch `feature/production-cache-reliability`. All tests ran on the local isolated environment:
- Windows 11 host, Node 22.23.4
- WSL PostgreSQL 18, with a scratch database `veetrax_cachechaos_test`
- a **private** Valkey 9.0.4 on 127.0.0.1:6390

The shared Valkey on :6379 and the other databases were not touched.

## 1. How the chaos test works

Script: `apps/api/scripts/chaos/chaos-run.ts`, plus `tcp-proxy.ts`.

```
simulator (40 GT06 devices) ──▶ gateway :15023 ──▶ cache proxy :6391 ──▶ Valkey :6390 (WSL, private)
                                 api :14100 / processor ──▶ PostgreSQL proxy :15432 ──▶ PostgreSQL (WSL, _test DB)
```

- **Real binaries.** It starts the real `dist/` binaries of api, gateway and processor, which are what NSSM runs.
- **Simulated devices.**
  - 40 devices log in as GT06 and send a **0x22 location every 2 s** (about 20 positions/s).
  - These frames get **no ACK from the gateway**, which is exactly the traffic that release 1.5 lost during a cache outage.
  - Each fix has a unique second-resolution `fixTime` per device.
  - The simulator records every fix it wrote to a connected socket.
- **Faults.**
  - `kill -9` of Valkey; Valkey restarted with its AOF; Valkey wiped and started empty.
  - Cache proxy **blackhole** (connections stay open, nothing is delivered until restored; data then arrives late, like TCP retransmission).
  - Cache proxy **cut** (RST, new connections refused).
  - `kill -9` of the gateway or the processor.
  - PostgreSQL proxy cut.
  - Duplicate and out-of-order frames.
  - An 11-minute cache outage.
- **Verification per scenario.**
  - After the fault, the harness waits until the gateway spool is empty and the processor group has lag 0 and pending 0.
  - It then compares the fixes sent during the scenario with the `Position` rows: sent, persisted, lost, extra.
  - It records duplicate rows (the primary key prevents them), stream duplicates dropped by `mid`, the maximum spool size, and the drain time.
  - It records health transitions, sampled every 3 s: `/api/health`, `/api/health/tracking`, gateway `/health`.
  - It records the System Health alert e-mails the API sent (in development they are written to `apps/api/var/mail` and logged).
- **Drain-window fixes.** Fixes sent while the harness waits for the drain belong to the next window. A final **WHOLE RUN** row checks every fix sent during the entire run.
- **Watchdog.** `ops/deploy/windows/veetrax-watchdog.ps1` ran every minute alongside the run (local ports, no NSSM services), sending its alerts through `alert-cli.js`.

Reproduce (on a machine with WSL `valkey-server`):
```
cd apps/api && npm run build
# scratch DB (name must end in _test), migrated + seeded + 40 simulator devices:
DATABASE_URL=<scratch url> npx prisma migrate deploy && npx tsx prisma/seed.ts
npx tsx src/simulator/register.ts --count 40 --imei-start 868120009000001
CHAOS_DATABASE_URL=<scratch url> npx tsx scripts/chaos/chaos-run.ts [--scenarios a,b] [--prolonged-min 11]
# → apps/api/var/chaos/<timestamp>/results.md, harness.log, api.log, gateway.log, processor.log
```

## 2. Results

### 2.1 Full run: all scenarios (2026-11-09 13:58–14:21 UTC, Valkey 9.0.4)

Raw output is in `evidence/2026-11-09-full-run/` (`results.md`, `results.json`, `harness.log`, and the api, gateway and processor logs).

Column notes:
- **Lost** means sent and not in PostgreSQL after the drain.
- **Dup rows** means more than one `Position` row per (device, fixTime); the primary key prevents this.
- **Stream dups dropped** means entries skipped by the processor because their `mid` had already been committed.

| Scenario | Fault | Sent | Persisted | Lost | Dup rows | Stream dups dropped | Max spooled | Drain after the fault ended | `/api/health` | `/api/health/tracking` | gateway `/health` | System Health e-mails (API) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | none, 40 s | 798 | 798 | **0** | 0 | 0 | 0 | 4 s | 200 | 200 OK | 200 ok | — |
| cache-kill | `kill -9` Valkey, 60 s, restart with AOF | 1772 | 1772 | **0** | 0 | 0 | 1233 | 4 s | 200 → **503** → 200 | OK → **503 CRITICAL** → 200 WARN → OK | ok → degraded → ok | "CRITICAL: Valkey is not reachable …"; "2 system issue(s)"; "2 system issues resolved" |
| cache-restart-empty | Valkey shut down, **data wiped**, empty restart after 20 s | 1169 | 1169 | **0** | 0 | 0 | 473 | 18 s (groups recreated on NOGROUP) | 200 → 503 → 200 | OK → 503 CRITICAL → WARN → OK | ok → degraded → ok | "CRITICAL: Valkey is not reachable"; "WARN: 433 positions are buffered on disk at gateway …"; "Resolved: gateway spool" |
| net-blackhole | cache proxy holds all traffic for 45 s (silent partition), then delivers late | 1546 | 1546 | **0** | 0 | **1571** | 807 | 4 s | 200 → 503 → 200 | OK → 503 CRITICAL → WARN → OK | ok → degraded → ok | "CRITICAL: Valkey is not reachable: PING timed out …" |
| net-cut | cache proxy RST + refuses connections, 40 s | 1338 | 1338 | **0** | 0 | 0 | 804 | 10 s | 200 → 503 → 200 | OK → 503 CRITICAL → WARN → OK | ok → degraded → ok | "CRITICAL: Valkey …"; "3 system issue(s) (1 critical)"; "3 system issues resolved" |
| gateway-restart | `kill -9` gateway, restart after 10 s | 751 | 751 | **0** | 0 | 0 | 0 | 4 s | 200 | OK → 503 CRITICAL → OK | ok → **down** → ok | none (10 s gap is shorter than the 15 s heartbeat-stale + 15 s evaluation window) |
| processor-restart | `kill -9` processor, restart after 30 s | 1547 | 1547 | **0** | 0 | n/a (counter reset) | 0 | 6 s | 200 | OK → 503 CRITICAL → OK | ok | "CRITICAL: No processor process is running (no heartbeat)."; "Resolved: processor process" |
| db-interruption | PostgreSQL proxy cut, 60 s | 1951 | 1951 | **0** | 0 | 0 | 0 | 4 s | 200 → **503** → 200 | OK → 503 CRITICAL → OK | ok | "2 system issue(s) (2 critical)" (database unreachable + processor database writes); "2 system issues resolved" |
| dup-ooo | 5 devices send t+1 before t, every frame twice; one stream entry XADDed twice with the same `mid` | 875 | 875 | **0** | **0** | **1** | 0 | 10 s | 200 | OK | ok | — |
| prolonged | `kill -9` Valkey for **11 min** with full traffic | 13180 | 13180 | **0** | 0 | 2 | **12,596** | spool of 12,718 replayed in 8 s; drained 4 s after the 20 s settle | 200 → 503 → 200 | OK → 503 CRITICAL → WARN → 503 CRITICAL → OK | ok → degraded → ok | "2 system issue(s) (1 critical)"; "WARN: 12,539 positions are buffered on disk at gateway …"; "Resolved: gateway spool" |
| **WHOLE RUN** | every fix sent during the 23-minute run, including the warm-up and drain windows | **26,521** | **26,521** | **0** | **0** | 3 | — | — | — | — | — | — |

Observations:
- **No silent loss in any scenario.** Not one of the 26,521 GT06 0x22 fixes, which devices never retransmit, was lost. 16,187 positions went through the gateway spool in this run (gateway log: 3,469 + 12,718 replayed). Release 1.5 would have dropped those positions, counting them only as `enqueueFailures`. In `net-blackhole` some of them also arrived late through the stalled connection.
- **Health was never "OK" while a dependency was down.**
  - `/api/health` returned 503 during every cache and database fault, and 200 otherwise, including during gateway and processor restarts. Those are tracking problems, not API readiness problems.
  - `/api/health/tracking` returned 503 CRITICAL for every fault. It passed through WARN while the spool drained ("positions buffered on disk").
- **Gateway kept serving devices.** During cache outages the gateway reported `degraded`, not `failing`: devices stayed connected and positions were safe on disk. No device connection was dropped by the gateway.
- **Ordering was preserved.** In `dup-ooo`, the live state (`vt:live:*`) of all 5 out-of-order devices ended on their **newest** fix ("OK (newest fix)" in the notes). Duplicates collapsed to one row per fix.
- **Blackhole duplicates.** `net-blackhole` produced 1,571 duplicate stream entries. During a silent partition the cache connection still looks `ready`, so XADDs were written into the stalled socket, timed out after 5 s, and were spooled. When the network came back, the held XADDs were applied **and** the spool was replayed. The processor dropped every repeat by `mid`: no duplicate rows, no duplicate alerts. This is the designed behaviour for an ambiguous timeout.
- **Recovery from an empty restart.** In `cache-restart-empty`, the cache came back with no stream, no consumer group and no live state. The processor logged "Consumer group processor missing (cache data lost); recreating it" and recovered without a restart. Before this branch it would have looped on `NOGROUP` until restarted by hand.
- **Prolonged outage.** 12,596 positions waited on disk at peak. After Valkey returned, replay at the 2,000/s cap emptied the spool in about 8 s (gateway log: "Spool replay caught up (12718 replayed since start)").

### 2.2 Watchdog during the full run

`veetrax-watchdog.ps1` ran every minute against the same ports, with a 5-minute cooldown. Alerts went through `alert-cli.js` and were written to `var/mail` in development. Excerpt (local time = UTC−5):

```
08:59:45 ALERT API not ready (database or cache unusable)
08:59:46 ALERT Gateway spooling positions to disk (433 pending) | cache unavailable: positions are spooled to disk
09:00:47 ALERT Resolved: api:ready
09:00:47 ALERT Resolved: gateway:degraded
09:07:55 ALERT API not ready (database or cache unusable) | database ok=False Please make sure your database server is running at `127.0.0.1:15432`.; cache ok=True
09:07:56 ALERT GPS tracking pipeline CRITICAL | - PostgreSQL is not reachable from the API: …
09:08:57 ALERT Resolved: api:ready / Resolved: tracking:critical
09:10:58 ALERT API not ready … cache ok=False cache connection is reconnecting
09:10:59 ALERT GPS tracking pipeline CRITICAL | - Valkey is not reachable …
09:10:59 ALERT Gateway spooling positions to disk (949 pending)
09:16:04 … repeated after the cooldown (6746 pending) … 09:21:11 (12558 pending)
```

Notes on the watchdog run:
- **Body parsing.** The first two "API not ready" alerts show empty details. Windows PowerShell 5.1 had already consumed the 503 body. The fix (read `ErrorDetails`) went in during the run, and the database and cache details appear from 09:07 onwards.
- **Event log.** Writing to the event log needs administrator rights. It failed in this unprivileged test and is caught; on the server the task runs as SYSTEM.
- **Short outages.** A once-a-minute watchdog does not see a 10-second gateway restart; NSSM restarts the gateway itself.

### 2.3 Confirmation run on the final commit (14:22–14:31 UTC)

After the full run, the spool replay was hardened: corrupt lines are skipped without blocking, records larger than the read chunk are read whole, and reads use 256 KB steps. The alert text was also updated. `dist/` was rebuilt and the scenarios that exercise the spool were run again. Raw output is in `evidence/2026-11-09-confirm-run/`.

| Scenario | Sent | Persisted | Lost | Dup rows | Stream dups dropped | Max spooled | Drain | `/api/health` | `/api/health/tracking` | gateway `/health` | System Health e-mails |
|---|---|---|---|---|---|---|---|---|---|---|---|
| cache-kill (60 s) | 1762 | 1762 | **0** | 0 | 0 | 1232 | 6 s | 200 → 503 → 200 | OK → 503 CRITICAL → WARN → OK | ok → degraded → ok | "CRITICAL: Valkey is not reachable … Gateways spool positions to disk and replay them …"; "WARN: 1,152 positions are buffered on disk …" |
| net-blackhole (45 s) | 1542 | 1542 | **0** | 0 | 1560 | 795 | 4 s | 200 → 503 → 200 | OK → 503 CRITICAL → WARN → OK | ok → degraded → ok | "CRITICAL: Valkey is not reachable …" |
| gateway-restart (`kill -9`, 10 s) | 745 | 745 | **0** | 0 | 0 | 0 | 4 s | 200 | OK → 503 CRITICAL → OK | ok → down → ok | "CRITICAL: gateway … has not reported for 17 s (hung or stopping)."; "Resolved: gateway heartbeat" |
| dup-ooo | 875 | 875 | **0** | 0 | 1 | 0 | 6 s | 200 | OK | ok | — (live state on the newest fix for all 5 devices) |
| prolonged (3 min) | 4047 | 4047 | **0** | 0 | 0 | 3416 | 4 s | 200 → 503 → 200 | OK → 503 CRITICAL → OK | ok → degraded → ok | "CRITICAL: Valkey is not reachable …" |
| **WHOLE RUN** | **9,699** | **9,699** | **0** | **0** | 1561 | — | — | — | — | — | — |

### 2.4 What the tests do not cover

- **Real devices.** The simulator stands in for devices.
  - In the gateway-restart scenario, the simulator never wrote while disconnected, and every frame it wrote before the kill had been read.
  - A real GT06 device that sends a location frame in the instant the gateway process dies can still lose that one frame. Nothing is ACKed for it, and the bytes sat in the dead process's socket buffer. This is inherent to un-ACKed protocols and is unchanged.
  - Real devices also differ in how much they buffer while offline.
- **Production hardware.** Windows Server 2016 and Memurai were not available. The NSSM policy script and the watchdog were syntax-checked, and the watchdog was exercised against local ports. `install-reliability.ps1` has not been run anywhere, since it changes services.
- **Disk-full spool.** Covered by unit tests only, with a small cap: the positions are refused and counted as `notAcked`, and the health status is `failing`.


## 3. Suites

Run on the final branch on 2026-11-09, after `npm run build -w packages/shared`.

| Suite | Command | Result | Baseline on `b73547c` |
|---|---|---|---|
| API jest | `cd apps/api && npx jest` | **1103 passed, 25 skipped** (119 suites passed, 4 skipped) | about 1072 passed / 25 skipped, as given in the brief |
| Web tests | `cd apps/web && npm test` | **154 passed**, 0 failed | — |
| Web typecheck | `cd apps/web && npx tsc -b --noEmit` | exit 0 | — |
| API typecheck | `cd apps/api && npx tsc --noEmit -p tsconfig.json` | exit 0 | — |
| Shared typecheck | `cd packages/shared && npx tsc --noEmit` | exit 0 | — |
| PowerShell scripts | `[Parser]::ParseFile` on `veetrax-watchdog.ps1`, `install-reliability.ps1`, `deploy-release.ps1` | 0 parse errors | — |

The 31 new jest tests are:
- `gateway/spool/position-spool.spec.ts` (9): durability, restart, torn tail, cap, rotation, corrupt line, large record.
- `gateway/spool/position-publisher.spec.ts` (9): direct, spooling, draining, ordering, partial pipeline, timeout, spool full, restart replay, backpressure, backoff.
- `gateway/tcp-server.spec.ts` (+2): during a cache outage, the GT06 alarm is still ACKed and un-ACKed 0x22 positions are spooled and replayed in order. The Teltonika record ACK is sent from the spool and the connection stays open.
- `monitoring/tracking-health.spec.ts` (11): tracking checks; one CRITICAL instead of a cascade when the cache is down; the public tracking body is scrubbed; gateway local health; `mid` parsing; `RecentIds`.

All existing tests pass unchanged, including the Q-01 engine-stop tests and the "XADD failure withholds the ACK" tests. Those now run through the spool-less publisher, which is the `GATEWAY_SPOOL=off` behaviour.

**`cache-copy.ts` check.** Copying from the private Valkey after a chaos run to a second private instance moved 121 keys: 40 live strings, 40 track strings, 40 alert-state strings and 1 set. All 40 TTL keys kept their TTL, and the values were identical. A second run copied 0 keys (121 already present), which shows it never overwrites.
