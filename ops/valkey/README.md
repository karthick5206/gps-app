# Valkey host kit (Ubuntu 24.04 LTS, 2 GB VM)

The owner decided on 2026-11-09 that Valkey replaces Memurai. Hosting is a **new Mintplus Linux VM in the same data centre** as the Windows server 166.0.242.121; the quote and order are pending with the owner.

This kit turns a fresh Ubuntu 24.04 VM into the VeeTrax cache. The cut-over runbook is [docs/reliability/valkey-cutover-runbook.md](../../docs/reliability/valkey-cutover-runbook.md).

| File | Purpose |
|---|---|
| `install-valkey.sh` | Idempotent installer. It builds the pinned Valkey (9.1.3, SHA-256 checked against [valkey-hashes](https://github.com/valkey-io/valkey-hashes)) with TLS and systemd support, and sets up config, ACL users, TLS, firewall, SSH, systemd, logrotate, backup and the health endpoint. |
| `valkey.conf.template` | AOF everysec + RDB snapshots, `noeviction`, `maxmemory 1gb`, protected mode, bind to the given interface + loopback only |
| `gen-certs.sh` | Self-managed CA + server certificate (TLS mode) |
| `valkey.service` | Hardened systemd unit (`Type=notify`, `ProtectSystem=strict`, no capabilities, `Restart=on-failure`) |
| `valkey-health.py` + `.service` | `GET http://<bind>:9121/health` returns JSON and `/metrics` returns Prometheus text. It uses an ACL user that can only run PING/INFO. The Windows watchdog polls it (`-ValkeyHealthUrl`). |
| `valkey-backup.sh` + `.service` + `.timer` | Daily 02:30 BGSAVE copy + AOF archive into `/var/backups/valkey`, kept 7 days |
| `valkey.logrotate` | Daily rotation of `/var/log/valkey/*.log`, 14 kept |
| `test/kit-e2e.sh`, `test/Dockerfile` | End-to-end test in a throwaway Ubuntu 24.04 systemd container |

## Variant (a), primary: same data centre, private network, no TLS

1. Ask Mintplus for a private VLAN between the new VM and 166.0.242.121. Note both private addresses, for example VM `10.0.0.5` and Windows `10.0.0.4`.
2. **Check the private network really is isolated before relying on it without TLS:**
   - **Ask Mintplus in writing.** Is the VLAN dedicated to our two machines, or shared with other customers? Is traffic routed through any shared or public segment?
   - **Check the interface.** On the VM, `ip -br addr` should show the private interface on its own subnet. On Windows, `route print` should show the private subnet on a separate adapter.
   - **Check the route.** From Windows, `tracert -d 10.0.0.5` should reach it in **one hop**, and the VM should not answer on that subnet from any other address. From the VM, run `sudo arp-scan --localnet` (or `ip neigh`) on the private interface. Expect only the Windows server and the gateway, if any. Other unknown hosts mean the network is shared: **use TLS**.
   - **Check from outside.** The private address must not be reachable from the internet. From a machine outside the data centre, `nc -vz <vm-public-ip> 6379` must fail, and Valkey is not bound to the public interface at all.
   - If any answer is unclear, install with `MODE=tls`. TLS costs well under a millisecond per round trip (§ Sizing).
3. Install:
   ```bash
   git clone <repo> && cd gps-app/ops/valkey      # or copy this folder to the VM
   sudo MODE=private BIND_ADDR=10.0.0.5 APP_ALLOW_FROM=10.0.0.4 ADMIN_SSH_FROM=<your admin IP(s)> ./install-valkey.sh
   ```
4. The script prints the line for `C:\apps\veetracer\app\apps\api\.env`:
   - `REDIS_URL=redis://veetrax:<password>@10.0.0.5:6379`
   - The password is in `/etc/valkey/secrets/app.pass` (root only). Transfer it by hand and **never commit it**.

## Variant (b), option: TLS (other provider, or a shared private network)

```bash
sudo MODE=tls BIND_ADDR=<vm address> APP_ALLOW_FROM=166.0.242.121 ADMIN_SSH_FROM=<admin IPs> \
     TLS_SANS="IP:<vm address>,DNS:valkey.veetrax.internal" ./install-valkey.sh
```

- Plain port 6379 is closed. Only TLS 6380 is open, with TLS 1.2/1.3.
- Copy `/etc/valkey/tls/ca.crt` (**not** `ca.key`) to `C:\apps\veetracer\valkey-ca.crt`, then set in `.env`:
  ```
  REDIS_URL=rediss://veetrax:<password>@<vm address>:6380
  REDIS_TLS_CA_FILE=C:\apps\veetracer\valkey-ca.crt
  REDIS_TLS_SERVERNAME=valkey.veetrax.internal        # only needed if the URL host is not in the certificate
  ```
- The app reads these options in `apps/api/src/redis/connection.ts`; every process and the cut-over scripts use it. Certificate checks cannot be disabled.
- **Mutual TLS is optional.** Set `tls-auth-clients yes` in the template, issue a client certificate with the same CA, and set `REDIS_TLS_CERT_FILE`/`REDIS_TLS_KEY_FILE`.
- **Renewal.** The server certificate is valid for 825 days and the CA for 10 years. Delete `/etc/valkey/tls/server.*` and re-run the installer: the same CA is kept, so nothing changes on the app side.

## Users (ACL file `/etc/valkey/users.acl`)

| User | Rights | Used by |
|---|---|---|
| `default` | **off**, no password, no commands | nobody. It must not be `nopass`: with `nopass`, protected mode refuses every non-loopback client. The kit test found this. |
| `veetrax` | keys `vt:*` and `route:*`, channels `vt:*`, all commands except `@admin`/`@dangerous` plus `INFO` and `CLIENT SETNAME/SETINFO/ID` | the app (all five processes), `scripts/cache-copy.ts` |
| `admin` | everything | backup, ops on the VM (`valkey-cli --user admin --pass "$(sudo cat /etc/valkey/secrets/admin.pass)"`) |
| `health` | `PING`, `INFO` only, no keys | `valkey-health` |

To rotate the app password:
1. Delete `/etc/valkey/secrets/app.pass` and re-run the installer. This restarts Valkey.
2. Update `REDIS_URL` on the Windows server.
3. Restart the services in the cut-over order, gateway first.

The gateway spools positions during the gap.

## Firewall and SSH

- **ufw.** Default deny for incoming traffic. Valkey (6379 or 6380) and the health port 9121 are allowed only from `APP_ALLOW_FROM`. SSH (22) is allowed only from `ADMIN_SSH_FROM`.
- **SSH.** Password and keyboard-interactive login are disabled once an `authorized_keys` file exists. Without one, the step is skipped and a warning is printed, to avoid a lock-out. `FORCE_SSH_HARDEN=1` forces it.
- **Mintplus panel firewall.** If Mintplus also offers one, mirror the same allow-list there.

## Backups

- **Daily local backup.** `valkey-backup.timer` runs every day at 02:30. It runs BGSAVE and copies `dump.rdb`, archives `appendonlydir/`, and keeps 7 days (`KEEP_DAYS`) in `/var/backups/valkey`. Run one immediately with `sudo systemctl start valkey-backup`. The log is `/var/log/valkey-backup.log`.
- **The app does not depend on these backups for positions.** The gateway spools during an outage, and consumer groups are recreated if Valkey comes back empty. What a restore saves is live map state, alert episodes and offline command queues.
- **Off-site copies are optional and not set up**, because there is no paid storage without the owner's approval. Options:
  1. `rsync` or `scp` the newest `dump-*.rdb` nightly to the Windows server's existing backup folder (pull from Windows with `scp` over SSH key auth).
  2. Use the existing `ops/backup` S3 job, which needs the owner's approval for its cost.
- **Restore.** Both paths below were drilled in `test/restore-test.sh`: the marker written before the backup came back both times.
  - **From the AOF archive** (preferred):
    1. `systemctl stop valkey`.
    2. `rm -rf /var/lib/valkey/appendonlydir`.
    3. `tar -C /var/lib/valkey -xzf aof-<stamp>.tar.gz`.
    4. `chown -R valkey:valkey /var/lib/valkey`, then `systemctl start valkey`.
  - **From an RDB copy.** With `appendonly yes` and no AOF, Valkey starts **empty** and ignores `dump.rdb`, so load the RDB once with AOF off:
    1. Stop Valkey, remove `appendonlydir`, copy the RDB into place and fix ownership:
       ```bash
       systemctl stop valkey
       rm -rf /var/lib/valkey/appendonlydir
       cp dump-<stamp>.rdb /var/lib/valkey/dump.rdb
       chown -R valkey:valkey /var/lib/valkey
       ```
    2. Start Valkey by hand with AOF off:
       ```bash
       sudo -u valkey /usr/local/bin/valkey-server /etc/valkey/valkey.conf --appendonly no --supervised no --daemonize yes --pidfile /var/lib/valkey/restore.pid
       ```
    3. As admin, run `CONFIG SET appendonly yes`. Wait for `INFO persistence` to show `aof_rewrite_in_progress:0`.
    4. As admin, run `SHUTDOWN`, then `systemctl start valkey`.

## Health check for the watchdog

`curl http://10.0.0.5:9121/health` returns `{"status":"ok|degraded|down", "reasons":[…], "memoryPercent":…, "aofEnabled":…, "lastBackupAgeHours":…}`.
- **Status code:** 503 only when Valkey does not answer.
- **degraded** means one of: AOF off or failing, RDB save failing, memory above 90% of maxmemory, or the last backup older than 36 h.

Register it with the watchdog: `install-reliability.ps1 -ValkeyHealthUrl http://10.0.0.5:9121/health -CacheService none`.

## Upgrades (patch or minor, for example 9.1.3 → 9.1.4)

1. Read the release notes on <https://github.com/valkey-io/valkey/releases> and take the SHA-256 from <https://github.com/valkey-io/valkey-hashes>.
2. Take a backup: `sudo systemctl start valkey-backup`.
3. Run `sudo VALKEY_VERSION=9.1.4 VALKEY_SHA256=<hash> MODE=… BIND_ADDR=… APP_ALLOW_FROM=… ./install-valkey.sh`.
   - It rebuilds, installs and restarts once.
   - The restart takes a few seconds. The gateway spools positions meanwhile, and System Health and the watchdog report the blip.
4. Check: `valkey-cli … INFO server | grep valkey_version`, `/health` reports ok, and `/api/health/tracking` reports OK on the Windows server.
5. Commit the new default `VALKEY_VERSION`/`VALKEY_SHA256` in `install-valkey.sh` after the upgrade.

For major versions (for example 9 → 10), test first with `test/kit-e2e.sh`, plus the chaos run against the test container (below).

**Rollback.** Re-run the installer with the previous version and hash. AOF/RDB formats are backward compatible within a major version. Across majors, restore the backup taken in step 2.

## Testing the kit (no cloud needed)

```bash
# in WSL / any Docker host
bash ops/valkey/test/kit-e2e.sh up        # build an Ubuntu 24.04 systemd container, install in MODE=tls
bash ops/valkey/test/kit-e2e.sh verify    # 26 checks: ACL, TLS, ufw, SSH, persistence, backup, health, crash restart, idempotency
# the app through TLS + ACL (Windows side), see docs/reliability/test-evidence.md §4:
REDIS_TLS_CA_FILE=ops/valkey/test/out/ca.crt REDIS_TLS_SERVERNAME=valkey.veetrax.internal CHAOS_DATABASE_URL=<_test db> \
  npx tsx apps/api/scripts/chaos/chaos-run.ts --cache-url "rediss://veetrax:$(cat ops/valkey/test/out/app.pass)@127.0.0.1:16380" \
  --cache-ctl docker:vt-valkey-kit --scenarios baseline,net-cut,cache-kill,dup-ooo
bash ops/valkey/test/kit-e2e.sh down
```
