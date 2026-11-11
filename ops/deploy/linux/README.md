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

## Release health gate (v1.8.1)

After `systemctl restart`, `release.sh` runs `health-gate.sh`:

1. every unit in `$SERVICES` is `active` (retried for up to 30 s);
2. `API_HEALTH_URL` (default `http://127.0.0.1:${API_PORT:-4000}/api/health/ready`) answers 200;
3. `GATEWAY_HEALTH_URL` (default `http://127.0.0.1:${GATEWAY_HEALTH_PORT:-4121}/health`) answers 200
   (skipped when `GATEWAY_HEALTH_PORT=0`, i.e. the gateway's health listener is off);
4. `TRACKING_HEALTH_URL` (default `http://127.0.0.1:${API_PORT:-4000}/api/health/tracking`) answers 200, i.e. OK or
   WARN. **`HEALTH_GATE_TRACKING`** decides what a 503 (tracking CRITICAL) means:
   - `1` (default): retried until the deadline; still 503 then is a **WARN**, not a FAIL. Right after a restart the
     processor may need longer than the deadline to work off its backlog (lag CRITICAL), which is not a broken
     release. Re-check a few minutes later with `release.sh --health-only`. No answer or any other code still fails;
   - `strict`: a 503 at the deadline fails the gate;
   - `0`: skipped, e.g. on a first install with no devices;
5. map services (`ROUTER_URL`, `GEOCODER_URL`, `MARTIN_URL` from `apps/api/.env`) are probed once and only **warned**
   about, because `release.sh` does not deploy them. Only loopback / private / single-label hosts are probed; a public
   host is reported as a WARN ("not probed … misconfiguration?") and never fetched, unless `MAP_PROBE_ALLOW_PUBLIC=1`.
   Printed URLs never carry userinfo or a query string. The API's System Health uses the same rule.

`API_PORT` / `GATEWAY_HEALTH_PORT` are the API's own settings; `release.sh` loads `apps/api/.env`, so `--health-only`
on the test instance (`API_PORT=4100`) needs no URL overrides. Steps 2–4 retry every `HEALTH_POLL_SEC` (3 s) until
`HEALTH_TIMEOUT_SEC` (90 s) for the whole gate. Each check prints `PASS` / `FAIL` / `WARN` / `SKIP`, then
`== HEALTH GATE: PASS` (exit 0) or `== HEALTH GATE: FAIL (<checks>)` (exit 1), with `journalctl -u <unit> -n 50` for
the failed units. Exit 2 means the gate could not run (bad setting, no curl); `release.sh` then says so and exits 2
without the rollback text.

**Journal tail.** `release.sh` runs as `veetrax`, which cannot read the system journal. The gate tries, in order:
plain `journalctl`; `sudo -n journalctl -u <unit> -n 50 --no-pager` when sudoers allows exactly that; otherwise it
prints "run as root: sudo journalctl -u <unit> -n 50 --no-pager". `install-ubuntu.sh` grants the five exact commands
(one per `veetrax-*` unit, fixed arguments). A wildcard line such as `journalctl -u veetrax-* -n * --no-pager` was
**not** used: a sudoers `*` also matches spaces, so it would allow other units and options such as `--vacuum-time`
(deleting the journal) or `--file`. **Existing production server** (the installer is not re-run there): until the owner
approves adding the same line by hand (`sudo visudo -f /etc/sudoers.d/veetrax`, the `journalctl` line from
`install-ubuntu.sh`), a failed gate prints the hint and the journal must be read as root.

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
  then prints `git show <prev>:ops/deploy/linux/health-gate.sh > /tmp/health-gate.sh && bash /tmp/health-gate.sh`.
- `release.sh` runs inside a `main` function that bash reads completely first, so the checkout changing the script
  while it runs cannot mix old and new lines.

## Web build and the external-maps check (G8 web)

`release.sh` builds the web app into `apps/web/dist.next` (`VEETRAX_WEB_OUTDIR=dist.next npm run build -w
@veetracer/web`, i.e. `tsc -b`, `vite build` and `scripts/check-no-external-maps.mjs` on that folder). Only when all of
it passes does it replace the live `apps/web/dist` (two renames; the previous build stays in `apps/web/dist.prev`). If
the build or the check fails, the live web app is untouched and `release.sh` prints "WEB BUILD FAILED" with the
rollback command (the checkout and `node_modules` are already at the new release; nothing was migrated or restarted).

- The check flags known outside map hosts (OpenFreeMap, OSM tiles, Mapbox, MapTiler, Google, Esri, CARTO, Stadia,
  Thunderforest, HERE, TomTom, Bing, Ola Maps, Mappls / MapmyIndia, Protomaps, VersaTiles, Geoapify, …), Google
  `output=embed` / `maps/embed`, and, as a second layer, **any** absolute URL to a map resource (`{z}`,
  `{fontstack}`, `.pbf`, `.mvt`, `.pmtiles`, `style.json`, `styles/*.json`, `sprite`) on a host other than
  `*.veetrax.com` / localhost. Attribution links and the O9 Google Maps hand-off links stay allowed.
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
  **empty** (running: `DBSIZE` 0; stopped: no dump file under the unquoted `dir` / `dbfilename` and no
  `appendonlydir`) or **AOF is already on** (`CONFIG GET appendonly` = `yes`, or `appendonly yes` in a stopped
  server's file). On a server with data and AOF off it prints a WARNING and leaves the file alone.
- **Password.** `valkey-cli` gets the password from `REDISCLI_AUTH` or, if unset, from `requirepass` in the conf file
  (through the environment, never the command line). If Valkey does not answer `PONG` / a number for `DBSIZE` with it
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
