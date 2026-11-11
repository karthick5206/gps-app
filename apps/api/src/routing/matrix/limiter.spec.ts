import { AdaptiveLimiter, BuildGate, percentile } from './limiter';

const tick = () => new Promise((r) => setImmediate(r));

describe('AdaptiveLimiter', () => {
  it('never runs more than the limit at once', async () => {
    const l = new AdaptiveLimiter(3, 1e9, 0);
    let active = 0;
    let peak = 0;
    const job = () =>
      l.run(1, async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    await Promise.all(Array.from({ length: 20 }, job));
    expect(peak).toBe(3);
    expect(l.inFlight).toBe(0);
  });

  it('halves the limit when the window p95 per leg is slow and grows it again when fast', () => {
    const l = new AdaptiveLimiter(8, 50, 10, 4);
    for (let i = 0; i < 4; i++) l.observe(100);
    expect(l.limit).toBe(4);
    for (let i = 0; i < 4; i++) l.observe(100);
    expect(l.limit).toBe(2);
    for (let i = 0; i < 8; i++) l.observe(100);
    expect(l.limit).toBe(1); // never below one
    for (let i = 0; i < 4; i++) l.observe(1);
    expect(l.limit).toBe(2);
    for (let i = 0; i < 4; i++) l.observe(30); // between fast and slow: unchanged
    expect(l.limit).toBe(2);
  });

  it('normalises latency by legs (a 50-leg walk is not "slow" for taking 50× longer)', async () => {
    const l = new AdaptiveLimiter(4, 50, 10, 1);
    await l.run(50, () => new Promise((r) => setTimeout(r, 60)));
    expect(l.limit).toBe(4);
  });

  it('a waiting caller can be aborted and frees nothing it never held', async () => {
    const l = new AdaptiveLimiter(1, 1e9, 0);
    let release!: () => void;
    const first = l.run(1, () => new Promise<void>((r) => (release = r)));
    await tick();
    const ac = new AbortController();
    const second = l.run(1, async () => 'ran', ac.signal);
    ac.abort(new Error('stop'));
    await expect(second).rejects.toThrow('stop');
    release();
    await first;
    expect(l.inFlight).toBe(0);
    await expect(l.run(1, async () => 'ok', AbortSignal.abort(new Error('already')))).rejects.toThrow('already');
  });
});

describe('BuildGate', () => {
  it('runs up to max builds, queues up to queue, refuses beyond', async () => {
    const g = new BuildGate(1, 1);
    const r1 = await g.enter();
    expect(r1).not.toBeNull();
    const p2 = g.enter();
    await tick();
    expect(g.queued).toBe(1);
    expect(await g.enter()).toBeNull();
    r1!();
    r1!(); // idempotent
    const r2 = await p2;
    expect(g.running).toBe(1);
    r2!();
    expect(g.running).toBe(0);
  });
});

describe('percentile', () => {
  it('nearest rank', () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([10, 1, 9, 2, 8, 3, 7, 4, 6, 5], 95)).toBe(10);
  });
});
