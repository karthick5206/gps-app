#!/usr/bin/env bash
# Starts the Veetrax dev stack in the background: API, GT06 gateway, processor, notifier, summarizer, web, simulator.
# Usage: scripts/dev-start.sh [simulated-device-count]   (default 20; 0 = no simulator)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/apps/api/var/run"; LOGS="$ROOT/apps/api/var/logs"; mkdir -p "$RUN" "$LOGS"
BIN="$ROOT/node_modules/.bin"
COUNT="${1:-20}"

start() { # name, log, command...
  local name="$1" log="$2"; shift 2
  nohup "$@" > "$LOGS/$log" 2>&1 &
  echo $! > "$RUN/$name.pid"
}

valkey-cli ping >/dev/null 2>&1 || brew services start valkey
npm run build:shared --prefix "$ROOT" >/dev/null
(cd "$ROOT/apps/api" && npm run build >/dev/null)

cd "$ROOT/apps/api"
start api api.log node dist/main.js
start gateway gateway.log node dist/gateway/main.js
start processor processor.log node dist/processor/main.js
start notifier notifier.log node dist/notifier/main.js
start summarizer summarizer.log node dist/summarizer/main.js
(cd "$ROOT/apps/web" && start web web.log "$BIN/vite")
until curl -sf localhost:4000/api/health >/dev/null; do sleep 1; done
if [ "$COUNT" -gt 0 ]; then start sim sim.log "$BIN/tsx" src/simulator/gt06-sim.ts --count "$COUNT" --interval 5; fi

echo "Veetrax is running → http://localhost:5173   (logs: apps/api/var/logs, stop: scripts/dev-stop.sh)"
