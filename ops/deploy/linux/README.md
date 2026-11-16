# Ubuntu production deploy files

| File | What |
|---|---|
| `install-ubuntu.sh` | First install (root): packages, PostgreSQL + TimescaleDB, Valkey, Caddy, Java, the `veetrax` user, systemd units, firewall |
| `release.sh` | Every release (as `veetrax`): checkout, build, migrate, seed, restart, **health gate** |
| `health-gate.sh` | The post-deploy health gate; `release.sh` runs it, and it can run on its own |
| `veetrax-*.service` | systemd units of the five app processes |
| `Caddyfile` | HTTPS, `/api`, `/socket.io`, tiles, web app |
| `maps/` | Self-hosted GraphHopper, Photon and Martin ([maps/README.md](maps/README.md)) |
| `test/` | Local tests of the scripts with stubs (no root, no real services) |

## API network binding (`API_HOST`, E4 salvage)

From the release that carries it, the API listens on **127.0.0.1** when `NODE_ENV=production` and `API_HOST` is unset
(`apps/api/src/config/api-host.ts`). Development and tests keep Node's default (every interface). Explicit values:
`loopback`, a private or WireGuard address, `0.0.0.0` / `::` (Docker Compose sets `0.0.0.0`). Host names are refused.

Compatibility with the files in this folder (checked, nothing here changes):

| Consumer | Target | Result |
|---|---|---|
| `Caddyfile` `/api/*`, `/socket.io/*` | `reverse_proxy 127.0.0.1:4000` | works: same address |
| `health-gate.sh` / `release.sh` | `http://127.0.0.1:${API_PORT:-4000}/api/health/ready` and `/tracking` | works |
| `veetrax-api.service` | `EnvironmentFile=apps/api/.env`, no `NODE_ENV` in the unit | the binding follows `.env`: with `NODE_ENV=production` there it becomes loopback, otherwise it stays as before |
| `ufw` (`install-ubuntu.sh`) | 4000 is not opened | loopback adds a second layer; nothing outside relied on :4000 |

If anything on another host must reach the API directly, set `API_HOST` to that interface's private address (never a
public one) in `apps/api/.env`. To restore the old behaviour for one release: `API_HOST=0.0.0.0`.

## Release health gate (v1.8.1)

After `systemctl restart`, `release.sh` runs `health-gate.sh`:

1. every unit in `$SERVICES` is `active` (retried for up to 30 s);
2. `API_HEALTH_URL` (default `http://127.0.0.1:${API_PORT:-4000}/api/health/ready`) answers 200;
3. `GATEWAY_HEALTH_URL` (default `http://127.0.0.1:${GATEWAY_HEALTH_PORT:-4121}/health`) answers 200
   (skipped when `GATEWAY_HEALTH_PORT=0`, i.e. the gateway's health listener is off);
4. `TRACKING_HEALTH_URL` (default `http://127.0.0.1:${API_PORT:-4000}/api/health/tracking`) answers 200, i.e. OK or
   WARN. It is retried until the deadline, because right after a restart the processor may lag for a while.
   **`HEALTH_GATE_TRACKING`**:
   - `1` (default, spec G6: 200 only): anything but 200 at the deadline, including a 503 (tracking CRITICAL), **fails**
     the gate. (`strict` is accepted as the same value.)
   - `warn` (opt-in, the operator's explicit choice, e.g. after a long outage with a known backlog): a 503 at the
     deadline is only a **WARN** and the gate passes "with warnings: tracking". No answer or any other code still
     fails. This also hides a stuck processor (devices connected, nothing persisted), so re-check a few minutes later
     with `release.sh --health-only` until tracking answers 200;
   - `0`: skipped, e.g. on a first install with no devices;
5. map services (`ROUTER_URL`, `GEOCODER_URL`, `MARTIN_URL` from `apps/api/.env`) are probed once and only **warned**
   about, because `release.sh` does not deploy them. Only loopback / private / single-label hosts are probed; a public
   host is reported as a WARN ("not probed … misconfiguration?") and never fetched, unless `MAP_PROBE_ALLOW_PUBLIC=1`.
   Printed URLs never carry userinfo or a query string. The API's System Health uses the same rule. Redirects are
   never followed (curl without `-L`; the API probe uses `redirect: 'manual'`): a 3xx counts as down / WARN.

`API_PORT` / `GATEWAY_HEALTH_PORT` are the API's own settings; `release.sh` reads them (and the map-service URLs and
the gate's own `HEALTH_*` settings) from `apps/api/.env`, so `--health-only` on the test instance (`API_PORT=4100`)
needs no URL overrides. Steps 2–4 retry every `HEALTH_POLL_SEC` (3 s) until `HEALTH_TIMEOUT_SEC` (90 s) for the whole
gate. **The deadline is kept** (QA-3): every curl is capped by the time left, a check reached after the deadline gets
one 1 s attempt, and the map probes get the time left (at most 3 s each) and are reported "not probed: the gate
deadline was reached" once it is gone. The gate therefore ends within `HEALTH_TIMEOUT_SEC` + about 3 s (plus the
journal tail on a failure). curl always runs as `curl -q --proto =http,https … -- <url>` (no `~/.curlrc`, http(s)
only, a URL can never be read as an option). Each check prints `PASS` / `FAIL` / `WARN` / `SKIP`, then
`== HEALTH GATE: PASS` (exit 0) or `== HEALTH GATE: FAIL (<checks>)` (exit 1), with `journalctl -u <unit> -n 50` for
the failed units. Exit 2 means the gate could not run (bad setting, no curl); `release.sh` then says so and exits 2
without the rollback text.

**Journal tail.** `release.sh` runs as `veetrax`, which cannot read the system journal. The gate tries, in order:
`journalctl -q -u <unit> -n 50 --no-pager`, used only if it exits 0 **and** prints real entries (not journalctl's
multi-line "Hint: You are currently not seeing messages …" / "No journal files were opened …" notice, and not an empty
result from the user's own journal); then `sudo -n journalctl -u <unit> -n 50 --no-pager` when sudoers allows exactly
that (no `-q`: the arguments must match the sudoers line); otherwise it prints "journal not readable as veetrax; run
as root: sudo journalctl -u <unit> -n 50 --no-pager". `install-ubuntu.sh` grants the five exact commands
(one per `veetrax-*` unit, fixed arguments). A wildcard line such as `journalctl -u veetrax-* -n * --no-pager` was
**not** used: a sudoers `*` also matches spaces, so it would allow other units and options such as `--vacuum-time`
(deleting the journal) or `--file`. **Existing production server** (the installer is not re-run there): until the owner
approves adding the same line by hand (`sudo visudo -f /etc/sudoers.d/veetrax`, the `journalctl` line from
`install-ubuntu.sh`), a failed gate prints the hint and the journal must be read as root.

**Restart permission (Sec-M1).** `install-ubuntu.sh` no longer writes `systemctl restart veetrax-*`: in sudoers that
`*` also matches spaces, so it allowed `sudo systemctl restart veetrax-api postgresql@18-main ssh valkey-server` (any
unit, a denial-of-service path for anyone holding the `veetrax` account). It now grants exact commands only:

```
veetrax ALL=(root) NOPASSWD: /usr/bin/systemctl restart veetrax-api veetrax-gateway veetrax-processor veetrax-notifier veetrax-summarizer
veetrax ALL=(root) NOPASSWD: /usr/bin/systemctl restart veetrax-api, /usr/bin/systemctl restart veetrax-gateway, /usr/bin/systemctl restart veetrax-processor, /usr/bin/systemctl restart veetrax-notifier, /usr/bin/systemctl restart veetrax-summarizer
veetrax ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy
```

The first line is exactly what `release.sh` runs (`sudo systemctl restart $SERVICES` with the default `SERVICES`, all
five in that order). A custom `SERVICES` (another order or subset of several units) does **not** match and needs root.
`bash ops/deploy/linux/test/install-valkey-aof-test.sh` checks the lines (no wildcard, the release.sh form matches,
other units are denied) and runs `visudo -cf` where `visudo` exists (it passes on Ubuntu / WSL).

> **Manual production step, needs owner approval (not done by v1.8.1).** The existing production server keeps the
> sudoers file written by the v1.8.0 installer (with the `veetrax-*` wildcard); deploying v1.8.1 does not change it,
> and `release.sh` keeps working with it. To apply Sec-M1 there, after the owner approves a sudoers change, as root:
> 1. `sudo cp -a /etc/sudoers.d/veetrax /root/sudoers.veetrax.bak`
> 2. `sudo visudo -f /etc/sudoers.d/veetrax` and replace the `systemctl restart veetrax-*, /usr/bin/systemctl reload
>    caddy` line with the three lines above (optionally also add the `journalctl` line from `install-ubuntu.sh`);
>    visudo refuses to save a file with a syntax error.
> 3. Check as `veetrax`: `sudo -n -l /usr/bin/systemctl restart veetrax-api veetrax-gateway veetrax-processor
>    veetrax-notifier veetrax-summarizer` prints the command, and `sudo -n -l /usr/bin/systemctl restart postgresql`
>    is refused.
> Undo: `sudo cp -a /root/sudoers.veetrax.bak /etc/sudoers.d/veetrax`.

**`apps/api/.env` is read, not run (Sec-L5).** `release.sh` used to `source` the file as bash; it has systemd
`EnvironmentFile` syntax, so `&`, `;`, `$`, backticks or `$(...)` in a value (a password, a `DATABASE_URL` query) were
executed or expanded. It now parses `KEY=VALUE` lines literally (optional `export `, one pair of surrounding quotes
removed, comments and other lines skipped; `PATH`, `IFS`, `BASH_ENV`, `LD_*` and the like are never taken from it):
- migrate and the seed still get **every** setting exported, as in v1.8.0, but only inside their own subshell;
- the gate gets only the keys it reads (`API_PORT`, `GATEWAY_HEALTH_PORT`, the map-service settings, `HEALTH_*` /
  `*_HEALTH_URL`), so database secrets no longer reach it or its curl calls.
- Behaviour change only for values that relied on bash: a value is now taken exactly as systemd gives it to the
  services (no `$VAR` expansion, no `\` escapes, no inline `# comment` stripping). Production's `.env` uses plain
  values, so nothing changes there.
- The re-check command printed after a rollback to a tag without a gate still loads `.env` with `.`; it is a command
  for the operator to read and run by hand.

**On failure nothing is rolled back automatically** (owner decision O17). `release.sh` prints:

```
RELEASE FAILED HEALTH GATE — nothing was rolled back automatically.
  1. Read the FAIL lines and the journal above. A slow start can be re-checked with:
       bash /opt/veetrax/app/ops/deploy/linux/release.sh --health-only
  2. Roll back to the previous release:
       REF=<previous tag> bash /opt/veetrax/app/ops/deploy/linux/release.sh
```

and exits 1. The previous release is the tag (or commit) that was checked out before the release; it is also kept in
`/var/lib/veetrax/release-prev` for `--health-only`. A rollback does not undo database migrations.

- `bash release.sh --health-only`: the gate alone (no checkout, build or restart). Test instance: `API_PORT=4100` in
  its `apps/api/.env`, or `API_HEALTH_URL=http://127.0.0.1:4100/api/health/ready TRACKING_HEALTH_URL=http://127.0.0.1:4100/api/health/tracking`.
- Local test with stubs (node + curl, fake systemctl / journalctl / sudo / npm, a throw-away git repo):
  `bash ops/deploy/linux/test/health-gate-test.sh`.
- The first deploy **to** v1.8.1 is run by the v1.8.0 `release.sh`, which has no gate: run
  `bash release.sh --health-only` by hand after it. Every later release is gated.
- **Rollback to a release without a gate** (`REF=v1.8.0 bash release.sh`, run by the v1.8.1+ script): `release.sh`
  copies `health-gate.sh` to a temp file **before** the checkout and runs that copy, so the rollback is still gated
  and a healthy rollback ends with "Release is healthy". If no gate exists at all, the gate is skipped with a clear
  message (never "RELEASE FAILED"). After such a rollback `--health-only` is gone with the old tree; the failure text
  then prints a command that extracts `health-gate.sh` from `<prev>` into a `mktemp` file and runs it with
  `apps/api/.env` loaded (so the test instance's `API_PORT` is honoured).
- **Web app on such a rollback:** a tag older than v1.8.1 ignores `VEETRAX_WEB_OUTDIR` and rebuilds `apps/web/dist`
  in place. `release.sh` notices this before the build (no `VEETRAX_WEB_OUTDIR` in its `vite.config`), copies the
  live build to `apps/web/dist.prev` first, skips the swap, and runs the external-maps check on `apps/web/dist` when
  that tree has the check (v1.8.0 has none: "was not checked" note). If that build or check fails, `dist.prev` is put
  back as `dist`, so the site is never left without `apps/web/dist`.
- `release.sh` runs inside a `main` function that bash reads completely first, so the checkout changing the script
  while it runs cannot mix old and new lines.

## ETMS route planning: routing worker + optimiser (E4 WP 4.2; v1.16 switches, off by default)

Owner decision 2026-11-13: automatic routing stays **off** until switched on in the admin, and then it must work.
Routing is active for a company only when all three hold:

1. `ETMS_ROUTING` in `apps/api/.env` is **not** `off` (and `ETMS` is not `off`). This is only the **emergency kill
   switch**: unset, empty, `auto` or `on` all mean "the database switches decide"; an explicit `off` stops everything
   whatever the UI says (restart `veetrax-api` and `veetrax-routing-worker` to apply a change).
2. The platform switch **Platform Settings → Route planning → Automatic route planning** (Super Admin, table
   `RoutingSettings`, default **off**). It refuses to go on (HTTP 409 `ROUTING_NOT_READY`) unless every readiness check
   passes: kill switch not pulled, `OPTIMIZER_URL` + token usable, optimiser `/health` answering, optimiser Python
   ≥ 3.14 with OR-Tools, a routing worker heartbeat, GraphHopper healthy. The page and System Health show the checklist
   with what is missing. Every change is audited (`RoutingSettings`).
3. The company's own switch **Transport → Settings → Automatic route planning** (`Company.settings.etms.autoRouting`,
   default **off**, Transport admin with whole-company scope; audited as `etms_settings`).

An upgrade therefore stays off without touching `.env`: the platform switch starts off.

| Unit | Runs | Caps (shared 6 vCPU / 27 GB host) |
|---|---|---|
| `veetrax-routing-worker` | `node dist/routing-worker/main.js`: optimisation jobs from `vt:routing:jobs` (`RoutingJob` rows are the truth). Switch off: idles (one switch read per 5 s, heartbeat, no optimiser probe, no GraphHopper call). Exits 0 only with `ETMS_ROUTING=off` | `CPUQuota=100%`, `MemoryMax=1G`, `Nice=10` |
| `veetrax-optimizer` | OR-Tools service, `127.0.0.1:8090`, venv `/opt/veetrax/venvs/routing-optimizer` (Python 3.14, hashed lock); passive HTTP server, idle without requests | `CPUQuota=150%`, `MemoryMax=3G`, `Nice=10`, `OPTIMIZER_CONCURRENCY=1`, loopback-only `IPAddressAllow` |

- **Install on a running server (one time, as root):** `bash /opt/veetrax/app/ops/deploy/linux/install-ubuntu.sh --routing-only`.
  Idempotent; touches nothing else (no PostgreSQL / Valkey restart, main sudoers file unchanged). It installs Python
  3.14 + venv from the deadsnakes PPA when missing, writes `/etc/sudoers.d/veetrax-routing` (the seven-unit restart,
  the two units, their journal tails), installs and enables both units, creates `/etc/veetrax/optimizer.env` once
  (`OPTIMIZER_TOKEN`, root:veetrax 0640, read by the optimiser, the API and the worker through `OPTIMIZER_TOKEN_FILE`),
  builds the venv from the hashed lock, appends `OPTIMIZER_URL=http://127.0.0.1:8090` to `apps/api/.env` when missing
  (and then restarts `veetrax-api`), and starts both units. A full `DB_PASS=… bash install-ubuntu.sh` does the same
  (`ETMS_ROUTING=off bash install-ubuntu.sh` skips it).
- `release.sh`: once `veetrax-routing-worker.service` is installed (and `ETMS_ROUTING` is not `off`) the venv is
  refreshed from `services/routing-optimizer/requirements.lock` (`--require-hashes --no-deps --only-binary=:all:`;
  failure stops the release before migrations) and both units are restarted with the other five, switch on or off.
- Health gate: `ETMS_ROUTING=off` → `SKIP routing disabled`. Otherwise it asks `GET /api/health/routing`: switch off →
  `SKIP routing installed, switched off` (or `not installed, switched off`), readiness not gated; switch on → the
  optimiser `/health` must answer 200 (token from `OPTIMIZER_TOKEN_FILE` into a private header file) **and**
  `/api/health/routing` must report ready, else FAIL with the failing items.
- Switching off while jobs run: a running optimisation finishes (bounded by its own timeout); queued ones are ended
  FAILED `ROUTING_OFF` by the worker without engine work and their plans go back to DRAFT; new ones are refused (the
  planning routes answer 404, the planner says "Automatic routing is switched off — ask your administrator").
- A killed worker's job is re-queued after its lease (60 s) by any worker, at most 3 attempts, then FAILED with
  `WORKER_LOST`. Manual dispatch never depends on either unit.

## Web build and the external-maps check (G8 web)

`release.sh` builds the web app into `apps/web/dist.next` (`VEETRAX_WEB_OUTDIR=dist.next npm run build -w
@veetracer/web`, i.e. `tsc -b`, `vite build` and `scripts/check-no-external-maps.mjs` on that folder). Only when all of
it passes does it replace the live `apps/web/dist` (two renames; the previous build stays in `apps/web/dist.prev`). If
the build or the check fails, the live web app is untouched and `release.sh` prints "WEB BUILD FAILED" with the
rollback command (the checkout and `node_modules` are already at the new release; nothing was migrated or restarted).
If the second rename fails, `dist.prev` is moved back to `dist` before that message.

- **The swap window (accepted).** Between `mv dist dist.prev` and `mv dist.next dist`, two back-to-back `rename()`
  calls in the same folder, `apps/web/dist` does not exist for microseconds. A request in exactly that instant gets a
  404 from Caddy and a reload fixes it. A symlink swap (`dist -> dist-<ts>`, `ln -sfn` + `mv -T`) was considered and
  not used: the first run would still need the same two renames to turn the real folder into a link; a pre-v1.8.1
  rollback would build into the link's target in place; `dist/` in `.gitignore` does not match a symlink (it would show
  as untracked); old `dist-<ts>` folders need pruning; and `mv --exchange` (atomic) needs coreutils 9.5, newer than
  Ubuntu 24.04's. Caddy's `root` stays the plain folder `/opt/veetrax/app/apps/web/dist`.
- Clients that still hold the old `index.html` request old hashed chunks, which now live only in `dist.prev`; a lazy
  route fails until the page is reloaded (pre-existing, unchanged).
- **Quick manual restore** of the previous web build (as `veetrax`, no restart needed; Caddy serves it at once):
  `cd /opt/veetrax/app/apps/web && mv dist dist.bad && mv dist.prev dist`.

- The check has three layers (QA-2 / Sec-L6 hardened it):
  1. **The build env.** Each `VITE_MAP_STYLE_*` (read like `vite build` does: process env, then `apps/web/.env*`) must
     be unset, a same-origin `/tiles/...` path, or an `http(s)` URL without userinfo on `*.veetrax.com` / localhost /
     127.x / `[::1]`. A protocol-relative `//host/...`, `https://app.veetrax.com@evil...` or any other host fails the
     build, whatever the path looks like (a style URL without `.json` is caught too).
  2. **The style base in the bundle.** The inlined `resolveStyleUrls({standard, light, dark}, location.origin)` call is
     found in the built JS; each value must be unset (and the same-origin `/tiles/styles/<file>.json` fallback must be
     present) or exactly the build-env value. If the call cannot be found, the check fails rather than pass blind.
  3. **Text scan.** Known outside map hosts (OpenFreeMap, OSM tiles, Mapbox incl. directions / geocoding, MapTiler,
     Google tiles and geocode / directions / routes APIs, Esri, CARTO, Stadia, Thunderforest, HERE, TomTom, Bing, Ola
     Maps, Mappls / MapmyIndia, Protomaps, VersaTiles, Geoapify), routing and geocoding hosts (Nominatim, Photon /
     komoot, OSRM `router.project-osrm.org`, GraphHopper cloud, openrouteservice, FOSSGIS Valhalla, LocationIQ),
     Google `output=embed` / `maps/embed`, and **any** absolute or protocol-relative URL in a map context (`{z}`/`{x}`/
     `{y}`, `{quadkey}`, `{bbox-…}`, `{fontstack}`, `.pbf`, `.mvt`, `.pmtiles`, `/style(s)/`, `/tiles/`, `/basemap`,
     `/glyphs/`, `sprite`, `?style=`) whose origin is not allowed. In the bundle the only allowed origins are those of
     the `VITE_MAP_STYLE_*` values (exactly, port included); in source, `*.veetrax.com` / localhost. Userinfo in such
     a URL always fails. Attribution links and the O9 Google Maps hand-off links stay allowed, but only in their exact
     form (the exemptions are anchored: `https://openmaptiles.org/fonts/{fontstack}/…` or `google.com/maps?q=…/vt/…`
     are flagged).
  - Still out of reach of a text check (by design): URLs built by string concatenation or encoded at run time.
  - A LAN IP or another own domain (e.g. a Mintplus host) as `VITE_MAP_STYLE_*` is rejected; leave the variables
    unset so the app uses `/tiles` on its own origin.
- Deliberate deviation from spec G8 web item 5: the release does **not** fail when `VITE_MAP_STYLE_STANDARD` is unset,
  because unset now means the same-origin self-hosted `/tiles/styles/…` (no outside default exists any more).
- Runtime configuration the build check cannot see: ESRI satellite imagery (`ESRI_BASEMAP_KEY`, API
  `maps.controller.ts`) is an outside host when set. It is off in production and stays off (dormant, per spec);
  mention it in the G8 evidence.
- **Mobile (G8 mobile, on hold; m5 of the v1.8.1 review):** v1.8.1 removed the OpenFreeMap satellite overlay from
  `packages/shared` `basemap.ts`. The mobile app is unchanged, but its default `MAP_STYLE` is still an OpenFreeMap URL,
  so the satellite overlay (road lines and names over imagery) only appears for a self-hosted style. **A future mobile
  build must set `EXPO_PUBLIC_MAP_STYLE_STANDARD|LIGHT|DARK` to the self-hosted styles**
  (`https://app.veetrax.com/tiles/styles/{liberty,positron,dark}.json`), or satellite shows imagery only. No effect
  today: ESRI imagery is off and no mobile build is authorised.

## Valkey AOF on fresh installs (v1.8.1, spec G4, script only)

`install-ubuntu.sh` now writes these lines to `/etc/valkey/valkey.conf` (uncommented lines are replaced, missing ones
appended; the RDB `save` lines stay):

```
appendonly yes
appendfsync everysec
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb
aof-use-rdb-preamble yes
aof-load-truncated yes
no-appendfsync-on-rewrite no
```

- **Fresh installs only.** With `appendonly yes` in the file and no AOF on disk, a restarted Valkey starts **empty**
  and ignores `dump.rdb`. So the script first decides the state of Valkey and writes the lines only when it is
  **empty** (running: 0 keys in **all** databases, the sum of `keys=` over every `dbN` line of `INFO keyspace`, so a
  shared Valkey with keys only in db1+ is not "empty"; stopped: no dump file under the unquoted `dir` / `dbfilename` and no
  `appendonlydir`) or **AOF is already on** (`CONFIG GET appendonly` = `yes`, or `appendonly yes` in a stopped
  server's file with a non-empty AOF directory, or nothing on disk). On a server with data and AOF off it prints a
  WARNING and leaves the file alone.
- **Stopped, `appendonly yes`, a `dump.rdb` but no AOF** (QA-4; e.g. the file was hand-edited earlier): started like
  this Valkey would ignore the dump and boot empty. The installer treats it as "has data": WARNING with the manual fix,
  file unchanged, and Valkey is **not started**.
- **Password.** `valkey-cli` gets the password from `REDISCLI_AUTH` or, if unset, from `requirepass` in the conf file
  (through the environment, never the command line). If Valkey does not answer `PONG` / a well-formed `INFO keyspace` section with it
  (`NOAUTH`, `WRONGPASS`, `LOADING`, …) the state is **unknown** and treated as "has data": WARNING, file unchanged,
  no restart.
- **Restart only when empty.** Valkey is restarted only in the empty case. With AOF already on, the file is updated
  but Valkey is **not** restarted (the settings apply at its next planned restart), so a restart can never interrupt
  a running AOF rewrite. With data or an unknown state it is only started if it was stopped, never restarted.
- The production server is **not** changed by this. Turning AOF on there is a separate, owner-approved online
  procedure (`CONFIG SET appendonly yes`, wait for the rewrite, then persist the file; no restart), see the release-gate
  spec G4.
- No `maxmemory` is set (separate decision; Valkey keeps `maxmemory-policy noeviction`).
- Local test (fake `valkey-cli`, temp config, no root): `bash ops/deploy/linux/test/install-valkey-aof-test.sh`.
- Rollback for a fresh install: `valkey-cli CONFIG SET appendonly no` and set `appendonly no` in the file (no restart).

## History archiving (raw GPS points → compressed files on this server)

Owner decision 2026-11-15. **Per company, off by default** (Super Admin → Platform → Companies → *Archive old GPS
history*, or `PATCH /api/admin/companies/:id` with `historyArchive: { enabled, afterDays }`, 30–3650 days, default 90).
Companies without the switch keep exactly the old behaviour (retention deletes raw points after `retentionDays`).

For a company with the switch on:
- **Retention no longer deletes its raw points.** Each night the archive job (api process) moves points older than
  `afterDays` into one file per vehicle per company-local day:
  `HISTORY_ARCHIVE_DIR/<companyId>/<objectId>/<yyyy>/<mm>/<dd>.jsonl.gz` (gzip JSON Lines: header line, one line per
  point with every stored value, trailer line with the count and a sha256 checksum).
- A file is written to a hidden temp name in the same directory (`.<dd>.jsonl.gz.tmp-*`), fsynced, re-read and verified,
  then atomically renamed; it is re-read once more under its final name; only then, in one short database transaction
  holding the vehicle's archive lock (a PostgreSQL advisory lock the summarizer also takes while it writes results), the
  job re-checks that the summarizer is done with the day (no dirty days, watermark past the day), switches the
  `ArchivedDay` row to the file and deletes exactly the written points (primary key + the day's time bounds, 5,000 per
  statement; every one must still be present). A day that is rewritten (late points, re-archive after a restore,
  device purge) gets a new versioned name `<dd>.<version>.jsonl.gz`; the row switches to it in the transaction and the
  superseded file is deleted after the commit. **No point is ever deleted without a verified file.** A failure (disk
  full, permission, points changed meanwhile, …) leaves every point in the database, removes the file the attempt wrote,
  marks a new day FAILED and retries it with back-off (1, 2, 4 … at most 7 days between attempts).
- Idle vehicles (the summarizer's watermark stays at their last point) are archived once every point is summarised and
  the day is older than afterDays + 1. Raw points keep their `attributes` JSON text exactly (big integers, decimals).
- Days still marked dirty by the summarizer, or not yet summarised to their end, are skipped. Trips, stops, daily
  summaries and alerts are not touched (they follow `retentionDays` as before), so trip / summary reports stay complete.
  The summarizer never rebuilds anything before a vehicle's newest archived day.
- Raw-point reports (Positions, Overspeed, Ignition, Fuel, Geofence distance) over archived days show an
  "archived — incomplete" notice instead of silently wrong totals.
- **Restore:** History shows "Archived — Restore" on an archived day; users with History → *command* (the built-in
  Admin role has it after the migration) or the Super Admin restore a vehicle's days (`POST /api/history-archive/restore`
  `{ objectId?, from, to, keepDays? }`; without `objectId` = the whole company / the vehicles the user sees). The
  restore worker (every 15 s) re-imports the points (insert-if-missing, so repeats are harmless), checks every point is
  back and marks the day RESTORED. Restored days go back into the archive after `keepDays` (default 7, max 90).

| Env (apps/api/.env) | Default | Meaning |
|---|---|---|
| `HISTORY_ARCHIVE` | `on` | `off` = kill switch: no archiving and no restores (old points of archive companies then simply stay in the database; retention still skips them) |
| `HISTORY_ARCHIVE_DIR` | `/var/lib/veetrax/history-archive` | Archive directory. **Must be on this server's own disk** (no external / network storage); created by `install-ubuntu.sh` (owner `veetrax`, 0750). Keep the default: the nightly backup snapshots this path |
| `HISTORY_ARCHIVE_HOUR` | `2` | **UTC** hour the nightly run starts. No run is active between 21:00 and 22:30 UTC (the nightly file backup runs at 21:30 UTC): a run never starts in that window and stops at 21:00 UTC; the Super Admin "run now" is refused there too |
| `HISTORY_ARCHIVE_OVERDUE_DAYS` | `30` | Safety limit: a vehicle holding points older than afterDays + this that could not be archived raises CRITICAL `archive.overdue` (points are still never deleted without an archive) |
| `HISTORY_ARCHIVE_BUDGET_MIN` | `120` | Run length; whatever is left continues the next night (System Health shows the vehicles still waiting) |
| `HISTORY_ARCHIVE_PAUSE_MS` | `200` | Pause between vehicle-days (keeps the job at low priority next to live traffic) |

**Backups.** Archived points are **not** in the PostgreSQL dump any more (they left the database). The nightly backup
includes the archive files: it snapshots `HISTORY_ARCHIVE_DIR` with hard-linked rsync snapshots (14 kept). Files appear
under their final name only when complete, so a snapshot never holds a half-written file (temp files `.*.tmp-*` may be
excluded). While a run writes files, `HISTORY_ARCHIVE_DIR/.running` exists (JSON `{ pid, host, startedAt, deadline }`,
removed when the run ends); a backup may wait for it to disappear, or treat it as stale after `deadline` + 15 min. **Off-site copy is still pending (decision Q-03)**: until then a lost server disk loses the archive with it.
Archive files are not financial records.

**Monitoring.** System Health → *History archive*: job on/off, companies switched on, last run (days archived, vehicles
still waiting), failed days with the last error, restores in progress, archive size and free space on the archive disk.
Issues: `archive.job` (WARN: no completed run for 36 h while companies are switched on, failed days, vehicles that could
not be archived — waiting for the summarizer, never summarised, or failed — with counts, `HISTORY_ARCHIVE=off` with
companies switched on), `archive.overdue` (CRITICAL, see `HISTORY_ARCHIVE_OVERDUE_DAYS`) and `archive.disk` (WARN < 10 %
free, CRITICAL < 5 %). Super Admin endpoints:
`GET /api/admin/history-archive/health`, `POST /api/admin/history-archive/run` (start a pass now; single runner).

**Purge / erasure.** Permanently deleting a company or a vehicle (Super Admin purge, or "delete my account") removes its
`ArchivedDay` rows in the purge transaction and its archive files / directories right after it commits. Purging a
*device* removes its points from the archive files of the vehicles it was fitted to (each affected day file rewritten,
a day left empty loses its file and row); if that step fails it is logged (`PURGE device … archive files failed`).
An archive run that overlaps a purge fails closed: its transaction sees the points or the row gone, deletes nothing and
removes the file it wrote.

**TimescaleDB.** Points are deleted with plain `DELETE … WHERE ("deviceId","fixTime") = …` per vehicle-day, which works on
a plain table and on a hypertable; if Position chunks are ever compressed, TimescaleDB ≥ 2.11 is needed for DML on
compressed chunks (no compression policy exists in the migrations today).

**Turning it off** for a company stops new archiving; already archived days stay restorable, and from then on that
company's raw points follow `retentionDays` again (restored days included).
