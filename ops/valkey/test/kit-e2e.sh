#!/usr/bin/env bash
# End-to-end test of the ops/valkey kit in a throwaway Ubuntu 24.04 systemd container (run in WSL / any Docker host).
#   bash ops/valkey/test/kit-e2e.sh [up|verify|down]
# up:     build the image, start container vt-valkey-kit (TLS port published on 127.0.0.1:16380, health on :19121),
#         install the kit in MODE=tls with an ACL app user, and copy the CA + app password to ./out/
# verify: ACL, TLS, firewall, SSH, persistence, backup, health, restart-on-crash, logrotate, idempotent re-run
# down:   remove the container
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
KIT="$(cd "$HERE/.." && pwd)"
NAME=vt-valkey-kit
OUT="$HERE/out"
pass=0; fail=0
check() { # description, command...
  local d="$1"; shift
  if "$@" >/tmp/kit-check.log 2>&1; then echo "PASS  $d"; pass=$((pass + 1)); else echo "FAIL  $d"; sed 's/^/      /' /tmp/kit-check.log | tail -5; fail=$((fail + 1)); fi
}
dx() { docker exec "$NAME" bash -lc "$*"; }

up() {
  docker build -q -t vt-ubuntu2404-systemd "$HERE" >/dev/null
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --hostname valkey-test --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    -p 127.0.0.1:16380:6380 -p 127.0.0.1:19121:9121 vt-ubuntu2404-systemd >/dev/null
  for _ in $(seq 1 30); do dx 'systemctl is-system-running 2>/dev/null' | grep -qE 'running|degraded' && break; sleep 1; done
  docker cp "$KIT" "$NAME":/opt/valkey-kit
  # A throwaway admin key so the SSH hardening path runs (key-only login).
  dx 'mkdir -p /root/.ssh && ssh-keygen -q -t ed25519 -N "" -f /root/.ssh/test_admin && cp /root/.ssh/test_admin.pub /root/.ssh/authorized_keys'
  local ip gw
  ip=$(dx "hostname -I | awk '{print \$1}'" | tr -d '\r')
  gw=$(dx "ip route | awk '/default/ {print \$3}'" | tr -d '\r')
  echo "container $ip, docker gateway (where published-port clients come from) $gw"
  dx "cd /opt/valkey-kit && MODE=tls BIND_ADDR=$ip APP_ALLOW_FROM=$gw ADMIN_SSH_FROM=$gw TLS_SANS='IP:$ip,IP:127.0.0.1,DNS:valkey.veetrax.internal' bash install-valkey.sh" || { echo "install failed"; exit 1; }
  mkdir -p "$OUT"
  docker cp "$NAME":/etc/valkey/tls/ca.crt "$OUT/ca.crt"
  dx 'cat /etc/valkey/secrets/app.pass' >"$OUT/app.pass"
  chmod 600 "$OUT/app.pass"
}

verify() {
  local ADM="--no-auth-warning --tls --cacert /etc/valkey/tls/ca.crt --sni valkey.veetrax.internal -h 127.0.0.1 -p 6380"
  local admin="valkey-cli $ADM --user admin --pass \$(cat /etc/valkey/secrets/admin.pass)"
  local app="valkey-cli $ADM --user veetrax --pass \$(cat /etc/valkey/secrets/app.pass)"
  check "valkey ${VALKEY_EXPECT:-9.1.3} running under systemd (Type=notify)" dx "systemctl is-active valkey && valkey-server --version | grep -q 'v=${VALKEY_EXPECT:-9.1.3}'"
  check "health endpoint service active" dx 'systemctl is-active valkey-health'
  check "backup timer scheduled" dx 'systemctl is-enabled valkey-backup.timer && systemctl list-timers valkey-backup.timer --no-pager | grep -q valkey-backup'
  check "plain TCP port is closed (TLS only)" dx '! (exec 3<>/dev/tcp/127.0.0.1/6379) 2>/dev/null'
  check "TLS with the kit CA works (admin PING)" dx "$admin ping | grep -q PONG"
  check "TLS without the CA is rejected" dx "! valkey-cli --no-auth-warning --tls -h 127.0.0.1 -p 6380 --user admin --pass x ping 2>&1 | grep -q PONG"
  check "default user disabled (no auth → NOAUTH/WRONGPASS)" dx "valkey-cli --tls --cacert /etc/valkey/tls/ca.crt -h 127.0.0.1 -p 6380 ping 2>&1 | grep -qiE 'noauth|wrongpass|auth'"
  check "remote (non-loopback) client authenticates as the app user (protected-mode does not block it)" dx "valkey-cli --no-auth-warning --tls --cacert /etc/valkey/tls/ca.crt --sni valkey.veetrax.internal -h \$(hostname -I | awk '{print \$1}') -p 6380 --user veetrax --pass \$(cat /etc/valkey/secrets/app.pass) ping | grep -q PONG"
  check "wrong password rejected" dx "valkey-cli $ADM --user veetrax --pass wrong ping 2>&1 | grep -qi wrongpass"
  check "app user: vt:* keys allowed" dx "$app set vt:kit:probe 1 EX 60 | grep -q OK && $app get vt:kit:probe | grep -q 1"
  check "app user: route:* keys allowed" dx "$app set route:eta:kit 1 EX 60 | grep -q OK"
  check "app user: keys outside vt:/route: denied" dx "$app set other:key 1 2>&1 | grep -q NOPERM"
  check "app user: streams + consumer groups + XAUTOCLAIM" dx "$app del vt:kit:s >/dev/null && $app xadd vt:kit:s '*' a 1 >/dev/null && $app xgroup create vt:kit:s g 0 | grep -q OK && $app xreadgroup group g c count 1 streams vt:kit:s '>' >/dev/null && $app xautoclaim vt:kit:s g c 0 0-0 >/dev/null && $app xinfo groups vt:kit:s | grep -q lag"
  check "app user: EVAL Lua, PUBLISH vt:*, INFO allowed" dx "$app eval \"return redis.call('GET', KEYS[1])\" 1 vt:kit:probe | grep -q 1 && $app publish vt:kit:ch x >/dev/null && $app info server | grep -q valkey_version"
  check "app user: FLUSHALL / KEYS / CONFIG / SHUTDOWN / ACL / DEBUG denied" dx "$app flushall 2>&1 | grep -q NOPERM && $app keys vt:kit 2>&1 | grep -q NOPERM && $app config get maxmemory 2>&1 | grep -q NOPERM && $app shutdown nosave 2>&1 | grep -q NOPERM && $app acl list 2>&1 | grep -q NOPERM && $app debug sleep 0 2>&1 | grep -qE 'NOPERM|not allowed'"
  check "app user: PUBLISH outside vt:* denied" dx "$app publish other x 2>&1 | grep -q NOPERM"
  check "persistence: appendonly yes, everysec, noeviction, maxmemory 1gb, RDB save rules" dx "$admin config get appendonly | grep -qx yes && $admin config get appendfsync | grep -qx everysec && $admin config get maxmemory-policy | grep -qx noeviction && $admin config get maxmemory | grep -qx 1073741824 && $admin config get save | grep -q 3600"
  check "bound to the container interface + loopback only (not 0.0.0.0)" dx "$admin config get bind | tail -1 | grep -qv '0.0.0.0' && ! ss -ltn | grep -q '0.0.0.0:6380'"
  check "ufw: default deny, valkey/health/ssh allowed only from the allow-list" dx "ufw status verbose | grep -q 'Default: deny (incoming)' && ufw status | grep -E '6380|9121|22' | grep -v -q Anywhere"
  check "ssh: password login disabled, key login configured" dx "sshd -T 2>/dev/null | grep -qx 'passwordauthentication no' && sshd -T 2>/dev/null | grep -qx 'kbdinteractiveauthentication no'"
  check "systemd hardening applied (NoNewPrivileges, ProtectSystem=strict)" dx "systemctl show valkey -p NoNewPrivileges -p ProtectSystem | grep -q 'NoNewPrivileges=yes' && systemctl show valkey -p ProtectSystem | grep -q strict"
  check "health endpoint JSON ok (from the container IP)" dx "curl -fsS http://\$(hostname -I | awk '{print \$1}'):9121/health | grep -q '\"status\": \"ok\"'"
  check "backup: BGSAVE + AOF archive written to /var/backups/valkey" dx 'systemctl start valkey-backup.service && ls /var/backups/valkey | grep -q "^dump-" && ls /var/backups/valkey | grep -q "^aof-"'
  check "data survives a crash: kill -9 → systemd restarts it, key still there (AOF)" dx "$app set vt:kit:durable yes | grep -q OK && sleep 1.5 && systemctl kill -s SIGKILL valkey && sleep 4 && systemctl is-active valkey && $app get vt:kit:durable | grep -q yes"
  check "logrotate config valid" dx 'logrotate -d /etc/logrotate.d/valkey 2>&1 | grep -q "rotating pattern"'
  check "installer is idempotent (re-run: no rebuild, no restart)" dx "pid=\$(systemctl show -p MainPID --value valkey); cd /opt/valkey-kit && MODE=tls BIND_ADDR=\$(hostname -I | awk '{print \$1}') APP_ALLOW_FROM=\$(ip route | awk '/default/ {print \$3}') TLS_SANS='IP:x' bash install-valkey.sh >/tmp/rerun.log 2>&1 && ! grep -q 'building Valkey' /tmp/rerun.log && [ \"\$pid\" = \"\$(systemctl show -p MainPID --value valkey)\" ]"
  echo "---- $pass passed, $fail failed"
  [[ $fail -eq 0 ]]
}

down() { docker rm -f "$NAME" >/dev/null 2>&1; rm -rf "$OUT"; echo "removed $NAME"; }

# Copy the current kit into the running container and re-run the installer (tests the upgrade / re-run path).
reinstall() {
  docker cp "$KIT/." "$NAME":/opt/valkey-kit
  dx "cd /opt/valkey-kit && MODE=tls BIND_ADDR=\$(hostname -I | awk '{print \$1}') APP_ALLOW_FROM=\$(ip route | awk '/default/ {print \$3}') ADMIN_SSH_FROM=\$(ip route | awk '/default/ {print \$3}') TLS_SANS='IP:x' bash install-valkey.sh" | grep -E 'valkey-install'
}

case "${1:-up}" in
  up) up ;;
  reinstall) reinstall ;;
  verify) verify ;;
  down) down ;;
  *) echo "usage: $0 up|verify|down"; exit 2 ;;
esac
