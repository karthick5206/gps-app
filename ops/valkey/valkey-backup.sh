#!/usr/bin/env bash
# Local, rotated backup of Valkey's persistence files. Run daily by valkey-backup.timer (02:30), or by hand.
#   1. BGSAVE → wait for it → copy dump.rdb
#   2. tar the AOF directory (base RDB preamble + incremental files + manifest)
# Kept in /var/backups/valkey for KEEP_DAYS (default 7). Off-site copies are optional and NOT set up here (see
# ops/valkey/README.md "Backups"); no paid storage without the owner's approval.
set -euo pipefail
KEEP_DAYS="${KEEP_DAYS:-7}"
DEST=/var/backups/valkey
DATA=/var/lib/valkey
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
log() { echo "$(date -u +%FT%TZ) $*" | tee -a /var/log/valkey-backup.log; }

args=(--no-auth-warning --user admin --pass "$(cat /etc/valkey/secrets/admin.pass)")
if grep -q '^tls-port 6380' /etc/valkey/valkey.conf; then
  sni=$(openssl x509 -in /etc/valkey/tls/server.crt -noout -ext subjectAltName 2>/dev/null | grep -o 'DNS:[^,]*' | head -1 | cut -d: -f2 || true)
  args+=(--tls --cacert /etc/valkey/tls/ca.crt -h 127.0.0.1 -p 6380)
  [[ -n "$sni" ]] && args+=(--sni "$sni")
else
  args+=(-h 127.0.0.1 -p 6379)
fi
cli() { /usr/local/bin/valkey-cli "${args[@]}" "$@"; }

mkdir -p "$DEST"
before="$(cli lastsave)"
cli bgsave >/dev/null || true
for _ in $(seq 1 600); do
  [[ "$(cli lastsave)" != "$before" ]] && break
  sleep 1
done
[[ "$(cli lastsave)" != "$before" ]] || { log "ERROR: BGSAVE did not finish in 10 min"; exit 1; }
[[ "$(cli info persistence | tr -d '\r' | sed -n 's/^rdb_last_bgsave_status://p')" == ok ]] || { log "ERROR: BGSAVE failed"; exit 1; }

cp "$DATA/dump.rdb" "$DEST/dump-$stamp.rdb"
tar -C "$DATA" -czf "$DEST/aof-$stamp.tar.gz" appendonlydir
chmod 600 "$DEST"/*-"$stamp".*
find "$DEST" -maxdepth 1 -type f \( -name 'dump-*.rdb' -o -name 'aof-*.tar.gz' \) -mtime +"$KEEP_DAYS" -delete
log "backup ok: dump-$stamp.rdb ($(du -h "$DEST/dump-$stamp.rdb" | cut -f1)), aof-$stamp.tar.gz ($(du -h "$DEST/aof-$stamp.tar.gz" | cut -f1)); $(ls "$DEST" | wc -l) file(s) kept"
