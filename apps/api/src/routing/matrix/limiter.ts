/**
 * Back-pressure for the shared production host (doc 17 R-5, doc 06 §7 "matrix fan-out ≤ 4 in flight, paused when GH
 * p95 exceeds a threshold, to protect tracker ETAs, History and map matching").
 *
 * `AdaptiveLimiter` caps engine requests in flight for every matrix build of the process (and, with a GlobalSlots
 * semaphore, across processes: T3-D4). After each window of requests it judges two things (T3-D5):
 * - the per-leg latency p95 against the engine's own normal per-leg cost (`legBase`: the lowest window median seen,
 *   allowed to drift up only 2 % per window): slow above max(slowLegMs, min(3 × base, 4 × slowLegMs));
 * - the queueing of each request, latency − legs × base (a 50-leg walk queued 400 ms used to look like 8 ms per leg):
 *   slow above 4 × slowLegMs.
 * Slow halves the limit (down to 1); fast (per-leg p95 below max(fastLegMs, 1.5 × base), little queueing) grows it by
 * one; a window that is neither counts as calm, and after PROBE_AFTER calm windows in a row the limit probes up by one
 * (a slow graph used to keep the limit at 1 forever). Other GraphHopper users (tracker ETAs, map matching) slow
 * GraphHopper down too, so this yields to them without knowing about them.
 *
 * `BuildGate` caps whole matrix builds at once, with a bounded queue (refusal beyond it: LIMIT_EXCEEDED).
 */

import type { GlobalSlots } from './global-slots';

/** Calm windows in a row (neither slow nor fast) before the limit probes up by one (T3-D5). */
export const PROBE_AFTER = 3;

export class AdaptiveLimiter {
  private active = 0;
  private limitNow: number;
  private readonly waiting: (() => void)[] = [];
  private window: { ms: number; legs: number }[] = [];
  /**
   * The engine's normal per-leg cost (ms): the lowest window median seen, drifting up at most 2 % per window. Two
   * references: `legRef` for the per-leg test starts no higher than slowLegMs / 2 (a first window that is already slow
   * still halves); `walkRef` for the queueing test starts at the first median (a slow graph is not taken for a queue).
   */
  private legRef: number | null = null;
  private walkRef: number | null = null;
  private calm = 0;

  constructor(
    readonly max: number,
    private readonly slowLegMs: number,
    private readonly fastLegMs: number,
    private readonly windowSize = 20,
    private readonly global: GlobalSlots | null = null,
  ) {
    this.limitNow = max;
  }

  get limit(): number {
    return this.limitNow;
  }

  get inFlight(): number {
    return this.active;
  }

  /** Runs `fn` in a slot; `legs` normalises its latency (a walk of 50 legs is one request). */
  async run<T>(legs: number, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    let shared: (() => void) | null = null;
    try {
      // T3-D4: then a slot of the cross-process cap (fails open to this process's cap when Valkey is down).
      if (this.global) shared = await this.global.acquire(signal);
    } catch (e) {
      this.release();
      throw e;
    }
    const started = Date.now();
    try {
      return await fn();
    } finally {
      this.observe(Date.now() - started, legs);
      shared?.();
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
    if (this.active < this.limitNow) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const go = () => {
        signal?.removeEventListener('abort', onAbort);
        this.active++;
        resolve();
      };
      const onAbort = () => {
        const i = this.waiting.indexOf(go);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(signal?.reason ?? new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(go);
    });
  }

  private release(): void {
    this.active--;
    while (this.active < this.limitNow && this.waiting.length) this.waiting.shift()!();
  }

  /** Feeds one request (latency ms, legs) into the current window; adjusts the limit when the window is full. */
  observe(latencyMs: number, legs = 1): void {
    this.window.push({ ms: latencyMs, legs: Math.max(1, legs) });
    if (this.window.length < this.windowSize) return;
    const w = this.window;
    this.window = [];
    const perLeg = w.map((x) => x.ms / x.legs);
    const median = percentile(perLeg, 50);
    this.legRef = this.legRef === null ? Math.min(median, this.slowLegMs / 2) : Math.min(this.legRef * 1.02, median);
    this.walkRef = this.walkRef === null ? median : Math.min(this.walkRef * 1.02, median);
    const base = this.legRef;
    const walkBase = this.walkRef;
    const legP95 = percentile(perLeg, 95);
    const queueP95 = percentile(w.map((x) => x.ms - x.legs * walkBase), 95);
    const queueSlow = 4 * this.slowLegMs;
    const slow = legP95 > Math.max(this.slowLegMs, Math.min(3 * base, 4 * this.slowLegMs)) || queueP95 > queueSlow;
    const fast = legP95 < Math.max(this.fastLegMs, 1.5 * base) && queueP95 < queueSlow / 2;
    if (slow) {
      this.limitNow = Math.max(1, Math.floor(this.limitNow / 2));
      this.calm = 0;
    } else if (fast) {
      this.limitNow = Math.min(this.max, this.limitNow + 1);
      this.calm = 0;
    } else if (++this.calm >= PROBE_AFTER) {
      this.limitNow = Math.min(this.max, this.limitNow + 1);
      this.calm = 0;
    }
    this.wake();
  }

  private wake(): void {
    // A grown limit lets waiting requests start now (each waiter counts itself in).
    while (this.active < this.limitNow && this.waiting.length) this.waiting.shift()!();
  }
}

export class BuildGate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    readonly max: number,
    readonly queue: number,
  ) {}

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  /**
   * T3-D3: like enter(), but the wait in the queue is bounded (waitMs) and ends when `signal` aborts: 'full' when the
   * queue is full, 'timeout' when no slot freed up in time, 'aborted' on cancel; else a release function.
   */
  async enterWithin(waitMs: number, signal?: AbortSignal): Promise<(() => void) | 'full' | 'timeout' | 'aborted'> {
    if (signal?.aborted) return 'aborted';
    if (this.active < this.max) return this.enter() as Promise<() => void>;
    if (this.waiting.length >= this.queue) return 'full';
    const got = await new Promise<'go' | 'timeout' | 'aborted'>((resolve) => {
      const go = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve('go');
      };
      const leave = (why: 'timeout' | 'aborted') => {
        const i = this.waiting.indexOf(go);
        if (i >= 0) this.waiting.splice(i, 1);
        signal?.removeEventListener('abort', onAbort);
        resolve(why);
      };
      const onAbort = () => {
        clearTimeout(timer);
        leave('aborted');
      };
      const timer = setTimeout(() => leave('timeout'), Math.max(0, waitMs));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(go);
    });
    if (got !== 'go') return got;
    // A slot handed over by release() (active unchanged): the same release function as enter() returns.
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }

  /** Null when the queue is full (caller answers LIMIT_EXCEEDED); else a release function. */
  async enter(): Promise<(() => void) | null> {
    if (this.active >= this.max) {
      if (this.waiting.length >= this.queue) return null;
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}

/** Nearest-rank percentile of a sample (0 for an empty one). */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
