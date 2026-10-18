#!/usr/bin/env bash
# Stops only the processes started by dev-start.sh (Valkey and PostgreSQL keep running).
RUN="$(cd "$(dirname "$0")/.." && pwd)/apps/api/var/run"
for f in "$RUN"/*.pid; do
  [ -e "$f" ] || continue
  kill "$(cat "$f")" 2>/dev/null && echo "stopped $(basename "$f" .pid)"
  rm -f "$f"
done
