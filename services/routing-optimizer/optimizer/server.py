"""Minimal HTTP wrapper (stdlib) for the OR-Tools solver. Private service: token + source allow-list (phase 4).

  OPTIMIZER_TOKEN=<secret> python -m optimizer.server [--host 127.0.0.1] [--port 8090]
  GET  /health    -> {"ok": true, "ortools": "<version>", "limits": {...}, "slots": n, "busy": k}   (token required)
  POST /optimize  -> solve(problem)   (body <= 8 MB; OPTIMIZER_CONCURRENCY solves at once, then 429)

Security (owner decision 2026-11-09):
  * OPTIMIZER_TOKEN is mandatory: the server refuses to start without one (>= 24 characters) and every request must
    send `Authorization: Bearer <token>` (constant-time compare).
  * OPTIMIZER_ALLOW: comma-separated CIDRs allowed to connect (default 127.0.0.1/32,::1/128). Other sources get 403
    before the body is read.
  * --host / OPTIMIZER_HOST defaults to 127.0.0.1; a non-loopback bind (e.g. the WireGuard address) must be explicit.

Each solve runs in a worker process (spawn, at most OPTIMIZER_CONCURRENCY): OR-Tools holds the GIL while it searches
on C++ transit matrices, so solving in the HTTP process would stall /health and the 429 path. A crashed worker (e.g.
killed by MemoryMax) gives HTTP 503 and the pool is rebuilt for the next request.
"""
from __future__ import annotations

import argparse
import multiprocessing
import hmac
import ipaddress
import json
import os
import sys
import threading
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import ortools

from .solver import LIMITS, solve

MAX_BODY = 8 * 1024 * 1024
MIN_TOKEN = 24


def parse_allow(raw: str | None) -> list[ipaddress._BaseNetwork]:
    items = [x.strip() for x in (raw or '127.0.0.1/32,::1/128').split(',') if x.strip()]
    return [ipaddress.ip_network(x, strict=False) for x in items]


def allowed(addr: str, nets: list[ipaddress._BaseNetwork]) -> bool:
    try:
        ip = ipaddress.ip_address(addr.split('%')[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return any(ip.version == n.version and ip in n for n in nets)


class Config:
    def __init__(self, token: str, allow: list, slots: int):
        self.token = token
        self.allow = allow
        self.slots = threading.BoundedSemaphore(slots)
        self.size = slots
        self.busy = 0
        self.lock = threading.Lock()
        self.pool: ProcessPoolExecutor | None = None

    def solve(self, problem: dict) -> dict | None:
        """Solve in a worker process; None if the worker died (the pool is then rebuilt on the next call)."""
        with self.lock:
            if self.pool is None:
                self.pool = ProcessPoolExecutor(max_workers=self.size, mp_context=multiprocessing.get_context('spawn'),
                                                max_tasks_per_child=50)
            pool = self.pool
        try:
            return pool.submit(solve, problem).result()
        except BrokenProcessPool:
            with self.lock:
                if self.pool is pool:
                    self.pool = None
            pool.shutdown(wait=False, cancel_futures=True)
            return None

    def close(self) -> None:
        with self.lock:
            pool, self.pool = self.pool, None
        if pool is not None:
            pool.shutdown(wait=False, cancel_futures=True)


def make_handler(cfg: Config):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'veetrax-routing-optimizer/0.2'

        def _send(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _guard(self) -> bool:
            if not allowed(self.client_address[0], cfg.allow):
                self._send(403, {'error': 'source not allowed'})
                return False
            got = self.headers.get('Authorization', '')
            if not hmac.compare_digest(got.encode(), f'Bearer {cfg.token}'.encode()):
                self._send(401, {'error': 'unauthorised'})
                return False
            return True

        def do_GET(self) -> None:  # noqa: N802
            if not self._guard():
                return
            if self.path == '/health':
                self._send(200, {'ok': True, 'ortools': ortools.__version__, 'limits': LIMITS, 'slots': cfg.size, 'busy': cfg.busy})
            else:
                self._send(404, {'error': 'not found'})

        def do_POST(self) -> None:  # noqa: N802
            if not self._guard():
                return
            if self.path != '/optimize':
                return self._send(404, {'error': 'not found'})
            length = int(self.headers.get('Content-Length') or 0)
            if not 0 < length <= MAX_BODY:
                return self._send(413, {'error': f'body must be 1..{MAX_BODY} bytes'})
            try:
                problem = json.loads(self.rfile.read(length))
            except json.JSONDecodeError:
                return self._send(400, {'error': 'invalid JSON'})
            if not cfg.slots.acquire(blocking=False):
                return self._send(429, {'error': 'optimizer busy', 'slots': cfg.size})
            with cfg.lock:
                cfg.busy += 1
            try:
                result = cfg.solve(problem)
            finally:
                with cfg.lock:
                    cfg.busy -= 1
                cfg.slots.release()
            if result is None:
                return self._send(503, {'error': 'solver worker crashed'})
            self._send(400 if result['status'] == 'INVALID_INPUT' else 200, result)

        def log_message(self, fmt: str, *args) -> None:  # one line per request, never the body or headers
            print(f'{self.address_string()} {fmt % args}', flush=True)

    return Handler


def build_server(host: str, port: int, env: dict) -> ThreadingHTTPServer:
    token = env.get('OPTIMIZER_TOKEN', '')
    if len(token) < MIN_TOKEN:
        raise SystemExit(f'OPTIMIZER_TOKEN must be set (>= {MIN_TOKEN} characters); refusing to start')
    cfg = Config(token, parse_allow(env.get('OPTIMIZER_ALLOW')), max(1, int(env.get('OPTIMIZER_CONCURRENCY', '2'))))
    family_v6 = ':' in host

    def server_close(self) -> None:
        ThreadingHTTPServer.server_close(self)
        cfg.close()

    cls = type('Srv', (ThreadingHTTPServer,), {'address_family': __import__('socket').AF_INET6 if family_v6 else __import__('socket').AF_INET,
                                               'server_close': server_close})
    return cls((host, port), make_handler(cfg))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', default=os.environ.get('OPTIMIZER_HOST', '127.0.0.1'))
    ap.add_argument('--port', type=int, default=int(os.environ.get('OPTIMIZER_PORT', '8090')))
    a = ap.parse_args()
    srv = build_server(a.host, a.port, dict(os.environ))
    print(f'routing-optimizer listening on {a.host}:{a.port} (ortools {ortools.__version__}); token required; '
          f'allow {os.environ.get("OPTIMIZER_ALLOW", "127.0.0.1/32,::1/128")}', flush=True)
    try:
        srv.serve_forever()
    finally:
        srv.server_close()


if __name__ == '__main__':
    sys.exit(main())
