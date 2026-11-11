import type { RoutingJobError, RoutingJobPhase, RoutingJobStatus } from '@veetracer/shared';

/**
 * Optimisation job state machine (E4 WP 4.2, doc 17 §7 P8). Pure: no I/O, so every rule is unit-tested.
 *
 * The lifecycle the dispatcher sees:
 *
 *     QUEUED ──claim──▶ MATRIX ──▶ SOLVING ──▶ DONE
 *        │                │           │
 *        │                └─────┬─────┘
 *        │                      ├── transient error, attempts left ──▶ QUEUED (notBefore = back-off)
 *        │                      ├── lease expired (worker died), attempts left ──▶ QUEUED (another worker takes over)
 *        │                      ├── permanent error / attempts used up / timeout ──▶ FAILED (with a reason)
 *        │                      └── cancel requested (checked between steps) ──▶ CANCELLED
 *        └── cancel ──▶ CANCELLED (at once)
 *
 * In the database (`RoutingJob`, migration routing_engine_v2) a logical state is `status` + `phase`:
 * QUEUED = status QUEUED; MATRIX = RUNNING + phase `matrix`; SOLVING = RUNNING + phase `solve` (or `assign_stops` /
 * `route_legs`, the sub-steps around the solve); DONE = SUCCEEDED (phase `done`); FAILED / CANCELLED = the same status.
 * The API exposes `state` (lower case status) and `phase` (shared `RoutingJobDto`).
 */
export type JobLogicalState = 'QUEUED' | 'MATRIX' | 'SOLVING' | 'DONE' | 'FAILED' | 'CANCELLED';

export const FINAL_STATES: readonly JobLogicalState[] = ['DONE', 'FAILED', 'CANCELLED'];

/** Error codes of a job: the shared ones plus the two the worker itself produces. */
export type JobErrorCode = RoutingJobError['code'] | 'WORKER_LOST' | 'INTERNAL_ERROR';

export interface JobErrorBody {
  code: JobErrorCode;
  message: string;
  /** Seconds until the next attempt (only while a retry is pending). */
  retry?: number;
  /** Attempt the error happened in. */
  attempt?: number;
}

export function logicalState(status: RoutingJobStatus, phase: string | null | undefined): JobLogicalState {
  switch (status) {
    case 'QUEUED':
      return 'QUEUED';
    case 'SUCCEEDED':
      return 'DONE';
    case 'FAILED':
      return 'FAILED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'RUNNING':
      return phase === 'matrix' || !phase ? 'MATRIX' : 'SOLVING';
  }
}

/** Database columns of a logical state (`phase` null = leave unchanged / none). */
export function storedState(state: JobLogicalState): { status: RoutingJobStatus; phase: RoutingJobPhase | null } {
  switch (state) {
    case 'QUEUED':
      return { status: 'QUEUED', phase: null };
    case 'MATRIX':
      return { status: 'RUNNING', phase: 'matrix' };
    case 'SOLVING':
      return { status: 'RUNNING', phase: 'solve' };
    case 'DONE':
      return { status: 'SUCCEEDED', phase: 'done' };
    case 'FAILED':
      return { status: 'FAILED', phase: null };
    case 'CANCELLED':
      return { status: 'CANCELLED', phase: null };
  }
}

/** Allowed transitions. Anything else is a bug (asserted in the runner and the stores). */
const NEXT: Record<JobLogicalState, readonly JobLogicalState[]> = {
  QUEUED: ['MATRIX', 'CANCELLED', 'FAILED'],
  MATRIX: ['SOLVING', 'QUEUED', 'FAILED', 'CANCELLED'],
  SOLVING: ['DONE', 'QUEUED', 'FAILED', 'CANCELLED'],
  DONE: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: JobLogicalState, to: JobLogicalState): boolean {
  return NEXT[from].includes(to);
}

export class IllegalTransition extends Error {
  constructor(
    readonly from: JobLogicalState,
    readonly to: JobLogicalState,
  ) {
    super(`illegal routing job transition ${from} → ${to}`);
  }
}

export function assertTransition(from: JobLogicalState, to: JobLogicalState): void {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
}

/**
 * Errors worth another attempt: the road engine or the optimiser was down, busy or slow, or the worker died. Bad
 * input, limits, a stale plan, no route and similar are permanent (a retry would give the same answer).
 */
export const TRANSIENT_CODES: ReadonlySet<JobErrorCode> = new Set<JobErrorCode>([
  'ENGINE_UNREACHABLE',
  'ENGINE_TIMEOUT',
  'GRAPH_REBUILDING',
  'OPTIMIZER_UNAVAILABLE',
  'OPTIMIZER_BUSY',
  'WORKER_LOST',
]);

/** Exponential back-off: 5 s, 10 s, 20 s, … capped at 5 min. */
export function backoffMs(attempt: number): number {
  return Math.min(5 * 60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
}

export type FailureDecision =
  | { to: 'QUEUED'; notBeforeMs: number; error: JobErrorBody }
  | { to: 'FAILED'; error: JobErrorBody }
  | { to: 'CANCELLED' };

/**
 * What happens after an attempt ended without a result. `attempts` = attempts used so far (the current one included).
 * A cancel request always wins; a timeout is final (the job's whole budget is spent, not one call's).
 */
export function decideFailure(
  e: { code: JobErrorCode; message: string },
  job: { attempts: number; maxAttempts: number; cancelRequested: boolean },
  now: number,
): FailureDecision {
  if (job.cancelRequested || e.code === 'CANCELLED') return { to: 'CANCELLED' };
  if (TRANSIENT_CODES.has(e.code) && job.attempts < job.maxAttempts) {
    const wait = backoffMs(job.attempts);
    return { to: 'QUEUED', notBeforeMs: now + wait, error: { code: e.code, message: e.message, retry: Math.ceil(wait / 1000), attempt: job.attempts } };
  }
  const message = TRANSIENT_CODES.has(e.code) && job.attempts >= job.maxAttempts ? `${e.message} (gave up after ${job.attempts} attempts)` : e.message;
  return { to: 'FAILED', error: { code: e.code, message, attempt: job.attempts } };
}

/**
 * A RUNNING job whose lease expired (the worker was killed, hung or lost its database connection). Re-queued for
 * another worker while attempts remain, otherwise FAILED with WORKER_LOST; a pending cancel request turns it CANCELLED.
 */
export function decideLeaseExpiry(job: { attempts: number; maxAttempts: number; cancelRequested: boolean }): FailureDecision {
  if (job.cancelRequested) return { to: 'CANCELLED' };
  if (job.attempts < job.maxAttempts) return { to: 'QUEUED', notBeforeMs: 0, error: { code: 'WORKER_LOST', message: 'Worker lease expired; re-queued for another worker', attempt: job.attempts } };
  return { to: 'FAILED', error: { code: 'WORKER_LOST', message: `Worker lease expired ${job.attempts} times; giving up`, attempt: job.attempts } };
}

/** Progress bands per phase (0..100), so the UI bar never runs backwards within an attempt. */
export const PROGRESS = {
  claimed: 1,
  matrixStart: 5,
  matrixEnd: 40,
  solveStart: 45,
  solveEnd: 90,
  writing: 95,
  done: 100,
} as const;

/** Map a fraction of a phase onto its band. */
export function phaseProgress(from: number, to: number, fraction: number): number {
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  return Math.round(from + (to - from) * f);
}
