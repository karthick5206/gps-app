import { HealthIssue } from '@veetracer/shared';
import { Issue } from './checks';
import { SystemMonitorService } from './system-monitor.service';
import { mergeOutageState } from './transitions';

/** Cache stand-in with the hashes the monitor uses; `down` makes every call fail like an unreachable server. */
function fakeCache() {
  const state = { down: false, hashes: new Map<string, Map<string, string>>() };
  const hash = (k: string) => {
    if (!state.hashes.has(k)) state.hashes.set(k, new Map());
    return state.hashes.get(k)!;
  };
  const guard = async <T>(v: () => T): Promise<T> => {
    if (state.down) throw new Error('connect ECONNREFUSED');
    return v();
  };
  const client = {
    set: () => guard(() => 'OK'),
    get: () => guard(() => null),
    hgetall: (k: string) => guard(() => Object.fromEntries(hash(k))),
    hvals: (k: string) => guard(() => [...hash(k).values()]),
    publish: () => guard(() => 1),
    multi() {
      const ops: (() => void)[] = [];
      const m = {
        del: (k: string) => (ops.push(() => state.hashes.delete(k)), m),
        hset: (k: string, obj: Record<string, string>) => (ops.push(() => Object.entries(obj).forEach(([f, v]) => hash(k).set(f, v))), m),
        lpush: () => m,
        ltrim: () => m,
        exec: () => guard(() => (ops.forEach((op) => op()), [])),
      };
      return m;
    },
  };
  return { state, client };
}

const valkeyDown: Issue = { id: 'valkey.unreachable', check: 'valkey', section: 'valkey', severity: 'CRITICAL', message: 'Valkey is not reachable' };

function setup() {
  const cache = fakeCache();
  let current: Issue[] = [];
  const sent: string[] = [];
  const health = {
    config: { cooldownMin: 15, alertEmails: ['ops@example.com'] },
    collect: async () => ({ issues: current, input: {}, throughput: [] }),
    storedIssues: async () => (await cache.client.hvals('vt:health:issues')).map((v) => JSON.parse(v) as HealthIssue),
    events: async () => [],
  };
  const prisma = { user: { findFirst: async () => null } };
  const mailer = { send: async (m: { subject: string }) => void sent.push(m.subject) };
  const monitor = new SystemMonitorService(health as never, { client: cache.client } as never, prisma as never, mailer as never, { webUrl: 'http://x' } as never);
  return { monitor, cache, sent, setIssues: (i: Issue[]) => (current = i) };
}

describe('SystemMonitorService across a cache outage', () => {
  it('sends "Resolved" for the cache outage once the cache is back (state was only in memory)', async () => {
    const { monitor, cache, sent, setIssues } = setup();
    const t = Date.parse('2026-11-09T10:00:00Z');
    await monitor.evaluateOnce(t);
    expect(sent).toEqual([]);

    cache.state.down = true;
    setIssues([valkeyDown]);
    await monitor.evaluateOnce(t + 15_000);
    expect(sent).toEqual(['[VeeTrax] CRITICAL: Valkey is not reachable']);

    // Back, and EMPTY (restart without persistence): nothing of the outage is stored in the cache.
    cache.state.down = false;
    cache.state.hashes.clear();
    setIssues([]);
    await monitor.evaluateOnce(t + 30_000);
    expect(sent).toEqual(['[VeeTrax] CRITICAL: Valkey is not reachable', '[VeeTrax] Resolved: valkey']);

    // Exactly once.
    await monitor.evaluateOnce(t + 45_000);
    expect(sent).toHaveLength(2);
  });

  it('an issue raised during the outage that is still active is not reported again, and resolves later', async () => {
    const { monitor, cache, sent, setIssues } = setup();
    const t = Date.parse('2026-11-09T10:00:00Z');
    const spool: Issue = { id: 'tracking.spool.gw.pending', check: 'gateway spool', section: 'pipeline', severity: 'WARN', message: 'buffered' };
    cache.state.down = true;
    setIssues([valkeyDown, spool]);
    await monitor.evaluateOnce(t);
    expect(sent).toHaveLength(1);
    cache.state.down = false;
    setIssues([spool]);
    await monitor.evaluateOnce(t + 15_000);
    expect(sent).toEqual(['[VeeTrax] 2 system issue(s) (1 critical)', '[VeeTrax] Resolved: valkey']);
    setIssues([]);
    await monitor.evaluateOnce(t + 30_000);
    expect(sent[2]).toBe('[VeeTrax] Resolved: gateway spool');
  });
});

describe('mergeOutageState', () => {
  const issue = (id: string, severity: 'WARN' | 'CRITICAL'): HealthIssue => ({ id, check: id, section: 'pipeline', severity, message: id, since: '2026-11-09T10:00:00Z' });
  it('adds issues only known locally, prefers stored issues, keeps the latest alert record', () => {
    const r = mergeOutageState(
      [issue('a', 'WARN')],
      new Map([['a', { alertAt: 5, notified: true }]]),
      [issue('a', 'CRITICAL'), issue('valkey.unreachable', 'CRITICAL')],
      new Map([
        ['a', { alertAt: 3, notified: true }],
        ['valkey.unreachable', { alertAt: 9, notified: true }],
      ]),
    );
    expect(r.previous.map((i) => `${i.id}:${i.severity}`)).toEqual(['a:WARN', 'valkey.unreachable:CRITICAL']);
    expect(r.records.get('a')).toEqual({ alertAt: 5, notified: true });
    expect(r.records.get('valkey.unreachable')).toEqual({ alertAt: 9, notified: true });
  });
});
