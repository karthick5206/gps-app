"""CLI:  python -m optimizer.cli problem.json [--pretty]

Reads a problem (see README) from a file or `-` (stdin) and prints the result JSON. The problem must carry its own
`matrix`: this service never calls a routing engine (the API builds the matrix from GraphHopper; README §5 D3).
Exit code 0 = FEASIBLE / OPTIMAL, 2 = NO_SOLUTION / INVALID_INPUT.
"""
from __future__ import annotations

import argparse
import json
import sys

from .solver import solve


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog='routing-optimizer')
    ap.add_argument('problem', help='problem JSON file, or - for stdin')
    ap.add_argument('--pretty', action='store_true')
    a = ap.parse_args(argv)
    if a.problem == '-':
        problem = json.load(sys.stdin)
    else:
        with open(a.problem, encoding='utf-8') as f:
            problem = json.load(f)
    result = solve(problem)
    json.dump(result, sys.stdout, indent=2 if a.pretty else None)
    sys.stdout.write('\n')
    return 0 if result['status'] in ('FEASIBLE', 'OPTIMAL') else 2


if __name__ == '__main__':
    sys.exit(main())
