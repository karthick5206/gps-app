"""The production systemd unit keeps the documented crash behaviour (E4 E2E load test T3, defect T3-1).

server.py and the README promise that a solver worker killed by MemoryMax answers HTTP 503 and the pool is rebuilt,
while the HTTP process keeps serving. systemd's default OOMPolicy=stop instead stops the WHOLE service when the kernel
OOM killer kills any process of the unit: the in-flight request is dropped without an answer and every caller gets
"connection refused" until Restart=on-failure brings it back (RestartSec=10). Measured on systemd 259 with the unit's
own caps; OOMPolicy=continue gives the 503 + pool rebuild path. No systemd is needed for this test: it reads the file.
"""
import os

UNIT = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'ops', 'deploy', 'linux', 'veetrax-optimizer.service')


def directives(path: str) -> dict[str, str]:
    out: dict[str, str] = {}
    with open(path, encoding='utf-8') as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith(('#', ';', '[')) or '=' not in line:
                continue
            k, v = line.split('=', 1)
            out[k.strip()] = v.strip()  # last one wins, as in systemd for these single-value settings
    return out


def test_worker_oom_kill_does_not_stop_the_service():
    d = directives(UNIT)
    assert d.get('MemoryMax'), 'the unit caps memory'
    assert d.get('OOMPolicy') == 'continue', 'a worker OOM kill must give 503 + pool rebuild, not stop the whole service'


def test_service_restarts_if_the_http_process_itself_dies():
    d = directives(UNIT)
    assert d.get('Restart') == 'on-failure'
