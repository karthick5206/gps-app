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
    monkeypatch.setattr(server, 'HANDLER_TIMEOUT_S', 1)
    srv, url = start({'OPTIMIZER_TOKEN': TOKEN, 'OPTIMIZER_MAX_CONNECTIONS': '2'})
    host, port = url.removeprefix('http://').split(':')
    try:
        # A silent client is dropped after the socket timeout (slow-loris).
        with socket.create_connection((host, int(port)), timeout=10) as s:
            s.sendall(b'POST /optimize HTTP/1.1\r\n')
            t0 = time.monotonic()
            assert s.recv(1024) == b''
            assert time.monotonic() - t0 < 8
        time.sleep(0.3)
        # Two idle connections hold both handler threads: a third is closed at once; once they go, service is back.
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
