# Cache assessment: replacing Memurai Developer Edition

Date: 2026-11-09. Branch `feature/production-cache-reliability`, based on release 1.5 (`b73547c`).
Line numbers refer to this branch.

Related documents:
- [ingestion-reliability.md](ingestion-reliability.md): spool, ACKs, health, alerts
- [test-evidence.md](test-evidence.md): chaos and compatibility results
- [production-rollout.md](production-rollout.md): deployment, cut-over and rollback

## 1. Summary

- **Why it stops.** Memurai Developer Edition stops itself after 10 days by design. It may not be used in production (quotes in §4). The outages are a licensing limit, not a fault. Restarting it on a schedule would only work around the licence, so we don't.
- **What it is used for.** VeeTrax uses the cache as a message bus (Streams with consumer groups, including `XAUTOCLAIM` and `XINFO GROUPS` lag), for Pub/Sub, for Lua scripts and for TTL state. Any replacement must implement Redis **7.0** semantics: `XINFO GROUPS` `lag`/`entries-read` need 7.0, and `XAUTOCLAIM`, `LPOP` with a count, and `SET … GET` need 6.2.
- **Valkey: fully supported, verified.** The application's own test suites and the chaos tests ran against **Valkey 9.0.4**; see [test-evidence.md](test-evidence.md).
- **Garnet: not usable.** Microsoft's own compatibility table marks every stream command unsupported.
- **Old Redis-on-Windows ports: not usable.** They stop at Redis 5 and lack `XAUTOCLAIM`, `LPOP` with a count, `SET … GET` and the 7.0 `XINFO` fields.
- **Recommendation: self-hosted Valkey 9.x on a small Linux VM**, preferably in the same data centre as the Windows server, on a private network. It costs roughly ₹650–1,700 per month, depending on the provider (§6).
  - **Fallback:** Memurai Enterprise on the existing server. The price is quote-only, and the Memurai **4.x** line reaches end of life on **30 Nov 2026**.
- **What release 1.6 changes, whichever cache is chosen.** A cache outage no longer loses positions: the gateway spools them to disk and replays them. Health turns red, and alerts fire.

## 2. Command and feature inventory

All keys live under the `vt:` prefix (`apps/api/src/redis/keys.ts`). Every process connects with `REDIS_URL`, which defaults to `redis://localhost:6379`. No database index is selected, so everything is in DB 0. There is no `SELECT`, no `KEYS`, no `keyPrefix` and no cluster mode.

### 2.1 Streams and consumer groups

| Stream | Producer(s) | Consumer group(s) | Cap |
|---|---|---|---|
| `vt:positions` | gateway `gateway/spool/position-publisher.ts:197` (pipelined `XADD … MAXLEN ~ N * data … remote … mid …`), mobile tracker `mobile-tracker/mobile-tracker.service.ts:516` | `processor` (`processor/stream-consumer.ts`), `relay` (`relay/relay-worker.service.ts`) | `POSITIONS_STREAM_MAXLEN`, default 2,000,000 |
| `vt:notify` | `alerts/notify-queue.service.ts:49,54`, `alerts/offline-alerts.service.ts:196,244`, `attendance/attendance.service.ts:743`, `documents/reminders.service.ts:115`, `processor/rules/rules-engine.ts:137` | `notifier` (`notifier/notifier.service.ts`) | `NOTIFY_STREAM_MAXLEN` |
| `vt:webhooks` | `webhooks/events.ts:107,116` | `webhooks` (`webhooks/webhook-worker.service.ts`) | `WEBHOOKS_STREAM_MAXLEN` |
| `vt:driver-media` | `gateway/media/media-sink.ts:56` | `driver-media` (`driver-events/driver-event-worker.service.ts`) | `STREAM_MAXLEN` |

| Command | Where (file:line) | Minimum Redis version / notes |
|---|---|---|
| `XADD key MAXLEN ~ n * f v …` | listed above | 5.0 |
| `XGROUP CREATE key group 0\|$ MKSTREAM` | `processor/stream-consumer.ts:150`, `notifier/notifier.service.ts:148`, `webhooks/webhook-worker.service.ts:100`, `driver-events/driver-event-worker.service.ts:165`, `relay/relay-worker.service.ts:61`, `redis/stream-groups.ts:15` | 5.0. `MKSTREAM` and the `BUSYGROUP` error string are relied on. |
| `XGROUP SETID key group $` | `relay/relay-worker.service.ts:80` | 5.0 |
| `XREADGROUP GROUP g c COUNT n [BLOCK ms] STREAMS key 0\|>` | `processor/stream-consumer.ts:161-162`, `notifier/notifier.service.ts:182-183`, `webhooks/webhook-worker.service.ts:137-138`, `driver-events/driver-event-worker.service.ts:182-183`, `relay/relay-worker.service.ts:102` | 5.0. **Blocking read** of 1–5 s. Reading id `0` re-reads the consumer's own pending entries after a restart. |
| `XACK key group id…` | `processor/position-processor.ts:207`, `notifier/notifier.service.ts:227`, `webhooks/webhook-worker.service.ts:161`, `driver-events/driver-event-worker.service.ts:197`, `relay/relay-worker.service.ts:118` | 5.0 |
| `XAUTOCLAIM key group consumer min-idle start COUNT n` | `processor/stream-consumer.ts:172`, `notifier/notifier.service.ts:190`, `webhooks/webhook-worker.service.ts:144`, `driver-events/driver-event-worker.service.ts:176` | **6.2**. The 7.0 three-element reply (deleted ids) is tolerated, because only `[0]` and `[1]` are read. |
| `XPENDING key group` (summary) and `XPENDING key group - + 1` (extended) | `processor/stream-consumer.ts:208`, `summarizer/late-detector.ts:83`, `monitoring/system-health.service.ts:255` | 5.0 |
| `XINFO GROUPS` (`lag`, `entries-read`, `pending`) | `processor/stream-consumer.ts:223`, `summarizer/late-detector.ts:72`, `monitoring/system-health.service.ts:253`, `gateway/spool/position-publisher.ts:283` | `lag`/`entries-read` need **7.0**. Below 7.0 the code falls back to heartbeat numbers (`fallbackLag`). |
| `XINFO STREAM` (`length`, `entries-added`), `XINFO CONSUMERS` | `monitoring/system-health.service.ts:252,254` | `entries-added` needs 7.0 |
| `XRANGE key - + COUNT n` | `summarizer/late-detector.ts:103,128` | 5.0 |

### 2.2 Pub/Sub

All of it is `SUBSCRIBE` on dedicated connections; there is no `PSUBSCRIBE`. Messages are published with `PUBLISH` (28 call sites).

- **Channels:**
  - `vt:live:updates`
  - `vt:cache:invalidate`
  - `vt:rules:invalidate`
  - `vt:alerts`
  - `vt:alerts:state`
  - `vt:cmd:gw:<gatewayId>` (device commands to the gateway)
  - `vt:cmd:updates`
  - `vt:video:gw:<id>`
  - `vt:video:replies`
  - `vt:snap:gw:<id>`
  - `vt:relay:invalidate`
  - `vt:health:updates`
- **Subscribers:**
  - `redis/redis.service.ts:24`
  - `processor/main.ts:40`
  - `summarizer/main.ts:46`
  - `gateway/main.ts:168,189,201`
  - `relay/sync.ts:32`
  - `live/live.gateway.ts:79`
  - `commands/commands.service.ts:72`
  - `alerts/offline-alerts.service.ts:45`
  - `notifier/main.ts:21`
  - `video/video.service.ts:80`
  - `relay/relay-worker.service.ts:68`
- **Delivery.** Pub/Sub is fire-and-forget. Nothing durable depends on it: commands are also written to `vt:cmd:state:*`, and the engine-stop rules (Q-01) are enforced at the gateway.

### 2.3 Lua scripts (`EVAL`, no `EVALSHA`/`SCRIPT LOAD`, no `FUNCTION`)

| Script | Where | Commands inside |
|---|---|---|
| Lock release: delete the key if the value matches | `attendance/attendance.service.ts:47`, `documents/reminders.service.ts:13`, `licences/licence-reminders.service.ts:13`, `report-schedules/report-scheduler.service.ts:10`, `retention/retention.service.ts:11`, `summarizer/main.ts:15` | `GET`, `DEL` |
| Compare-and-set of live state | `redis/keys.ts:111` (used by `live/offline-sweeper.service.ts:90`) | `GET`, `SET` |
| Customer-API rate limit | `developer/rate-limit.ts:7` (called at `:54`) | `INCR`, `EXPIRE` |

### 2.4 Transactions and pipelines

- **`MULTI`/`EXEC`** (10 call sites), with no `WATCH`:
  - command re-queue in `gateway/main.ts:161-165` and `commands/commands.service.ts:359`
  - command state plus publish in `gateway/tcp-server.ts:470-474`
  - heartbeat in `monitoring/heartbeat.ts:92-96`
  - login lockout in `auth/auth.service.ts:65`
  - health store in `monitoring/system-monitor.service.ts:155-160` and `monitoring/system-health.service.ts:334`
- **Pipelines** (12 call sites): the position XADDs, live-state publish (`processor/position-processor.ts:599-606`), fuel, IO and alert state, purge and transfer.

### 2.5 Keys, TTLs and data types

| Pattern | Type | TTL | Purpose |
|---|---|---|---|
| `vt:live:<objectId>`, `vt:track:<objectId>` | string (JSON) | none | latest position / status and filter state of each vehicle (processor-owned) |
| `vt:live:company:<id>` | set | none | objects with live state per company (`SCAN MATCH vt:live:company:*` in `live/offline-sweeper.service.ts:113`) |
| `vt:alertstate:*`, `vt:fuel:*`, `vt:io:*` | string | 7 days (`EX`) | rules / fuel / AC-door detector state |
| `vt:conn:<uniqueId>` | string | 300 s (`EX`) | which gateway a device is connected to |
| `vt:cmd:queue:<uniqueId>` | list | `COMMAND_TTL_HOURS` (`RPUSH`, `EXPIRE`, `LPOP key 20` (**6.2**) at `gateway/tcp-server.ts:484`) | commands for offline devices. Safety-critical ones are never delivered late (Q-01). |
| `vt:cmd:state:<id>` | string | 7 days | last command update |
| `vt:estop:*` | string | minutes (`EX`, `KEEPTTL` (**6.0**) at `commands/commands.service.ts:273`, `SET NX`) | engine-stop preparation, single use, rate limit (`INCR`+`EXPIRE`) |
| `offlineKey(objectId)` | string | `SET … EX … GET` (**6.2**) at `alerts/offline-alerts.service.ts:88` | offline-alert episode claim |
| `vt:auth:fail:<email>` | string | `INCR` + `EXPIRE` | login lockout |
| job locks (`vt:*:lock`) | string | `SET NX PX` | single-instance schedulers |
| `vt:health:*` | string / zset / list / hash | 20 s heartbeats (`ZADD`, `ZRANGE`, `ZREMRANGEBYSCORE`, `ZREM`), `LPUSH`+`LTRIM` series, `HSET`/`HGETALL`/`HVALS` | System Health |
| `vt:relay:rules`, `vt:wh:companies` | string / set (`SADD`, `SREM`, `SMEMBERS`, `SISMEMBER`) | none | forwarding rules, webhook companies |
| routing / geocode / video caches | string | `EX` | caches that can be rebuilt |

Other commands in use:
- `MGET`
- `GET`/`SET`/`DEL`
- `EXISTS`
- `SCAN … MATCH … COUNT`
- `INFO` (memory, persistence, clients and stats sections, parsed in `monitoring/system-health.service.ts:445`)
- `PING`

`TYPE` (`monitoring/system-health.controller.ts:209`) is an Express call, not a cache command.

### 2.6 Connections, retries, blocking reads

| Connection | Options | Behaviour while the cache is down |
|---|---|---|
| API `RedisService.client` (`redis/redis.service.ts:15`) | `maxRetriesPerRequest: 3`, offline queue on | commands fail after 3 reconnect attempts; health probes use timeouts |
| gateway positions (`gateway/main.ts:58`) **new** | `enableOfflineQueue: false`, `maxRetriesPerRequest: 1`, `commandTimeout: 5000`, exponential reconnect with jitter capped at 5 s | `XADD` fails immediately and the positions go to the disk spool. Nothing is queued in memory, so nothing is applied late. |
| gateway other connections (`gateway/main.ts:53,108,136,186,197`) | defaults (20 retries, offline queue) | setup steps retry in the background (`untilCacheUp`). Device listeners no longer wait for the cache. |
| processor / summarizer (`processor/main.ts:24`, `summarizer/main.ts:40`) | `maxRetriesPerRequest: null` | waits for the cache. Batches retry with backoff of 1–30 s. |
| subscribers | defaults | ioredis re-subscribes after a reconnect |

### 2.7 Persistence expectations

- **What the cache holds that matters.** Unprocessed stream entries, plus live and detector state.
- **Settings.** System Health warns when `appendonly` is off (`monitoring/checks.ts`, `valkey.aof`). Recommended: `appendonly yes`, `appendfsync everysec`, `maxmemory-policy noeviction`. Eviction would silently drop stream entries or state.
- **Positions don't depend on cache persistence.** Since release 1.6, a cache that comes back **empty** is tolerated for positions:
  - every consumer group is recreated on `NOGROUP` (`redis/stream-groups.ts`);
  - the gateway spool covers the outage itself.
- **What an empty restart still loses** is in-flight unprocessed stream entries and live/detector state. Vehicles reappear on the live map with their next fix.

## 3. Compatibility matrix

| Requirement | Memurai Dev / Enterprise | Valkey 9.x (Linux) | Microsoft Garnet | Redis-on-Windows ports (tporadowski 5.0.14) |
|---|---|---|---|---|
| Streams + consumer groups | yes ("Redis 7 API"; the marketing site says 8.2) | **yes: tested** | **no**: XADD, XREADGROUP, XGROUP, XACK, XAUTOCLAIM, XPENDING, XINFO and XLEN all listed as unsupported | Redis 5: yes |
| XAUTOCLAIM (6.2), LPOP count (6.2), SET GET (6.2), XINFO lag (7.0) | yes per vendor claim (not individually documented) | **yes: tested** | no (streams) | **no** (5.0) |
| Lua EVAL, MULTI, Pub/Sub, SET NX PX, ZSET/HASH/LIST | yes | yes | yes | yes |
| Runs on Windows Server 2016 | yes (Windows 10 / Server 2012+) | no (Linux VM) | yes (.NET 10 supports Server 2016) | yes, but unmaintained |
| Production licence | Enterprise only | BSD-3-Clause | MIT | BSD, but archived |

Garnet source: <https://microsoft.github.io/garnet/docs/commands/api-compatibility>, accessed 2026-11-09. Stream support exists only as an open draft PR (microsoft/garnet#1461, "[DRAFT] Stabilizing Streams"). Garnet is therefore excluded. The old Windows ports are excluded on version grounds; they also no longer receive security fixes.

**Valkey verification (this branch).**
- **Unit suites.** The API jest suite and the new spool / tracking suites pass. They mock the cache, so they prove logic, not the server.
- **Chaos run.** The **real** api, gateway and processor binaries ran against **Valkey 9.0.4**, exercising every stream command above, Pub/Sub, Lua locks, MULTI and INFO, through 10 fault scenarios. Results are in [test-evidence.md](test-evidence.md).
- **Version gap.** Production would run Valkey 9.1.x, the latest stable (9.1.3, 26 Oct 2026). The command set used here is unchanged between 9.0 and 9.1.

## 4. Licensing: Memurai Developer Edition in production

All pages accessed 2026-11-09.

- <https://www.memurai.com/get-memurai>:
  - "Usage of Memurai Developer Edition in a production environment is prohibited."
  - "Requires a restart after 10 days."
  - The edition table reads "10 days before automatic shutdown" for Developer and "Unlimited" for Enterprise.
  - Developer is also limited to "10 unique IP addresses" and "50% of available system memory".
  - Enterprise is "Intended for Production use with no restrictions or limitations."
- <https://www.memurai.com/faq>:
  - Developer is "licensed for development and/or test systems in a non-production environment."
  - It "has a maximum uptime of 10 days. After 10 days, Memurai will shut down and will need to be restarted."
- <https://docs.memurai.com/en/config-license>:
  - "The installer is bundled with a license file that allows to run Memurai in a development environment … Enterprise licenses are available for production use."
- <https://docs.memurai.com/en/product-lifecycle>:
  - "4.x | March 2023 | **November 30, 2026**"
  - 5.x: "TBD (2025)".
  - Check which version production runs (`memurai-cli INFO server`). A 4.x install is out of support in three weeks.

**Conclusion.** Running the Developer Edition on `server-mintplus-windows` is not permitted by Memurai's own terms. The 10-day stop is the designed enforcement. We do **not** schedule restarts to work around it; the watchdog only alerts on a stopped cache service.

## 5. Options

### (a) Memurai Enterprise on the existing Windows server
- **Pros.**
  - No new machine.
  - Same `REDIS_URL` (localhost), so sub-millisecond latency.
  - No network exposure.
- **Cons.**
  - The price is not published: <https://www.memurai.com> offers only "Contact us" and "Try Enterprise". A sales quote is needed.
  - It keeps the cache on a 4 GB box that already runs PostgreSQL and five Node processes.
  - Windows Server 2016 extended support ends **13 Jan 2027** (<https://learn.microsoft.com/en-us/lifecycle/products/windows-server-2016>), so the stack needs a new OS within two months anyway.
  - The vendor version story is inconsistent: the docs say "Redis 7 API", the site says "8.2", and the 4.x line reaches end of life on 30 Nov 2026.
- **Resources.**
  - Today's working set is small: the stream is capped at 2 M entries of about 300–400 B each, so roughly 1 GB worst case, plus live state of a few MB.
  - Set `maxmemory` to 1 GB with `noeviction`.

### (b) Valkey on a separate small Linux VM (recommended)
- **Software.** Valkey 9.1.x (BSD-3-Clause, <https://github.com/valkey-io/valkey>; no Windows builds). Debian/Ubuntu packages or the official tarball.
- **Sizing.**
  - 1–2 vCPU and 2 GB RAM, which allows `maxmemory 1gb` plus AOF rewrite headroom.
  - 20–40 GB SSD.
  - CPU need is tiny: the current load is a few hundred ops/s.
- **Network.** This decides the choice.
  - **Same data centre, private VLAN** (ask Mintplus / Lease Packet, Jaipur, which owns 166.0.242.0/24 per ARIN RDAP): under 1 ms RTT. Bind to the private IP and use a password/ACL. Best option.
  - **Another provider in India** (AWS Mumbai, DigitalOcean Bangalore, Azure Central India): traffic crosses the public internet.
    - Estimated 15–40 ms RTT from Jaipur. This is a distance-based estimate, not measured; measure before deciding.
    - Requires TLS (`tls-port`, `rediss://` in `REDIS_URL`) or a WireGuard tunnel, plus a firewall allow-list for the server's IP.
    - The pipeline tolerates the latency: the gateway pipelines XADDs, and the processor makes about 6 round trips per batch of up to 500.
    - API requests that touch the cache would gain one RTT per call. Live map, auth lockout and rate limiting each take one or two.
  - Any network failure is now absorbed by the gateway spool and alerted (tested in `net-blackhole` and `net-cut`).
- **Pros.**
  - Free licence.
  - Fully verified.
  - Moves memory pressure off the 4 GB Windows box.
  - Independent of the Windows Server 2016 end of life.
- **Cons.**
  - One more machine to patch and monitor.
  - Network dependency.

### (c) Windows-native alternatives checked
- **Microsoft Garnet**: excluded (no streams, see §3).
- **Redis-on-Windows ports**: excluded (Redis 5, unmaintained).
- **Valkey or Redis in WSL2 / Docker Linux containers**: not available on Server 2016 (no WSL2; Linux containers (LCOW) were never production-supported there).
- **A Hyper-V Linux guest on the same 4 GB server**: technically possible but not advisable, because there is no spare RAM.

## 6. Cost comparison (monthly, INR, excluding GST)

Exchange rate: $1 = ₹93.76 (Wise mid-market, accessed 2026-11-09). All prices are from official pages accessed 2026-11-09.

| Option | Plan | Official price | ≈ INR / month |
|---|---|---|---|
| Memurai Enterprise | per server | **not published; quote required** | ? |
| AWS Lightsail, Mumbai | 2 vCPU / 1 GB / 40 GB | $7 (<https://aws.amazon.com/lightsail/pricing/>) | ₹656 |
| AWS Lightsail, Mumbai | 2 vCPU / 2 GB / 60 GB | $12 | ₹1,125 |
| DigitalOcean Basic | 1 vCPU / 2 GiB | $12 (<https://www.digitalocean.com/pricing/droplets>; BLR1 price assumed equal, not stated on the page) | ₹1,125 |
| DigitalOcean Basic | 2 vCPU / 2 GiB | $18 | ₹1,688 |
| Azure B1ms, Central India (Linux) | 1 vCPU / 2 GB | $0.0224/h × 730 h (Azure Retail Prices API) | ≈ ₹1,533, plus disk and public IP |
| Mintplus / Lease Packet, same DC | small Linux VPS + private VLAN | **not found online; request a quote** | ? |

There is no licence cost for Valkey. Backups (an AOF snapshot copied off-box) fit into the existing nightly backup job.

## 7. Recommendation

1. **Now:** deploy release 1.6 (this branch) on the current Memurai. With it, a Memurai stop no longer loses positions and turns health red, and the watchdog alerts. This is **not** a licence fix; it limits the damage until the cut-over.
2. **Within 2–3 weeks:** provision **Valkey 9.1.x on a 2 GB Linux VM**.
   - First choice: in Mintplus's data centre on a private network.
   - Otherwise: AWS Lightsail Mumbai 2 GB (₹1,125/month) with TLS.
   - Then cut over using the zero-loss procedure in [production-rollout.md](production-rollout.md).
3. **If a Linux VM is not acceptable:** buy Memurai Enterprise. Get the quote first, and confirm the version is 5.x or newer, not end-of-life 4.x.
4. **Plan the Windows Server 2016 replacement** (end of life 13 Jan 2027). A Linux host for the whole stack would make Valkey local again.

Migration plan, cut-over and rollback: [production-rollout.md §3–§5](production-rollout.md).
