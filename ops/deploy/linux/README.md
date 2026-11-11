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
2. `API_HEALTH_URL` (default `http://127.0.0.1:4000/api/health/ready`) answers 200;
3. `GATEWAY_HEALTH_URL` (default `http://127.0.0.1:4121/health`) answers 200;
4. `TRACKING_HEALTH_URL` (default `http://127.0.0.1:4000/api/health/tracking`) answers 200, i.e. OK or WARN.
   `HEALTH_GATE_TRACKING=0` skips it, e.g. on a first install with no devices;
5. map services (`ROUTER_URL`, `GEOCODER_URL`, `MARTIN_URL` from `apps/api/.env`) are probed once and only **warned**
   about, because `release.sh` does not deploy them.

Steps 2–4 retry every `HEALTH_POLL_SEC` (3 s) until `HEALTH_TIMEOUT_SEC` (90 s) for the whole gate. Each check prints
`PASS` / `FAIL` / `WARN` / `SKIP`, then `== HEALTH GATE: PASS` (exit 0) or `== HEALTH GATE: FAIL (<checks>)` (exit 1),
with `journalctl -u <unit> -n 50` for the failed units.

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

- `bash release.sh --health-only`: the gate alone (no checkout, build or restart). Test instance:
  `API_HEALTH_URL=http://127.0.0.1:4100/api/health/ready TRACKING_HEALTH_URL=http://127.0.0.1:4100/api/health/tracking`.
- Local test with stubs (node + curl): `bash ops/deploy/linux/test/health-gate-test.sh`.
- The first deploy **to** v1.8.1 is run by the v1.8.0 `release.sh`, which has no gate: run
  `bash release.sh --health-only` by hand after it. Every later release is gated.
- `release.sh` runs inside a `main` function that bash reads completely first, so the checkout changing the script
  while it runs cannot mix old and new lines.

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
  and ignores `dump.rdb`. So the script writes the lines only when Valkey holds no data (no keys; or, when stopped,
  no non-empty `dump.rdb`) or when AOF is already on (`CONFIG GET appendonly` = `yes`). On a server with data and AOF
  off it prints a WARNING and leaves the file alone.
- The production server is **not** changed by this. Turning AOF on there is a separate, owner-approved online
  procedure (`CONFIG SET appendonly yes`, wait for the rewrite, then persist the file; no restart), see the release-gate
  spec G4.
- No `maxmemory` is set (separate decision; Valkey keeps `maxmemory-policy noeviction`).
- Local test (fake `valkey-cli`, temp config, no root): `bash ops/deploy/linux/test/install-valkey-aof-test.sh`.
- Rollback for a fresh install: `valkey-cli CONFIG SET appendonly no` and set `appendonly no` in the file (no restart).
