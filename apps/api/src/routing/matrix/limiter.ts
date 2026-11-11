/**
 * Back-pressure for the shared production host (doc 17 R-5, doc 06 §7 "matrix fan-out ≤ 4 in flight, paused when GH
 * p95 exceeds a threshold, to protect tracker ETAs, History and map matching").
 *
 * `AdaptiveLimiter` caps engine requests in flight for every matrix build of the process. After each window of
 * requests it looks at the p95 per-leg latency: above `slowLegMs` the limit halves (down to 1), below `fastLegMs` it
 * grows by one (up to the configured maximum). Other GraphHopper users (tracker ETAs, map matching) slow GraphHopper
 * down too, so this yields to them without knowing about them.
 *
 * `BuildGate` caps whole matrix builds at once, with a bounded queue (refusal beyond it: LIMIT_EXCEEDED).
 */

export class AdaptiveLimiter {
  private active = 0;
  private limitNow: number;
  private readonly waiting: (() => void)[] = [];
  private window: number[] = [];

  constructor(
    readonly max: number,
    private readonly slowLegMs: number,
    private readonly fastLegMs: number,
    private readonly windowSize = 20,
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
    const started = Date.now();
    try {
      return await fn();
    } finally {
      this.observe((Date.now() - started) / Math.max(1, legs));
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

  /** Feeds one per-leg latency sample (ms) into the current window; adjusts the limit when the window is full. */
  observe(perLegMs: number): void {
    this.window.push(perLegMs);
    if (this.window.length < this.windowSize) return;
    const p95 = percentile(this.window, 95);
    this.window = [];
    if (p95 > this.slowLegMs) this.limitNow = Math.max(1, Math.floor(this.limitNow / 2));
    else if (p95 < this.fastLegMs) this.limitNow = Math.min(this.max, this.limitNow + 1);
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
