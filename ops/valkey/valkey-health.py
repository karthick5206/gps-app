#!/usr/bin/env python3
"""Valkey health endpoint for the VeeTrax Windows watchdog (ops/deploy/windows/veetrax-watchdog.ps1 -ValkeyHealthUrl).

GET /health   JSON; 200 for ok / degraded, 503 for down
GET /metrics  Prometheus text (a handful of gauges)

Uses the ACL user "health" (PING + INFO only, no keys) through valkey-cli, so TLS settings match the server.
Listens on the address given as argv[1] (the private / allow-listed interface), port 9121; the firewall limits who
can reach it. No secrets or key contents are ever returned.
"""
import json
import os
import re
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONF = "/etc/valkey/valkey.conf"
PASS = "/etc/valkey/health.pass"
BACKUPS = "/var/backups/valkey"
CACHE_SEC = 5
_cache = {"at": 0.0, "body": None}


def cli_args():
    conf = open(CONF).read()
    args = ["/usr/local/bin/valkey-cli", "--no-auth-warning", "--user", "health", "--pass", open(PASS).read().strip()]
    if re.search(r"^tls-port 6380", conf, re.M):
        args += ["--tls", "--cacert", "/etc/valkey/tls/ca.crt", "-h", "127.0.0.1", "-p", "6380"]
        try:
            san = subprocess.run(["openssl", "x509", "-in", "/etc/valkey/tls/server.crt", "-noout", "-ext", "subjectAltName"],
                                 capture_output=True, text=True, timeout=5).stdout
            m = re.search(r"DNS:([^,\s]+)", san)
            if m:
                args += ["--sni", m.group(1)]
        except Exception:
            pass
    else:
        args += ["-h", "127.0.0.1", "-p", "6379"]
    return args


def info():
    out = subprocess.run(cli_args() + ["info", "everything"], capture_output=True, text=True, timeout=5)
    if out.returncode != 0 or not out.stdout.strip() or "ERR" in out.stdout[:20] or "NOAUTH" in out.stdout[:20]:
        raise RuntimeError((out.stderr or out.stdout).strip()[:200] or "no answer")
    data = {}
    for line in out.stdout.splitlines():
        if ":" in line and not line.startswith("#"):
            k, v = line.split(":", 1)
            data[k.strip()] = v.strip()
    return data


def last_backup_age_h():
    try:
        files = [os.path.join(BACKUPS, f) for f in os.listdir(BACKUPS) if f.startswith("dump-")]
        return round((time.time() - max(os.path.getmtime(f) for f in files)) / 3600, 1) if files else None
    except Exception:
        return None


def health():
    now = time.time()
    if _cache["body"] and now - _cache["at"] < CACHE_SEC:
        return _cache["body"]
    reasons = []
    try:
        i = info()
    except Exception as e:  # noqa: BLE001
        body = {"status": "down", "reasons": [f"valkey not answering: {e}"], "at": int(now)}
        _cache.update(at=now, body=body)
        return body
    used, maxm = int(i.get("used_memory", 0)), int(i.get("maxmemory", 0))
    pct = round(used * 100 / maxm, 1) if maxm else None
    if i.get("aof_enabled") != "1":
        reasons.append("appendonly is off")
    if i.get("aof_last_write_status", "ok") != "ok":
        reasons.append(f"AOF write status {i.get('aof_last_write_status')}")
    if i.get("rdb_last_bgsave_status", "ok") != "ok":
        reasons.append(f"last RDB save {i.get('rdb_last_bgsave_status')}")
    if pct is not None and pct > 90:
        reasons.append(f"memory {pct}% of maxmemory (writes fail at 100%: noeviction)")
    backup = last_backup_age_h()
    if backup is not None and backup > 36:
        reasons.append(f"last local backup {backup} h old")
    body = {
        "status": "degraded" if reasons else "ok",
        "reasons": reasons,
        "version": i.get("valkey_version") or i.get("redis_version"),
        "uptimeSec": int(i.get("uptime_in_seconds", 0)),
        "usedMemory": used,
        "maxMemory": maxm,
        "memoryPercent": pct,
        "aofEnabled": i.get("aof_enabled") == "1",
        "aofLastWrite": i.get("aof_last_write_status"),
        "rdbLastSave": i.get("rdb_last_bgsave_status"),
        "connectedClients": int(i.get("connected_clients", 0)),
        "rejectedConnections": int(i.get("rejected_connections", 0)),
        "evictedKeys": int(i.get("evicted_keys", 0)),
        "lastBackupAgeHours": backup,
        "at": int(now),
    }
    _cache.update(at=now, body=body)
    return body


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        path = self.path.split("?")[0]
        if path == "/health":
            b = health()
            payload = json.dumps(b).encode()
            self.send_response(503 if b["status"] == "down" else 200)
            self.send_header("Content-Type", "application/json")
        elif path == "/metrics":
            b = health()
            lines = [f'valkey_up {0 if b["status"] == "down" else 1}']
            for k in ("usedMemory", "maxMemory", "connectedClients", "rejectedConnections", "evictedKeys", "uptimeSec"):
                if k in b:
                    lines.append(f"valkey_{re.sub(r'(?<!^)(?=[A-Z])', '_', k).lower()} {b[k]}")
            payload = ("\n".join(lines) + "\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4")
        else:
            payload = b"not found\n"
            self.send_response(404)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer((sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1", 9121), Handler).serve_forever()
