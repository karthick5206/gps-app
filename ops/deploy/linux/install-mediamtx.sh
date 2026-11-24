#!/usr/bin/env bash
# Installs / upgrades MediaMTX (MIT, https://github.com/bluenviron/mediamtx) for RTMP dashcam live video (Jimi JC400 /
# JC261) and runs it as systemd unit veetrax-mediamtx. Run as root from the app directory:
#   bash ops/deploy/linux/install-mediamtx.sh
# Opens TCP 1935 (RTMP from cameras) in ufw; HLS (8888) and the API (9997) stay on localhost.
set -euo pipefail
VERSION="${MEDIAMTX_VERSION:-v1.9.3}"
APP_DIR="${APP_DIR:-/opt/veetrax/app}"
BIN=/usr/local/bin/mediamtx
CONF=/etc/veetrax/mediamtx.yml

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/m.tar.gz" "https://github.com/bluenviron/mediamtx/releases/download/${VERSION}/mediamtx_${VERSION}_linux_amd64.tar.gz"
tar -xzf "$tmp/m.tar.gz" -C "$tmp" mediamtx
install -m 0755 "$tmp/mediamtx" "$BIN"
install -d -m 0755 /etc/veetrax
install -m 0644 "$APP_DIR/ops/deploy/linux/mediamtx.yml" "$CONF"

cat > /etc/systemd/system/veetrax-mediamtx.service <<UNIT
[Unit]
Description=VeeTrax MediaMTX (RTMP dashcam live video)
After=network-online.target
Wants=network-online.target

[Service]
User=veetrax
ExecStart=$BIN $CONF
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now veetrax-mediamtx
systemctl restart veetrax-mediamtx
command -v ufw >/dev/null && ufw allow 1935/tcp comment 'RTMP dashcams (MediaMTX)' >/dev/null || true
sleep 2
systemctl is-active veetrax-mediamtx
curl -fsS http://127.0.0.1:9997/v3/paths/list >/dev/null && echo "MediaMTX ${VERSION} API OK"
