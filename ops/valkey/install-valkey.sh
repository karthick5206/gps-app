#!/usr/bin/env bash
# VeeTrax Valkey host installer for Ubuntu 24.04 LTS (2 GB VM). Idempotent: re-run it to change settings or after an
# upgrade of VALKEY_VERSION; it rebuilds only when the installed version differs and restarts only when needed.
# Docs: ops/valkey/README.md. Run as root:
#
#   sudo MODE=private BIND_ADDR=10.0.0.5 APP_ALLOW_FROM=10.0.0.4 ADMIN_SSH_FROM=10.0.0.4 ./install-valkey.sh
#   sudo MODE=tls BIND_ADDR=203.0.113.7 APP_ALLOW_FROM=166.0.242.121 ADMIN_SSH_FROM=166.0.242.121 \
#        TLS_SANS="IP:203.0.113.7,DNS:valkey.veetrax.internal" ./install-valkey.sh
#
# Settings (environment):
#   MODE             private (plain TCP 6379, private network only) | tls (TLS 6380 only)          [private]
#   BIND_ADDR        interface address Valkey listens on (private IP, or the public IP for tls)  [required]
#   APP_ALLOW_FROM   comma-separated sources allowed to reach Valkey + the health endpoint       [166.0.242.121]
#   ADMIN_SSH_FROM   comma-separated sources allowed to SSH                                       [= APP_ALLOW_FROM]
#   MAXMEMORY        Valkey maxmemory                                                             [1gb]
#   TLS_SANS         subjectAltName for the server certificate (tls mode)                         [IP:$BIND_ADDR]
#   SKIP_UFW=1       do not touch the firewall (e.g. provider firewall only)
#   SKIP_SSH=1       do not touch sshd
#   FORCE_SSH_HARDEN=1  disable SSH passwords even if no authorized_keys file is found (lock-out risk)
set -euo pipefail

VALKEY_VERSION="${VALKEY_VERSION:-9.1.3}"
# Official hash: https://github.com/valkey-io/valkey-hashes (README), verified 2026-11-09.
VALKEY_SHA256="${VALKEY_SHA256:-184e34ed2d9b51879b682b5b15205e2b9d677c60280e3cb453be8f520d04e293}"
VALKEY_URL="https://github.com/valkey-io/valkey/archive/refs/tags/${VALKEY_VERSION}.tar.gz"
MODE="${MODE:-private}"
BIND_ADDR="${BIND_ADDR:?set BIND_ADDR to the private (or, for MODE=tls, public) interface address}"
APP_ALLOW_FROM="${APP_ALLOW_FROM:-166.0.242.121}"
ADMIN_SSH_FROM="${ADMIN_SSH_FROM:-$APP_ALLOW_FROM}"
MAXMEMORY="${MAXMEMORY:-1gb}"
TLS_SANS="${TLS_SANS:-IP:${BIND_ADDR}}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ETC=/etc/valkey
changed=0

log() { echo "[valkey-install] $*"; }
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ "$MODE" == private || "$MODE" == tls ]] || { echo "MODE must be private or tls" >&2; exit 1; }
if [[ "$BIND_ADDR" == 0.0.0.0 || "$BIND_ADDR" == '*' ]]; then echo "refusing to bind to all interfaces" >&2; exit 1; fi

# ---- packages ------------------------------------------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
need=(build-essential pkg-config libssl-dev libsystemd-dev curl ca-certificates openssl ufw logrotate python3)
missing=()
for p in "${need[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
if ((${#missing[@]})); then
  log "installing packages: ${missing[*]}"
  apt-get update -qq
  apt-get install -y -qq "${missing[@]}" >/dev/null
fi

# ---- build (pinned version, checksum verified) ---------------------------------------------------------------------
installed="$(/usr/local/bin/valkey-server --version 2>/dev/null | sed -n 's/.*v=\([0-9.]*\).*/\1/p' || true)"
if [[ "$installed" != "$VALKEY_VERSION" ]]; then
  log "building Valkey ${VALKEY_VERSION} (installed: ${installed:-none})"
  src=/usr/local/src/valkey-${VALKEY_VERSION}
  mkdir -p /usr/local/src
  tarball=/usr/local/src/valkey-${VALKEY_VERSION}.tar.gz
  [[ -f "$tarball" ]] || curl -fsSL -o "$tarball" "$VALKEY_URL"
  echo "${VALKEY_SHA256}  ${tarball}" | sha256sum -c - >/dev/null || { echo "CHECKSUM MISMATCH for $tarball" >&2; rm -f "$tarball"; exit 1; }
  rm -rf "$src" && mkdir -p "$src" && tar -xzf "$tarball" -C "$src" --strip-components=1
  make -C "$src" -j"$(nproc)" BUILD_TLS=yes USE_SYSTEMD=yes >/var/log/valkey-build.log 2>&1 || { tail -30 /var/log/valkey-build.log; exit 1; }
  make -C "$src" install PREFIX=/usr/local >/dev/null
  changed=1
fi
log "valkey-server: $(/usr/local/bin/valkey-server --version | cut -d' ' -f1-3)"

# ---- user and directories ------------------------------------------------------------------------------------------
id valkey >/dev/null 2>&1 || useradd --system --home-dir /var/lib/valkey --shell /usr/sbin/nologin valkey
install -d -m 750 -o valkey -g valkey /var/lib/valkey /var/log/valkey
install -d -m 750 -o root -g valkey "$ETC" "$ETC/tls"
install -d -m 700 -o root -g root "$ETC/secrets"
install -d -m 750 -o root -g valkey /var/backups/valkey

# ---- secrets and ACL users -----------------------------------------------------------------------------------------
gen_secret() { [[ -s "$1" ]] || { openssl rand -base64 36 | tr -d '/+=\n' | head -c 40 >"$1"; chmod 600 "$1"; changed=1; }; }
gen_secret "$ETC/secrets/app.pass"
gen_secret "$ETC/secrets/admin.pass"
# The health endpoint runs as the valkey user: its (PING + INFO only) password is group-readable.
gen_secret "$ETC/health.pass" && chown root:valkey "$ETC/health.pass" && chmod 640 "$ETC/health.pass"
sha() { printf '%s' "$(cat "$1")" | sha256sum | cut -d' ' -f1; }
acl_tmp="$(mktemp)"
# default: disabled and WITHOUT "nopass" — with nopass, protected-mode refuses every non-loopback client (found in the
# kit test). veetrax: the app; keys vt:* and route:* (routing cache), channels vt:*, everything but admin/dangerous
# commands (INFO is in @dangerous and needed by ioredis' ready check and System Health). admin: ops tools only.
cat >"$acl_tmp" <<EOF
user default off resetpass resetkeys resetchannels -@all
user veetrax on #$(sha "$ETC/secrets/app.pass") resetkeys ~vt:* ~route:* resetchannels &vt:* +@all -@admin -@dangerous +info +client|setname +client|setinfo +client|id
user admin on #$(sha "$ETC/secrets/admin.pass") ~* &* +@all
user health on #$(sha "$ETC/health.pass") resetkeys resetchannels -@all +ping +info
EOF
if ! cmp -s "$acl_tmp" "$ETC/users.acl" 2>/dev/null; then install -m 640 -o root -g valkey "$acl_tmp" "$ETC/users.acl"; changed=1; fi
rm -f "$acl_tmp"

# ---- TLS (self-managed CA) -----------------------------------------------------------------------------------------
tls_block=""
port=6379
if [[ "$MODE" == tls ]]; then
  port=0
  if [[ ! -s "$ETC/tls/server.crt" ]]; then
    TLS_SANS="$TLS_SANS" "$HERE/gen-certs.sh" "$ETC/tls"
    changed=1
  fi
  chown root:valkey "$ETC"/tls/*; chmod 640 "$ETC"/tls/*; chmod 600 "$ETC/tls/ca.key" 2>/dev/null || true
  tls_block="tls-port 6380
tls-cert-file $ETC/tls/server.crt
tls-key-file $ETC/tls/server.key
tls-ca-cert-file $ETC/tls/ca.crt
# The ACL password authenticates clients; set tls-auth-clients yes (and give the app a client certificate) for mTLS.
tls-auth-clients no
tls-protocols \"TLSv1.2 TLSv1.3\"
tls-prefer-server-ciphers yes
tls-replication no"
fi

# ---- valkey.conf ---------------------------------------------------------------------------------------------------
conf_tmp="$(mktemp)"
TLS_BLOCK="$tls_block" BIND="$BIND_ADDR" PORT="$port" MAXMEM="$MAXMEMORY" python3 - "$HERE/valkey.conf.template" >"$conf_tmp" <<'PY'
import os, sys
t = open(sys.argv[1]).read()
for k, v in {"@BIND@": os.environ["BIND"], "@PORT@": os.environ["PORT"], "@MAXMEMORY@": os.environ["MAXMEM"], "@TLS_BLOCK@": os.environ["TLS_BLOCK"] or "# TLS off (MODE=private): private network only"}.items():
    t = t.replace(k, v)
sys.stdout.write(t)
PY
if ! cmp -s "$conf_tmp" "$ETC/valkey.conf" 2>/dev/null; then install -m 640 -o root -g valkey "$conf_tmp" "$ETC/valkey.conf"; changed=1; fi
rm -f "$conf_tmp"

# ---- kernel settings recommended by Valkey -------------------------------------------------------------------------
echo 'vm.overcommit_memory = 1' >/etc/sysctl.d/60-valkey.conf
sysctl -q -p /etc/sysctl.d/60-valkey.conf 2>/dev/null || log "could not apply sysctl (container?)"

# ---- systemd, logrotate, backup, health ----------------------------------------------------------------------------
install_file() { # src dst mode
  if ! cmp -s "$1" "$2" 2>/dev/null; then install -m "$3" "$1" "$2"; changed=1; fi
}
install_file "$HERE/valkey.service" /etc/systemd/system/valkey.service 644
install_file "$HERE/valkey.logrotate" /etc/logrotate.d/valkey 644
install_file "$HERE/valkey-backup.sh" /usr/local/sbin/valkey-backup 750
install_file "$HERE/valkey-backup.service" /etc/systemd/system/valkey-backup.service 644
install_file "$HERE/valkey-backup.timer" /etc/systemd/system/valkey-backup.timer 644
install_file "$HERE/valkey-health.py" /usr/local/sbin/valkey-health 755
sed "s/@BIND@/${BIND_ADDR}/" "$HERE/valkey-health.service" >/tmp/valkey-health.service
install_file /tmp/valkey-health.service /etc/systemd/system/valkey-health.service 644
rm -f /tmp/valkey-health.service

systemctl daemon-reload
systemctl enable -q valkey valkey-health valkey-backup.timer
if [[ $changed -eq 1 ]] || ! systemctl is-active -q valkey; then
  log "restarting valkey"
  systemctl restart valkey
fi
systemctl restart valkey-health
systemctl start valkey-backup.timer

# ---- firewall: allow-list only -------------------------------------------------------------------------------------
if [[ "${SKIP_UFW:-0}" != 1 ]]; then
  ufw --force default deny incoming >/dev/null
  ufw --force default allow outgoing >/dev/null
  vport=$([[ "$MODE" == tls ]] && echo 6380 || echo 6379)
  IFS=',' read -ra apps <<<"$APP_ALLOW_FROM"
  for src in "${apps[@]}"; do
    ufw allow proto tcp from "$src" to any port "$vport" comment 'valkey (veetrax)' >/dev/null
    ufw allow proto tcp from "$src" to any port 9121 comment 'valkey health (veetrax)' >/dev/null
  done
  IFS=',' read -ra admins <<<"$ADMIN_SSH_FROM"
  for src in "${admins[@]}"; do ufw allow proto tcp from "$src" to any port 22 comment 'ssh admin' >/dev/null; done
  ufw --force enable >/dev/null
  log "ufw: $(ufw status | grep -c ALLOW) allow rule(s); default deny incoming"
fi

# ---- SSH: keys only ------------------------------------------------------------------------------------------------
if [[ "${SKIP_SSH:-0}" != 1 && -d /etc/ssh/sshd_config.d ]]; then
  keys=$(find /root/.ssh /home/*/.ssh -name authorized_keys -size +0 2>/dev/null | head -1 || true)
  if [[ -n "$keys" || "${FORCE_SSH_HARDEN:-0}" == 1 ]]; then
    cat >/etc/ssh/sshd_config.d/60-veetrax-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
EOF
    (sshd -t && (systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true)) || log "sshd config test failed; not reloaded"
    log "ssh: password login disabled (key found: ${keys:-forced})"
  else
    log "ssh: NO authorized_keys found; password login left enabled to avoid a lock-out (add a key, re-run)"
  fi
fi

# ---- verify --------------------------------------------------------------------------------------------------------
cli=(/usr/local/bin/valkey-cli --no-auth-warning --user admin --pass "$(cat "$ETC/secrets/admin.pass")")
if [[ "$MODE" == tls ]]; then
  cli+=(--tls --cacert "$ETC/tls/ca.crt" -h 127.0.0.1 -p 6380)
  sni="$(echo "$TLS_SANS" | grep -o 'DNS:[^,]*' | head -1 | cut -d: -f2 || true)"
  [[ -n "$sni" ]] && cli+=(--sni "$sni")
else
  cli+=(-h 127.0.0.1 -p 6379)
fi
for i in $(seq 1 20); do "${cli[@]}" ping 2>/dev/null | grep -q PONG && break; sleep 0.5; done
log "ping: $("${cli[@]}" ping)"
log "aof: $("${cli[@]}" config get appendonly | tail -1), maxmemory: $("${cli[@]}" config get maxmemory | tail -1), policy: $("${cli[@]}" config get maxmemory-policy | tail -1)"
log "users: $("${cli[@]}" acl users | tr '\n' ' ')"
echo
echo "App connection (put in C:\\apps\\veetracer\\app\\apps\\api\\.env on the Windows server):"
if [[ "$MODE" == tls ]]; then
  echo "  REDIS_URL=rediss://veetrax:<contents of $ETC/secrets/app.pass>@${BIND_ADDR}:6380"
  echo "  REDIS_TLS_CA_FILE=C:\\apps\\veetracer\\valkey-ca.crt   (copy of $ETC/tls/ca.crt)"
  echo "  REDIS_TLS_SERVERNAME=<a DNS name from TLS_SANS, if connecting by IP without an IP SAN>"
else
  echo "  REDIS_URL=redis://veetrax:<contents of $ETC/secrets/app.pass>@${BIND_ADDR}:6379"
fi
echo "Health for the watchdog: http://${BIND_ADDR}:9121/health"
