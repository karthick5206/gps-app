import type { ProcessHeartbeat } from '@veetracer/shared';
import { DISABLED_ROUTING_HEALTH, RoutingHealthMonitor } from './routing-health';

const NOW = Date.parse('2026-11-11T10:00:00Z');
const hb = (role: string, agoMs: number) => ({ role, at: new Date(NOW - agoMs).toISOString() }) as unknown as ProcessHeartbeat;
const stats = { stats: jest.fn(async () => ({ queued: 2, running: 1, failed24h: 3, oldestQueuedAt: new Date(NOW - 90_000) })) };
const optimizer = (ok: boolean) => ({ configured: true, config: { baseUrl: 'http://u:p@127.0.0.1:8090', token: 't'.repeat(24), problem: null }, health: jest.fn(async () => ok) });

describe('RoutingHealthMonitor (System Health "Route planning")', () => {
  it('off → DISABLED, nothing probed or counted', async () => {
    const o = optimizer(true);
    const m = new RoutingHealthMonitor(stats, o, () => false);
    expect(await m.collect([hb('routing-worker', 0)], NOW, 15)).toBe(DISABLED_ROUTING_HEALTH);
    expect(o.health).not.toHaveBeenCalled();
  });

  it('on → live workers, optimiser probe (cached 10 s, URL without credentials), job counts', async () => {
    const o = optimizer(false);
    const m = new RoutingHealthMonitor(stats, o, () => true);
    const r = await m.collect([hb('routing-worker', 2_000), hb('routing-worker', 60_000), hb('notifier', 0)], NOW, 15);
    expect(r).toMatchObject({
      enabled: true,
      workers: 1,
      optimizer: { configured: true, ok: false, probeUrl: 'http://127.0.0.1:8090/health' },
      jobs: { queued: 2, running: 1, failed24h: 3, oldestQueuedAgeSec: 90 },
    });
    await m.collect([], NOW + 5_000, 15);
    expect(o.health).toHaveBeenCalledTimes(1);
    await m.collect([], NOW + 11_000, 15);
    expect(o.health).toHaveBeenCalledTimes(2);
  });

  it('database down → jobs null (the database checks report it)', async () => {
    const m = new RoutingHealthMonitor({ stats: async () => Promise.reject(new Error('down')) }, optimizer(true), () => true);
    expect((await m.collect([], NOW, 15)).jobs).toBeNull();
  });
});
