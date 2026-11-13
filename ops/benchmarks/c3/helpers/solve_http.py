"""C3 R-5: posts a solver problem to the C3 optimiser service (POST /optimize, the real veetrax-optimizer unit with its
systemd caps) back to back for a duration, and records wall time, HTTP status and solver status per solve.

The token is read from C3_OPTIMIZER_TOKEN_FILE (a copy of /etc/veetrax/optimizer.env of the C3 host, mode 0600, or a
file with the bare token); it is never put on a command line or printed.

  run through ../r5-isolation.sh (never on its own):  python solve_http.py <problem.json> <duration s> <out.json>
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

REPO = os.environ.get('C3_REPO') or os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'ops', 'benchmarks', 'c3', 'lib'))
from c3guard import c3_guard  # noqa: E402


def token() -> str:
    raw = open(os.environ['C3_OPTIMIZER_TOKEN_FILE'], encoding='utf-8').read()
    for line in raw.splitlines():
        if line.startswith('OPTIMIZER_TOKEN='):
            return line.split('=', 1)[1].strip()
    return raw.strip()


def main():
    url = os.environ.get('C3_OPTIMIZER_URL', '').rstrip('/')
    dry = c3_guard([url])
    if dry:
        print(f'   plan: POST {url or "(C3_OPTIMIZER_URL unset)"}/optimize back to back for {sys.argv[2]} s')
        return
    body = open(sys.argv[1], 'rb').read()
    duration = float(sys.argv[2])
    tok = token()
    rows = []
    end = time.time() + duration
    while time.time() < end:
        req = urllib.request.Request(f'{url}/optimize', data=body, method='POST',
                                     headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {tok}'})
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=400) as r:
                res = json.loads(r.read())
                code = r.status
        except urllib.error.HTTPError as e:
            code, res = e.code, {}
            e.read()
        except Exception as e:  # noqa: BLE001 - connection refused / reset counts as a failed solve
            code, res = 0, {'error': type(e).__name__}
        wall = time.perf_counter() - t0
        row = {'http': code, 'status': res.get('status'), 'wallS': round(wall, 2), 'objective': res.get('objective'),
               'unassigned': len(res.get('unassigned', []) or []), 'solverWallMs': res.get('wallTimeMs'),
               't': time.strftime('%H:%M:%S')}
        rows.append(row)
        print(json.dumps(row), flush=True)
        if code in (429, 503, 0):
            time.sleep(5)
    json.dump({'rows': rows}, open(sys.argv[3], 'w', encoding='utf-8'), indent=2)


if __name__ == '__main__':
    main()
