# Valkey sizing: what the 2 GB VM actually needs

Measured on 2026-11-09 with `apps/api/scripts/cache-sizing.ts` against the kit's Valkey 9.1.3 (`ops/valkey`, test container, TLS + ACL).
- **Stream entries:** 200,000 entries were added per sample, and the `used_memory` delta was divided by that number. The template was a real gateway entry copied from `vt:positions` after the chaos run.
- **Tracked objects:** `MEMORY USAGE` of the live, track and alert-state keys of the 40 simulated vehicles.

| Item | Measured | Notes |
|---|---|---|
| One `vt:positions` entry, GT06 location | **458 bytes** | the position JSON is 377 B, plus `remote`, `mid` and the stream overhead |
| One entry, Teltonika with 30 IO attributes | **531 bytes** | heavier devices |
| Per tracked vehicle (`vt:live` 976 B + `vt:track` 272 B + `vt:alertstate` 112 B) | **1,360 bytes** | add a few hundred bytes for fuel or AC/door sensors where configured |
| Empty server plus the app's other keys (health, locks, command state) | about 4 MB | `used_memory` after the test |

## What that means

| Scenario | Memory |
|---|---|
| Stream at 1,000,000 entries | GT06: **437 MB** |
| Stream at the default cap `POSITIONS_STREAM_MAXLEN` = 2,000,000 | GT06: **874 MB**; Teltonika-heavy: **1,013 MB** |
| Backpressure point: the gateway starts spooling at 80% of the cap = 1,600,000 entries | GT06: **700 MB**; Teltonika-heavy: **810 MB** |
| Live state for 1,000 vehicles / 10,000 vehicles | **1.3 MB / 13 MB** |
| `vt:notify`, `vt:webhooks`, `vt:driver-media` streams | small (capped, mostly empty) |

**How it fits in the 2 GB VM:**
- **Stream length.** The stream is trimmed only at the cap, so in steady state it holds up to `POSITIONS_STREAM_MAXLEN` entries even when everything is processed. Plan for the full cap.
- **Memory limit.** `maxmemory 1gb` (kit default) with `noeviction` holds the GT06 stream up to the 1.6 M backpressure point (about 700 MB) plus live state with about 300 MB to spare.
  - At the backpressure point, the gateway stops adding entries and spools to disk until the processor catches up. A memory-full error never loses data either: the XADD fails and the gateway spools.
  - For a Teltonika-heavy fleet, the full 2 M stream (about 1 GB) would reach maxmemory. Lower `POSITIONS_STREAM_MAXLEN` to **1,500,000** (about 800 MB worst case) in `C:\apps\veetracer\app\apps\api\.env`.
- **Spare RAM for the OS.** The other ~1 GB of the VM covers Ubuntu itself (about 150–250 MB), the copy-on-write pages of the AOF rewrite and RDB fork, and the page cache. Fork copy-on-write grows only with writes made during the rewrite, which takes seconds at VeeTrax's write rates.
- **Disk.** RDB and AOF on disk are at most about the dataset size (around 1 GB). Seven days of local backups of compressed RDB plus AOF archives are well inside 20 GB.

**How long the stream cap lasts if the processor stops** (time to fill 2 M entries):

| Fleet traffic | Time |
|---|---|
| 1,000 devices, one fix every 10 s (100/s) | about 5.5 h |
| 3,000 devices at 10 s (300/s) | about 1.9 h |

After that, the gateway spool (1 GB, about 3 million positions) takes over.

**Gateway spool and replay.**
- These cost **no Valkey memory** beyond the stream entries they produce.
- Replay feeds the same stream at up to 2,000 entries/s and pauses while the backlog is above the backpressure point.
- In the gateway process, replay holds one batch of 500 records (about 170 KB).

**Conclusion.** 2 vCPU / 2 GB / 20–40 GB SSD is sufficient for the current fleet and for growth to about 10,000 vehicles. CPU was not measured separately. At VeeTrax's rates (hundreds of operations per second), against Valkey's capacity of tens of thousands per core, it is not a constraint. Move to 4 GB only if `POSITIONS_STREAM_MAXLEN` has to go above about 2 million entries.
