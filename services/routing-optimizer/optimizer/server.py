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

Robustness (E4 security review L5):
  * The solve result is awaited at most timeLimitS + OPTIMIZER_RESULT_GRACE_S (default 30 s); a worker that does not
    answer by then is terminated, the pool rebuilt, and the request answered 503 (transient for the API).
  * Malformed input is always a JSON 400 (bad or missing Content-Length, invalid or too deeply nested JSON, wrong
    option types); any other failure is a JSON 500. A request is never answered by dropping the connection.
  * The solver slot is taken before the body is read; every connection has a 30 s socket timeout.

Connection limits (re-check R2): an unauthenticated client must not be able to block the service. A connection has
HEADER_TIMEOUT_S (5 s) to send its request line and headers; handler threads are capped at OPTIMIZER_MAX_PENDING
(default 64; further connections are closed at once), and only requests that passed the allow-list and the token
count toward OPTIMIZER_MAX_CONNECTIONS (default 16; beyond it a JSON 503). Idle unauthenticated sockets therefore
cost at most 5 s each and never take an authenticated slot.
"""
from __future__ import annotations

import argparse
import hmac
import ipaddress
import json
import multiprocessing
import os
import sys
import threading
import time
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout
from concurrent.futures.process import BrokenProcessPool
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import ortools

from .solver import LIMITS, solve

MAX_BODY = 8 * 1024 * 1024
MIN_TOKEN = 24
#: The solver wire format is a few levels deep (problem -> stops -> timeWindows -> pair); 32 is generous.
MAX_JSON_DEPTH = 32
#: Socket timeout of a connection (seconds): a client that sends nothing for this long is dropped.
HANDLER_TIMEOUT_S = 30
#: Time a connection has for its request line and headers (before auth), and while it idles between requests.
HEADER_TIMEOUT_S = 5
# T3-D6: after a 429 the unread body is read and thrown away (so the client, still uploading, sees the 429 instead of a
# reset): at most DRAIN_MAX_S in all, giving up when the client sends nothing for DRAIN_IDLE_S.
DRAIN_IDLE_S = 2
DRAIN_MAX_S = 15
# E4 review L4: every other early refusal of a POST (401, 403, 404, 413, 503 connection limit) drains the body the same
# way, so the API sees the real answer instead of a reset it would take for "busy". A refusal before authentication
# (401 / 403 / connection limit) drains for at most DRAIN_UNAUTH_MAX_S (no longer than a client may already take for
# its headers, R2); no drain reads more than DRAIN_MAX_BYTES.
DRAIN_UNAUTH_MAX_S = 5
DRAIN_MAX_BYTES = 16 * 1024 * 1024
# T3-D8: listen backlog (the default 5 made bursts of 16+ connections wait ~1 s for a SYN retransmit).
LISTEN_BACKLOG = 64


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
    def __init__(self, token: str, allow: list, slots: int, solve_fn=solve, grace_s: float = 30.0, max_authed: int = 16):
        self.token = token
        #: Authenticated requests in flight (R2): taken after _guard succeeds, released when the request ends.
        self.authed = threading.BoundedSemaphore(max(1, max_authed))
        self.max_authed = max(1, max_authed)
        self.allow = allow
        self.slots = threading.BoundedSemaphore(slots)
        self.size = slots
        self.busy = 0
        self.lock = threading.Lock()
        self.pool: ProcessPoolExecutor | None = None
        self.solve_fn = solve_fn
        self.grace_s = grace_s

    def _drop_pool(self, pool: ProcessPoolExecutor, terminate: bool) -> None:
        with self.lock:
            if self.pool is pool:
                self.pool = None
        if terminate:
            # A worker that ignores its time limit: kill it (shutdown alone would wait for the running task).
            for proc in list((getattr(pool, '_processes', None) or {}).values()):
                try:
                    proc.terminate()
                except Exception:  # noqa: BLE001 - already gone
                    pass
        pool.shutdown(wait=False, cancel_futures=True)

    def solve(self, problem: dict, time_limit_s: float) -> dict | str:
        """Solve in a worker process. Returns the result, or 'crashed' (the worker died) / 'timeout' (no answer within
        the time limit + grace: the workers are terminated). Either way the pool is rebuilt on the next call."""
        with self.lock:
            if self.pool is None:
                self.pool = ProcessPoolExecutor(max_workers=self.size, mp_context=multiprocessing.get_context('spawn'),
                                                max_tasks_per_child=50)
            pool = self.pool
        try:
            return pool.submit(self.solve_fn, problem).result(timeout=time_limit_s + self.grace_s)
        except BrokenProcessPool:
            self._drop_pool(pool, terminate=False)
            return 'crashed'
        except FuturesTimeout:
            self._drop_pool(pool, terminate=True)
            return 'timeout'

    def close(self) -> None:
        with self.lock:
            pool, self.pool = self.pool, None
        if pool is not None:
            pool.shutdown(wait=False, cancel_futures=True)


def json_depth_ok(value, limit: int = MAX_JSON_DEPTH) -> bool:
    """Iterative nesting check (no recursion)."""
    stack = [(value, 1)]
    while stack:
        v, d = stack.pop()
        if isinstance(v, (dict, list)):
            if d > limit:
                return False
            stack.extend((c, d + 1) for c in (v.values() if isinstance(v, dict) else v))
    return True


def requested_time_limit(problem) -> float:
    """The solver's own clamp of options.timeLimitS (solver.solve; default 10 s). Never raises."""
    opts = problem.get('options') if isinstance(problem, dict) else None
    v = opts.get('timeLimitS', 10) if isinstance(opts, dict) else 10
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float('inf'), float('-inf')):
        v = 10
    return float(max(1, min(int(v), LIMITS['timeLimitS'])))


class BadRequest(Exception):
    pass


def make_handler(cfg: Config):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'veetrax-routing-optimizer/0.3'
        # R2: until it has authenticated a client has HEADER_TIMEOUT_S for its request line and headers; an
        # authenticated request gets HANDLER_TIMEOUT_S (L5) for its body.
        timeout = HEADER_TIMEOUT_S
        _authed = False

        def _send(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            if code >= 400:
                self.send_header('Connection', 'close')
                self.close_connection = True
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
            # R2: only authenticated requests count toward OPTIMIZER_MAX_CONNECTIONS.
            if not cfg.authed.acquire(blocking=False):
                self._send(503, {'status': 'ERROR', 'error': 'optimizer connection limit reached', 'limit': cfg.max_authed})
                return False
            self._authed = True
            self.connection.settimeout(HANDLER_TIMEOUT_S)
            return True

        def _done(self) -> None:
            """End of a request: give back the authenticated slot; an idle keep-alive connection is on the header timeout."""
            if self._authed:
                self._authed = False
                cfg.authed.release()
            try:
                self.connection.settimeout(HEADER_TIMEOUT_S)
            except OSError:
                pass

        def _internal(self) -> None:
            exc = sys.exc_info()[0]
            print(f'{self.address_string()} internal error: {exc.__name__ if exc else "?"}', flush=True)  # class only, never the body
            try:
                self._send(500, {'status': 'ERROR', 'error': 'internal error'})
            except Exception:  # noqa: BLE001 - the client is gone
                pass

        def do_GET(self) -> None:  # noqa: N802
            try:
                if not self._guard():
                    return
                if self.path == '/health':
                    self._send(200, {'ok': True, 'ortools': ortools.__version__, 'limits': LIMITS, 'slots': cfg.size, 'busy': cfg.busy})
                else:
                    self._send(404, {'error': 'not found'})
            except Exception:  # noqa: BLE001 - never drop the connection without an answer
                self._internal()
            finally:
                self._done()

        def do_POST(self) -> None:  # noqa: N802
            try:
                self._post()
            except BadRequest as e:
                self._send(400, {'status': 'INVALID_INPUT', 'error': str(e)})
            except Exception:  # noqa: BLE001 - every other failure is a JSON 500
                self._internal()
            finally:
                self._done()

        def _length(self) -> int:
            raw = (self.headers.get('Content-Length') or '').strip()
            if not raw.isdigit():
                raise BadRequest('Content-Length must be a non-negative integer')
            return int(raw)

        def _discard_body(self, length: int, max_s: float = DRAIN_MAX_S) -> None:
            """Reads and drops up to `length` body bytes (at most DRAIN_MAX_BYTES, 64 KB at a time) within `max_s`; stops
            when the client goes quiet for DRAIN_IDLE_S or closes. Errors are ignored: the answer was already sent."""
            left, until = min(length, DRAIN_MAX_BYTES), time.monotonic() + max_s
            try:
                self.connection.settimeout(DRAIN_IDLE_S)
                while left > 0 and time.monotonic() < until:
                    chunk = self.rfile.read1(min(65536, left)) if hasattr(self.rfile, 'read1') else self.rfile.read(min(65536, left))
                    if not chunk:
                        break
                    left -= len(chunk)
            except OSError:
                pass
            self.close_connection = True

        def _read_problem(self, length: int) -> dict:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise BadRequest('body shorter than Content-Length')
            try:
                problem = json.loads(raw)
            except (ValueError, RecursionError):  # JSONDecodeError, bad UTF-8, nested too deep for the parser
                raise BadRequest('invalid JSON body') from None
            if not json_depth_ok(problem):
                raise BadRequest(f'JSON nested deeper than {MAX_JSON_DEPTH} levels')
            if not isinstance(problem, dict):
                raise BadRequest('problem must be an object')
            return problem

        def _declared_length(self) -> int:
            """Content-Length for draining after a refusal (0 when missing or malformed: nothing to drain)."""
            raw = (self.headers.get('Content-Length') or '').strip()
            return int(raw) if raw.isdigit() else 0

        def _post(self) -> None:
            if not self._guard():
                # L4: answered first, then the unread body is drained (bounded) so the client sees the 401 / 403 / 503.
                return self._discard_body(self._declared_length(), DRAIN_UNAUTH_MAX_S)
            if self.path != '/optimize':
                self._send(404, {'error': 'not found'})
                return self._discard_body(self._declared_length())
            length = self._length()
            if not 0 < length <= MAX_BODY:
                self._send(413, {'error': f'body must be 1..{MAX_BODY} bytes'})
                return self._discard_body(length)
            # L5: the slot is taken before the body is read and parsed, so at most OPTIMIZER_CONCURRENCY bodies are in
            # memory at once; a full service answers 429 at once, without parsing anything. T3-D6: the body is then read
            # and discarded in small chunks (never held), so a client still uploading a large body gets the 429 instead
            # of a reset; the connection closes afterwards.
            if not cfg.slots.acquire(blocking=False):
                self._send(429, {'error': 'optimizer busy', 'slots': cfg.size})
                return self._discard_body(length)
            with cfg.lock:
                cfg.busy += 1
            try:
                problem = self._read_problem(length)
                try:
                    result = cfg.solve(problem, requested_time_limit(problem))
                except (TypeError, ValueError, KeyError, IndexError, AttributeError, RecursionError):
                    # Raised inside the worker by a problem the validator let through: the input, not the service.
                    raise BadRequest('invalid problem') from None
            finally:
                with cfg.lock:
                    cfg.busy -= 1
                cfg.slots.release()
            if result == 'crashed':
                return self._send(503, {'status': 'ERROR', 'error': 'solver worker crashed'})
            if result == 'timeout':
                return self._send(503, {'status': 'ERROR', 'error': 'solver did not answer within its time limit; worker restarted'})
            if not isinstance(result, dict) or not isinstance(result.get('status'), str):
                return self._send(500, {'status': 'ERROR', 'error': 'solver answer is not a result'})
            self._send(400 if result['status'] == 'INVALID_INPUT' else 200, result)

        def log_message(self, fmt: str, *args) -> None:  # one line per request, never the body or headers
            print(f'{self.address_string()} {fmt % args}', flush=True)

    return Handler


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer with at most `max_connections` handler threads (OPTIMIZER_MAX_PENDING); further connections are
    closed at once. Pre-auth connections live at most HEADER_TIMEOUT_S while silent (R2)."""

    daemon_threads = True
    max_connections = 64

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self._conn = threading.BoundedSemaphore(self.max_connections)

    def process_request(self, request, client_address):
        if not self._conn.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._conn.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._conn.release()


def build_server(host: str, port: int, env: dict, solve_fn=solve) -> ThreadingHTTPServer:
    token = env.get('OPTIMIZER_TOKEN', '')
    if len(token) < MIN_TOKEN:
        raise SystemExit(f'OPTIMIZER_TOKEN must be set (>= {MIN_TOKEN} characters); refusing to start')
    cfg = Config(token, parse_allow(env.get('OPTIMIZER_ALLOW')), max(1, int(env.get('OPTIMIZER_CONCURRENCY', '2'))),
                 solve_fn=solve_fn, grace_s=float(env.get('OPTIMIZER_RESULT_GRACE_S', '30')),
                 max_authed=max(1, int(env.get('OPTIMIZER_MAX_CONNECTIONS', '16'))))
    family_v6 = ':' in host

    def server_close(self) -> None:
        BoundedThreadingHTTPServer.server_close(self)
        cfg.close()

    cls = type('Srv', (BoundedThreadingHTTPServer,), {
        'address_family': __import__('socket').AF_INET6 if family_v6 else __import__('socket').AF_INET,
        'server_close': server_close,
        'max_connections': max(2, int(env.get('OPTIMIZER_MAX_PENDING', '64'))),
        'request_queue_size': max(LISTEN_BACKLOG, int(env.get('OPTIMIZER_MAX_PENDING', '64'))),
    })
    srv = cls((host, port), make_handler(cfg))
    srv.cfg = cfg
    return srv


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
