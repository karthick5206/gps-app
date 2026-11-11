import { assertTransition, backoffMs, canTransition, decideFailure, decideLeaseExpiry, IllegalTransition, JobLogicalState, logicalState, phaseProgress, storedState, TRANSIENT_CODES } from './job-state';

const ALL: JobLogicalState[] = ['QUEUED', 'MATRIX', 'SOLVING', 'DONE', 'FAILED', 'CANCELLED'];

describe('optimisation job state machine (WP 4.2)', () => {
  it('maps database status + phase to the logical states and back', () => {
    expect(logicalState('QUEUED', null)).toBe('QUEUED');
    expect(logicalState('RUNNING', 'matrix')).toBe('MATRIX');
    expect(logicalState('RUNNING', null)).toBe('MATRIX');
    expect(logicalState('RUNNING', 'solve')).toBe('SOLVING');
    expect(logicalState('RUNNING', 'assign_stops')).toBe('SOLVING');
    expect(logicalState('RUNNING', 'route_legs')).toBe('SOLVING');
    expect(logicalState('SUCCEEDED', 'done')).toBe('DONE');
    expect(logicalState('FAILED', null)).toBe('FAILED');
    expect(logicalState('CANCELLED', null)).toBe('CANCELLED');
    for (const s of ALL) {
      const st = storedState(s);
      expect(logicalState(st.status, st.phase)).toBe(s);
    }
  });

  it('allows exactly the documented transitions', () => {
    const allowed = new Set([
      'QUEUED>MATRIX',
      'QUEUED>CANCELLED',
      'QUEUED>FAILED',
      'MATRIX>SOLVING',
      'MATRIX>QUEUED',
      'MATRIX>FAILED',
      'MATRIX>CANCELLED',
      'SOLVING>DONE',
      'SOLVING>QUEUED',
      'SOLVING>FAILED',
      'SOLVING>CANCELLED',
    ]);
    for (const a of ALL) for (const b of ALL) expect(canTransition(a, b)).toBe(allowed.has(`${a}>${b}`));
  });

  it('final states never move again; skipping the matrix is illegal', () => {
    for (const f of ['DONE', 'FAILED', 'CANCELLED'] as const) for (const to of ALL) expect(() => assertTransition(f, to)).toThrow(IllegalTransition);
    expect(() => assertTransition('QUEUED', 'SOLVING')).toThrow(IllegalTransition);
    expect(() => assertTransition('QUEUED', 'DONE')).toThrow(IllegalTransition);
    expect(() => assertTransition('MATRIX', 'DONE')).toThrow(IllegalTransition);
  });

  it('retries transient failures with exponential back-off until the attempt cap, then fails with the reason', () => {
    const now = 1_000_000;
    const e = { code: 'OPTIMIZER_UNAVAILABLE' as const, message: 'Optimizer unavailable' };
    const r1 = decideFailure(e, { attempts: 1, maxAttempts: 3, cancelRequested: false }, now);
    expect(r1).toMatchObject({ to: 'QUEUED', notBeforeMs: now + 5_000, error: { code: 'OPTIMIZER_UNAVAILABLE', retry: 5 } });
    const r2 = decideFailure(e, { attempts: 2, maxAttempts: 3, cancelRequested: false }, now);
    expect(r2).toMatchObject({ to: 'QUEUED', notBeforeMs: now + 10_000 });
    const r3 = decideFailure(e, { attempts: 3, maxAttempts: 3, cancelRequested: false }, now);
    expect(r3).toMatchObject({ to: 'FAILED', error: { code: 'OPTIMIZER_UNAVAILABLE' } });
    expect(r3.to === 'FAILED' && r3.error.message).toMatch(/gave up after 3 attempts/);
  });

  it.each(['INVALID_INPUT', 'LIMIT_EXCEEDED', 'PLAN_STALE', 'NO_ROUTE', 'NOT_IMPLEMENTED', 'TIMEOUT', 'POINT_NOT_ON_ROAD', 'INTERNAL_ERROR'] as const)('%s is final at once', (code) => {
    expect(decideFailure({ code, message: 'x' }, { attempts: 1, maxAttempts: 3, cancelRequested: false }, 0)).toMatchObject({ to: 'FAILED', error: { code } });
  });

  it('engine and optimiser outages and lost workers are transient', () => {
    for (const c of ['ENGINE_UNREACHABLE', 'ENGINE_TIMEOUT', 'GRAPH_REBUILDING', 'OPTIMIZER_UNAVAILABLE', 'OPTIMIZER_BUSY', 'WORKER_LOST'] as const) expect(TRANSIENT_CODES.has(c)).toBe(true);
  });

  it('a cancel request wins over a retry', () => {
    expect(decideFailure({ code: 'ENGINE_UNREACHABLE', message: 'down' }, { attempts: 1, maxAttempts: 3, cancelRequested: true }, 0)).toEqual({ to: 'CANCELLED' });
    expect(decideFailure({ code: 'CANCELLED', message: 'x' }, { attempts: 1, maxAttempts: 3, cancelRequested: false }, 0)).toEqual({ to: 'CANCELLED' });
  });

  it('lease expiry: re-queue for another worker, then FAILED WORKER_LOST at the cap; cancel → CANCELLED', () => {
    expect(decideLeaseExpiry({ attempts: 1, maxAttempts: 3, cancelRequested: false })).toMatchObject({ to: 'QUEUED', notBeforeMs: 0, error: { code: 'WORKER_LOST' } });
    expect(decideLeaseExpiry({ attempts: 3, maxAttempts: 3, cancelRequested: false })).toMatchObject({ to: 'FAILED', error: { code: 'WORKER_LOST' } });
    expect(decideLeaseExpiry({ attempts: 1, maxAttempts: 3, cancelRequested: true })).toEqual({ to: 'CANCELLED' });
  });

  it('back-off is capped at 5 minutes and progress stays within its band', () => {
    expect(backoffMs(1)).toBe(5_000);
    expect(backoffMs(4)).toBe(40_000);
    expect(backoffMs(20)).toBe(300_000);
    expect(phaseProgress(5, 40, 0)).toBe(5);
    expect(phaseProgress(5, 40, 0.5)).toBe(23);
    expect(phaseProgress(5, 40, 2)).toBe(40);
    expect(phaseProgress(5, 40, Number.NaN)).toBe(5);
  });
});
