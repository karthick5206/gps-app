"""Optimizer HTTP security (phase 4): mandatory token, source allow-list, slots -> 429."""
import json
import socket
import threading
import time
import urllib.error
import urllib.request

import pytest

from optimizer import server
from tests._stall import stall

TOKEN = 'x' * 32
PROBLEM = {'matrix': {'durationsS': [[0, 60], [60, 0]]}, 'vehicles': [{'id': 'v'}], 'stops': [{'id': 's', 'locationIndex': 1}],
           'options': {'timeLimitS': 1}}


def start(env):
    srv = server.build_server('127.0.0.1', 0, env)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, f'http://127.0.0.1:{srv.server_address[1]}'


def call(url, path, token=None, body=None):
    req = urllib.request.Request(url + path, json.dumps(body).encode() if body is not None else None,
                                 {'Content-Type': 'application/json', **({'Authorization': f'Bearer {token}'} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')


def test_refuses_to_start_without_a_strong_token():
    with pytest.raises(SystemExit):
        server.build_server('127.0.0.1', 0, {})
    with pytest.raises(SystemExit):
        server.build_server('127.0.0.1', 0, {'OPTIMIZER_TOKEN': 'short'})


def test_token_required_on_every_endpoint():
    srv, url = start({'OPTIMIZER_TOKEN': TOKEN})
    try:
        assert call(url, '/health')[0] == 401
        assert call(url, '/health', 'wrong' * 8)[0] == 401
        assert call(url, '/optimize', None, PROBLEM)[0] == 401
        code, body = call(url, '/health', TOKEN)
        assert code == 200 and body['slots'] == 2
        code, body = call(url, '/optimize', TOKEN, PROBLEM)
        assert code == 200 and body['status'] in ('FEASIBLE', 'OPTIMAL')
    finally:
        srv.shutdown()


def test_source_allow_list():
    srv, url = start({'OPTIMIZER_TOKEN': TOKEN, 'OPTIMIZER_ALLOW': '10.8.0.0/24'})  # loopback NOT allowed
    try:
        assert call(url, '/health', TOKEN)[0] == 403
    finally:
        srv.shutdown()
    assert server.allowed('10.8.0.7', server.parse_allow('10.8.0.0/24'))
    assert not server.allowed('10.9.0.7', server.parse_allow('10.8.0.0/24'))
    assert server.allowed('::ffff:127.0.0.1', server.parse_allow(None))


def test_slots_full_returns_429():
    srv, url = start({'OPTIMIZER_TOKEN': TOKEN, 'OPTIMIZER_CONCURRENCY': '1'})
    slow = {'matrix': {'durationsS': [[abs(i - j) * 60 for j in range(30)] for i in range(30)]}, 'vehicles': [{'id': 'a'}, {'id': 'b'}],
            'stops': [{'id': f's{i}', 'locationIndex': i} for i in range(1, 30)], 'options': {'timeLimitS': 3}}
    try:
        results = []
        th = threading.Thread(target=lambda: results.append(call(url, '/optimize', TOKEN, slow)[0]))
        th.start()
        time.sleep(0.5)
        assert call(url, '/optimize', TOKEN, PROBLEM)[0] == 429
        th.join()
        assert results == [200]
    finally:
        srv.shutdown()


# ------------------------------------------------------------------------------------------------------------------
# E4 security review L5: robustness (timeouts, malformed input, slot before body, bounded threads)
# ------------------------------------------------------------------------------------------------------------------

def raw(url, data: bytes, read_timeout=10.0) -> bytes:
    host, port = url.removeprefix('http://').split(':')
    with socket.create_connection((host, int(port)), timeout=read_timeout) as s:
        s.sendall(data)
        out = b''
        while True:
            try:
                chunk = s.recv(65536)
            except (TimeoutError, socket.timeout):
                break
            if not chunk:
                break
            out += chunk
        return out


def post_raw(url, body: bytes, length=None, token=TOKEN):
    head = f'POST /optimize HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\n'
    if length is not None:
        head += f'Content-Length: {length}\r\n'
    resp = raw(url, head.encode() + b'\r\n' + body)
    assert resp, 'connection dropped without an answer'
    status = int(resp.split(b' ', 2)[1])
    payload = resp.split(b'\r\n\r\n', 1)[1]
    return status, json.loads(payload or b'{}')


def test_malformed_input_is_always_a_json_400():
    srv, url = start({'OPTIMIZER_TOKEN': TOKEN})
    try:
        # deep JSON: RecursionError in the parser, and nesting past the depth limit
        assert post_raw(url, b'[' * 200000, str(200000)) == (400, {'status': 'INVALID_INPUT', 'error': 'invalid JSON body'})
        nested = 1
        for _ in range(40):
            nested = [nested]
        deep = json.dumps({**PROBLEM, 'x': nested}).encode()
        code, body = post_raw(url, deep, str(len(deep)))
        assert code == 400 and 'nested deeper' in body['error']
        # Content-Length not a number / missing / negative / too big
        assert post_raw(url, b'{}', 'abc')[0] == 400
        assert post_raw(url, b'{}', None)[0] == 400
        assert post_raw(url, b'{}', '-5')[0] == 400
        assert post_raw(url, b'', str(server.MAX_BODY + 1))[0] == 413
        # not JSON, not an object
        assert post_raw(url, b'{nope', '5')[0] == 400
        assert post_raw(url, b'[1,2]', '5')[0] == 400
        # wrong option types (formerly a ValueError in the worker and a dropped connection)
        for bad in ('abc', True, [1], {'a': 1}):
            code, body = call(url, '/optimize', TOKEN, {**PROBLEM, 'options': {'timeLimitS': bad}})
            assert code == 400 and body['status'] == 'INVALID_INPUT' and 'timeLimitS' in body['error'], (bad, code, body)
        assert call(url, '/optimize', TOKEN, {**PROBLEM, 'options': {'timeLimitS': 1.5}})[0] == 200
        # huge limits are clamped (the solver and the result timeout use the same clamp)
        assert server.requested_time_limit({'options': {'timeLimitS': 1e12}}) == 120
        assert server.requested_time_limit({'options': {'timeLimitS': 'abc'}}) == 10
        code, body = call(url, '/health', TOKEN)
        assert code == 200 and body['busy'] == 0
    finally:
        srv.shutdown()
        srv.server_close()


def test_worker_that_ignores_its_limit_is_terminated_and_the_pool_rebuilt():
    srv = server.build_server('127.0.0.1', 0, {'OPTIMIZER_TOKEN': TOKEN, 'OPTIMIZER_CONCURRENCY': '1', 'OPTIMIZER_RESULT_GRACE_S': '1'}, solve_fn=stall)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{srv.server_address[1]}'
    try:
        t0 = time.monotonic()
        code, body = call(url, '/optimize', TOKEN, {'options': {'timeLimitS': 1}, 'sleepS': 60})
        took = time.monotonic() - t0
        assert code == 503 and body['status'] == 'ERROR' and 'time limit' in body['error']
        assert took < 20, took  # 1 s limit + 1 s grace (+ worker spawn), not the 60 s the worker wanted
        assert srv.cfg.pool is None  # dropped; the next request builds a new pool
        assert call(url, '/health', TOKEN)[1]['busy'] == 0
        assert call(url, '/optimize', TOKEN, {'options': {'timeLimitS': 1}, 'sleepS': 0})[0] == 200
        # an exception raised inside the worker by bad input is a JSON 400, not a dropped connection
        code, body = call(url, '/optimize', TOKEN, {'raise': True})
        assert code == 400 and body == {'status': 'INVALID_INPUT', 'error': 'invalid problem'}
    finally:
        srv.shutdown()
        srv.server_close()


def test_slot_is_taken_before_the_body_is_read():
    srv = server.build_server('127.0.0.1', 0, {'OPTIMIZER_TOKEN': TOKEN, 'OPTIMIZER_CONCURRENCY': '1'}, solve_fn=stall)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{srv.server_address[1]}'
    try:
        busy = threading.Thread(target=lambda: call(url, '/optimize', TOKEN, {'options': {'timeLimitS': 1}, 'sleepS': 4}))
        busy.start()
        time.sleep(1.5)
        # Announces 1 MB but sends none of it: answered 429 at once, without waiting for (or reading) the body.
        t0 = time.monotonic()
        code, _ = post_raw(url, b'', str(1024 * 1024))
        assert code == 429 and time.monotonic() - t0 < 5
        busy.join()
    finally:
        srv.shutdown()
        srv.server_close()


def test_handler_timeout_and_bounded_threads(monkeypatch):
    monkeypatch.setattr(server, 'HEADER_TIMEOUT_S', 1)
    srv, url = start({'OPTIMIZER_TOKEN': TOKEN, 'OPTIMIZER_MAX_PENDING': '2'})
    host, port = url.removeprefix('http://').split(':')
    try:
        # A silent client is dropped after the header timeout (slow-loris), before any auth.
        with socket.create_connection((host, int(port)), timeout=10) as s:
            s.sendall(b'POST /optimize HTTP/1.1\r\n')
            t0 = time.monotonic()
            assert s.recv(1024) == b''
            assert time.monotonic() - t0 < 8
        time.sleep(0.3)
        # Two idle connections hold both handler threads (OPTIMIZER_MAX_PENDING=2): a third is closed at once; once they go, service is back.
        idle = [socket.create_connection((host, int(port)), timeout=10) for _ in range(2)]
        time.sleep(0.3)
        with socket.create_connection((host, int(port)), timeout=10) as s3:
            s3.sendall(b'GET /health HTTP/1.1\r\nHost: x\r\n\r\n')
            assert s3.recv(1024) == b''
        for s in idle:
            s.close()
        time.sleep(1.5)
        assert call(url, '/health', TOKEN)[0] == 200
    finally:
        srv.shutdown()
        srv.server_close()


def test_idle_unauthenticated_connections_cannot_block_the_service():
    """Re-check R2: 20 idle, unauthenticated connections (more than OPTIMIZER_MAX_CONNECTIONS) leave room for the API."""
    srv, url = start({'OPTIMIZER_TOKEN': TOKEN})
    host, port = url.removeprefix('http://').split(':')
    idle = []
    try:
        idle = [socket.create_connection((host, int(port)), timeout=10) for _ in range(20)]
        time.sleep(0.5)
        code, body = call(url, '/health', TOKEN)
        assert code == 200 and body['ok'] is True
        assert call(url, '/optimize', TOKEN, PROBLEM)[0] == 200
        # unauthenticated requests never take an authenticated slot either
        for _ in range(20):
            assert call(url, '/health', 'wrong' * 8)[0] == 401
        assert call(url, '/health', TOKEN)[0] == 200
    finally:
        for s in idle:
            s.close()
        srv.shutdown()
        srv.server_close()


def test_authenticated_requests_are_capped(monkeypatch):
    """Only authenticated requests in flight count toward OPTIMIZER_MAX_CONNECTIONS; beyond it a JSON 503."""
    srv = server.build_server('127.0.0.1', 0, {'OPTIMIZER_TOKEN': TOKEN, 'OPTIMIZER_CONCURRENCY': '2', 'OPTIMIZER_MAX_CONNECTIONS': '1'}, solve_fn=stall)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{srv.server_address[1]}'
    try:
        busy = threading.Thread(target=lambda: call(url, '/optimize', TOKEN, {'options': {'timeLimitS': 1}, 'sleepS': 3}))
        busy.start()
        time.sleep(1.5)
        code, body = call(url, '/health', TOKEN)
        assert code == 503 and body['error'] == 'optimizer connection limit reached'
        busy.join()
        assert call(url, '/health', TOKEN)[0] == 200  # the slot is given back when the request ends
    finally:
        srv.shutdown()
        srv.server_close()


# ------------------------------------------------------------------------------------------------------------------
# T3 E2E (load test, 2026-11-11): D6 large bodies on a busy optimiser, D8 listen backlog
# ------------------------------------------------------------------------------------------------------------------

def test_busy_with_a_large_body_still_answers_429_t3_d6():
    """A full service answered 429 without reading the body and closed: for bodies of about 0.9 MB or more the client
    was still uploading, got a reset / broken pipe and never saw the 429 (the API's client hung until its timeout)."""
    srv = server.build_server('127.0.0.1', 0, {'OPTIMIZER_TOKEN': TOKEN, 'OPTIMIZER_CONCURRENCY': '1'}, solve_fn=stall)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{srv.server_address[1]}'
    try:
        busy = threading.Thread(target=lambda: call(url, '/optimize', TOKEN, {'options': {'timeLimitS': 1}, 'sleepS': 6}))
        busy.start()
        time.sleep(1.5)
        for size in (1_000_000, 2_000_000, 4_000_000):
            big = {'options': {'timeLimitS': 1}, 'pad': 'x' * size}
            t0 = time.monotonic()
            try:
                code, body = call(url, '/optimize', TOKEN, big)
            except (ConnectionError, OSError) as e:  # BrokenPipe / ConnectionReset before the fix
                pytest.fail(f'{size} B body: connection dropped without the 429 ({type(e).__name__})')
            assert code == 429, size
            assert body.get('error') == 'optimizer busy'
            assert time.monotonic() - t0 < 5
        busy.join()
    finally:
        srv.shutdown()
        srv.server_close()


def test_listen_backlog_is_large_enough_for_bursts_t3_d8():
    """The default backlog of 5 made some answers in bursts of 16+ connections arrive about 1 s late (SYN retry)."""
    srv = server.build_server('127.0.0.1', 0, {'OPTIMIZER_TOKEN': TOKEN})
    try:
        assert srv.request_queue_size >= 64
        # 40 connections at once while nobody accepts: none waits for a SYN retransmit.
        host, port = srv.server_address[:2]
        socks, slow = [], 0
        for _ in range(40):
            t0 = time.monotonic()
            socks.append(socket.create_connection((host, port), timeout=5))
            slow += time.monotonic() - t0 > 0.5
        for s in socks:
            s.close()
        assert slow == 0
    finally:
        srv.server_close()


@pytest.mark.parametrize('case', ['401', '403', '404', '413'])
def test_every_early_refusal_of_a_large_body_is_answered_not_reset_review_l4(monkeypatch, case):
    """E4 review L4: only the 429 path drained the body, so a 401 / 403 / 413 (and 404) on a large upload could reach the
    client as a reset, which the API maps to OPTIMIZER_BUSY (a rotated token waited ~4 min and then said "busy")."""
    env = {'OPTIMIZER_TOKEN': TOKEN}
    if case == '403':
        env['OPTIMIZER_ALLOW'] = '10.8.0.0/24'  # loopback NOT allowed
    if case == '413':
        monkeypatch.setattr(server, 'MAX_BODY', 500_000)
    srv, url = start(env)
    try:
        for size in (1_000_000, 4_000_000):
            big = {'options': {'timeLimitS': 1}, 'pad': 'x' * size}
            token = 'y' * 32 if case == '401' else TOKEN
            path = '/nope' if case == '404' else '/optimize'
            try:
                code, _ = call(url, path, token, big)
            except (ConnectionError, OSError) as e:  # BrokenPipe / ConnectionReset before the fix
                pytest.fail(f'{case}, {size} B body: connection dropped without the answer ({type(e).__name__})')
            assert code == int(case), size
    finally:
        srv.shutdown()
        srv.server_close()


# ------------------------------------------------------------------------------------------------------------------
# E4 activation gates (2026-11-12): security review M1 (pre-auth exhaustion), E4 review L5 (429 drains)
# ------------------------------------------------------------------------------------------------------------------

def test_header_deadline_is_total_not_per_byte_gates_m1(monkeypatch):
    """A client trickling one header byte at a time kept its handler thread for ever (the timeout restarted per recv)."""
    monkeypatch.setattr(server, 'HEADER_TIMEOUT_S', 1)
    srv, url = start({'OPTIMIZER_TOKEN': TOKEN})
    host, port = url.removeprefix('http://').split(':')
    try:
        with socket.create_connection((host, int(port)), timeout=10) as s:
            t0 = time.monotonic()
            closed = False
            for ch in b'GET /health HTTP/1.1\r\nHost: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\r\n':
                try:
                    s.sendall(bytes([ch]))
                except OSError:
                    closed = True
                    break
                s.settimeout(0.4)
                try:
                    if s.recv(1024) == b'':
                        closed = True
                        break
                except TimeoutError:
                    pass
            assert closed, 'the trickling client was never dropped'
            assert time.monotonic() - t0 < 4
        assert call(url, '/health', TOKEN)[0] == 200
    finally:
        srv.shutdown()
        srv.server_close()


def test_disallowed_sources_cannot_take_every_handler_thread_gates_m1(monkeypatch):
    monkeypatch.setattr(server, 'MAX_DISALLOWED', 2)
    srv, url = start({'OPTIMIZER_TOKEN': TOKEN, 'OPTIMIZER_ALLOW': '10.8.0.0/24'})  # loopback NOT allowed
    host, port = url.removeprefix('http://').split(':')
    idle = []
    try:
        idle = [socket.create_connection((host, int(port)), timeout=10) for _ in range(2)]
        time.sleep(0.3)
        with socket.create_connection((host, int(port)), timeout=10) as s3:
            t0 = time.monotonic()
            s3.sendall(b'GET /health HTTP/1.1\r\nHost: x\r\n\r\n')
            assert s3.recv(1024) == b''  # closed before a thread: no 403 for a third disallowed connection
            assert time.monotonic() - t0 < 1
        for s in idle:
            s.close()
        time.sleep(0.5)
        assert call(url, '/health', TOKEN)[0] == 403  # the slots are given back
    finally:
        for s in idle:
            s.close()
        srv.shutdown()
        srv.server_close()


def test_a_draining_429_gives_its_authenticated_slot_back_review_l5():
    """E4 review L5: a 429 drain held its authenticated slot (OPTIMIZER_MAX_CONNECTIONS) for up to DRAIN_MAX_S."""
    srv = server.build_server('127.0.0.1', 0, {'OPTIMIZER_TOKEN': TOKEN, 'OPTIMIZER_CONCURRENCY': '1', 'OPTIMIZER_MAX_CONNECTIONS': '2'}, solve_fn=stall)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{srv.server_address[1]}'
    host, port = srv.server_address[:2]
    try:
        busy = threading.Thread(target=lambda: call(url, '/optimize', TOKEN, {'options': {'timeLimitS': 1}, 'sleepS': 4}))
        busy.start()
        time.sleep(1.0)
        # Authenticated upload that stalls half way: 429, then the server drains (waits for the rest of the body).
        with socket.create_connection((host, port), timeout=10) as slow:
            slow.sendall(f'POST /optimize HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 200000\r\n\r\n'.encode() + b'{' * 1000)
            assert b' 429 ' in slow.recv(4096).split(b'\r\n')[0] + b' '
            # While it drains, a third authenticated request still gets a slot (before: 503 connection limit).
            assert call(url, '/health', TOKEN)[0] == 200
        busy.join()
    finally:
        srv.shutdown()
        srv.server_close()
