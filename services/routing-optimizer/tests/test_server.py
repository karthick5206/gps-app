"""Optimizer HTTP security (phase 4): mandatory token, source allow-list, slots -> 429."""
import json
import threading
import time
import urllib.error
import urllib.request

import pytest

from optimizer import server

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
