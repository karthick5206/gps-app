"""C3 kit: guard for the Python helpers. The bash entry scripts run lib/guard.sh first; a helper started on its own
refuses unless that guard passed (C3_GUARD_PASSED) and re-checks URLs against the production list."""
import os
import re
import sys
from urllib.parse import urlparse

_PROD_HOST = re.compile(r'(^|\.)veetrax\.com\.?$', re.I)
_PROD_IPS = {'103.176.85.69'}


def host_of(u: str) -> str:
    return (urlparse(u if '://' in u else f'http://{u}').hostname or u).lower()


def c3_guard(urls=()) -> bool:
    """Exit 3 unless the bash guard passed; refuse production URLs. Returns True in a dry run."""
    if not os.environ.get('C3_GUARD_PASSED'):
        print('C3 GUARD REFUSED: run this helper through its ops/benchmarks/c3/*.sh script (lib/guard.sh).', file=sys.stderr)
        sys.exit(3)
    for u in urls:
        if u and (_PROD_HOST.search(host_of(u)) or host_of(u) in _PROD_IPS):
            print(f'C3 GUARD REFUSED: {host_of(u)} is production.', file=sys.stderr)
            sys.exit(3)
    return os.environ.get('C3_DRY') == '1' or '--dry-run' in sys.argv


def pct(values, p):
    if not values:
        return float('nan')
    s = sorted(values)
    import math
    return s[min(len(s) - 1, max(0, math.ceil(p / 100 * len(s)) - 1))]
