"""Stand-in solver for the server robustness tests (importable by the spawned worker): ignores every time limit."""
import time


def stall(problem):
    if problem.get('raise'):
        raise KeyError('bad input reached the worker')
    time.sleep(float(problem.get('sleepS', 60)))
    return {'schemaVersion': 2, 'status': 'FEASIBLE', 'provenOptimal': False, 'routes': [], 'unassigned': []}
