#!/usr/bin/env bash
# Restore drill inside the kit test container: backup → destroy data → restore from the AOF archive and from the RDB copy.
set -euo pipefail
A=(valkey-cli --no-auth-warning --tls --cacert /etc/valkey/tls/ca.crt --sni valkey.veetrax.internal -h 127.0.0.1 -p 6380 --user admin --pass "$(cat /etc/valkey/secrets/admin.pass)")
"${A[@]}" set vt:restore:marker "before-backup" >/dev/null
sleep 1.2
systemctl start valkey-backup.service
aof=$(ls -t /var/backups/valkey/aof-*.tar.gz | head -1)
rdb=$(ls -t /var/backups/valkey/dump-*.rdb | head -1)
"${A[@]}" set vt:restore:marker "after-backup" >/dev/null
restore() { # how
  systemctl stop valkey
  rm -rf /var/lib/valkey/appendonlydir /var/lib/valkey/dump.rdb
  if [[ $1 == aof ]]; then
    tar -C /var/lib/valkey -xzf "$aof"
    chown -R valkey:valkey /var/lib/valkey
  else
    # With appendonly yes and no AOF, Valkey would start EMPTY and ignore dump.rdb: load the RDB with AOF off once,
    # then switch AOF on (rewrites a fresh AOF from the loaded data) and hand back to systemd.
    cp "$rdb" /var/lib/valkey/dump.rdb
    chown -R valkey:valkey /var/lib/valkey
    sudo -u valkey /usr/local/bin/valkey-server /etc/valkey/valkey.conf --appendonly no --supervised no --daemonize yes --pidfile /var/lib/valkey/restore.pid
    for _ in $(seq 1 20); do "${A[@]}" ping 2>/dev/null | grep -q PONG && break; sleep 0.5; done
    "${A[@]}" config set appendonly yes >/dev/null
    for _ in $(seq 1 60); do "${A[@]}" info persistence | grep -q 'aof_rewrite_in_progress:0' && "${A[@]}" info persistence | grep -q 'aof_enabled:1' && break; sleep 0.5; done
    "${A[@]}" shutdown >/dev/null 2>&1 || true
    sleep 1
  fi
  systemctl start valkey
  for _ in $(seq 1 20); do "${A[@]}" ping 2>/dev/null | grep -q PONG && break; sleep 0.5; done
  echo "restore from $1: marker = $("${A[@]}" get vt:restore:marker)"
}
restore aof
restore rdb
