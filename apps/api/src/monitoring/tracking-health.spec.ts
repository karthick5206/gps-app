import { HostDto, PortDto, ProcessInstanceDto, ProcessRole, QueueDto, SpoolMetrics, ValkeyDto } from '@veetracer/shared';
import { gatewayHealth } from '../gateway/spool/gateway-health';
import { RecentIds } from '../processor/recent-ids';
import { toEntries } from '../processor/stream-consumer';
import { CheckInput, evaluateChecks } from './checks';
import { trackingIssues, trackingReport } from './health-probe.service';
import { loadThresholds } from './thresholds';

const NOW = Date.parse('2026-11-09T10:00:00Z');
const t = loadThresholds({});
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const spool = (over: Partial<SpoolMetrics> = {}): SpoolMetrics => ({
  enabled: true,
  mode: 'direct',
  cacheReady: true,
  backpressure: false,
  pendingEntries: 0,
  pendingBytes: 0,
  oldestSpooledAt: null,
  spooled: 0,
  replayed: 0,
  rejected: 0,
  directFailed: 0,
  notAcked: 0,
  lastError: null,
  lastErrorAt: null,
  ...over,
});

function instance(role: ProcessRole, metrics: object): ProcessInstanceDto {
  return {
    role,
    instanceId: `myhost-${role === 'gateway' ? 101 : 202}`,
    host: 'myhost',
    pid: 1,
    version: '0.1.0',
    startedAt: iso(3_600_000),
    at: iso(2000),
    uptimeSec: 3600,
    rssBytes: 1e8,
    heapUsed: 5e7,
    cpuPercent: 3,
    eventLoopLagMs: 12,
    status: 'OK',
    ageSec: 2,
    stale: false,
    metrics: metrics as never,
  };
}

const port: PortDto = { protocol: 'gt06', port: 5023, status: 'OK', listening: true, instances: 1, error: null, connections: 20, positionsPerSec: 4, framesPerSec: 4, dropped: 0, errors: 0, enqueueFailures: 0, lastPacketAt: iso(1000) };
const queue: QueueDto = { key: 'vt:positions', group: 'processor', status: 'OK', length: 1000, maxLength: 2_000_000, entriesAdded: 1000, lag: 0, pending: 0, backlog: 0, oldestPendingAgeSec: null, consumers: [], inputPerSec: 4, bufferSecondsLeft: null };
const valkey: ValkeyDto = { status: 'OK', reachable: true, error: null, version: '9.0.4', latencyMs: 0.3, usedMemory: 1e8, maxMemory: 0, memoryPercent: null, aofEnabled: true, rdbLastSaveStatus: 'ok', rdbLastSaveAt: iso(60_000), connectedClients: 12, evictedKeys: 0 };
const host: HostDto = { status: 'OK', hostname: 'h', platform: 'win32', dataDir: 'C:', diskTotal: 100, diskFree: 50, diskFreePercent: 50, loadAvg: [0, 0, 0], cpus: 4, memTotal: 4e9, memFree: 2e9, uptimeSec: 1000 };

function input(gatewaySpool: SpoolMetrics | undefined = spool(), over: Partial<CheckInput> = {}): CheckInput {
  const gw = { listeners: [{ protocol: 'gt06', port: 5023, listening: true, error: null, connections: 20, positionsPerSec: 4, lastPositionAt: iso(2000) }], ...(gatewaySpool ? { spool: gatewaySpool } : {}) };
  return {
    now: NOW,
    expectedRoles: ['api', 'gateway', 'processor'],
    processes: [
      { role: 'api', status: 'OK', instances: [instance('api', {})] },
      { role: 'gateway', status: 'OK', instances: [instance('gateway', gw)] },
      { role: 'processor', status: 'OK', instances: [instance('processor', { lastBatchAt: iso(1000), processedPerSec: 4, duplicates: 0 })] },
    ],
    ports: [port],
    queues: [queue],
    database: { status: 'OK', reachable: true, error: null, latencyMs: 2, activeConnections: 1, totalConnections: 5, maxConnections: 100, sizeBytes: 1, topTables: [], insertsPerMin: 1 },
    valkey,
    host,
    notifications: null,
    startupGrace: false,
    lastPersistedAt: NOW - 5000,
    ...over,
  };
}

const ids = (i: CheckInput) => evaluateChecks(i, t).map((x) => `${x.id}:${x.severity}`);

describe('tracking checks', () => {
  it('healthy pipeline → no issues; old gateways without spool metrics are fine', () => {
    expect(ids(input())).toEqual([]);
    expect(ids(input(undefined))).toEqual([]);
  });

  it('cache down: one CRITICAL for the cache instead of every process / port looking dead', () => {
    const i = input(spool(), { valkey: { ...valkey, reachable: false, error: 'ECONNREFUSED' }, processes: [], ports: [{ ...port, listening: false, connections: 0 }] });
    expect(ids(i)).toEqual(['valkey.unreachable:CRITICAL']);
  });

  it('positions buffered on a gateway disk → WARN; not draining with the cache up for too long → CRITICAL', () => {
    expect(ids(input(spool({ mode: 'spooling', cacheReady: false, pendingEntries: 1200, oldestSpooledAt: iso(60 * 60_000) })))).toEqual(['tracking.spool.myhost-101.pending:WARN']);
    expect(ids(input(spool({ mode: 'draining', pendingEntries: 1200, oldestSpooledAt: iso(5 * 60_000) })))).toEqual(['tracking.spool.myhost-101.pending:WARN']);
    expect(ids(input(spool({ mode: 'draining', pendingEntries: 1200, oldestSpooledAt: iso(20 * 60_000) })))).toEqual(['tracking.spool.myhost-101.pending:CRITICAL']);
  });

  it('positions refused by a gateway (spool full and cache down) → CRITICAL while recent', () => {
    expect(ids(input(spool({ notAcked: 40, lastErrorAt: iso(10_000), lastError: 'spool full' })))).toEqual(['tracking.spool.myhost-101.refused:CRITICAL']);
    expect(ids(input(spool({ notAcked: 40, lastErrorAt: iso(10 * 60_000) })))).toEqual([]);
  });

  it('nothing persisted to PostgreSQL while devices are connected → WARN, then CRITICAL', () => {
    expect(ids(input(spool(), { lastPersistedAt: NOW - 200_000 }))).toEqual(['tracking.persist-stale:WARN']);
    expect(ids(input(spool(), { lastPersistedAt: NOW - 700_000 }))).toEqual(['tracking.persist-stale:CRITICAL']);
    expect(ids(input(spool(), { lastPersistedAt: null }))).toEqual(['tracking.persist-stale:CRITICAL']);
    // No devices connected, start-up grace, or not collected: no verdict.
    expect(ids(input(spool(), { lastPersistedAt: NOW - 700_000, ports: [{ ...port, connections: 0 }] }))).toEqual([]);
    expect(ids(input(spool(), { lastPersistedAt: NOW - 700_000, startupGrace: true }))).toEqual([]);
    expect(ids(input(spool(), { lastPersistedAt: undefined }))).toEqual([]);
  });
});

describe('trackingReport (public /api/health/tracking body)', () => {
  it('keeps only pipeline issues, scrubs the host name and summarises the stages', () => {
    const i = input(spool({ mode: 'spooling', cacheReady: false, pendingEntries: 7, oldestSpooledAt: iso(1000) }), { host: { ...host, diskFreePercent: 1 } });
    const issues = evaluateChecks(i, t);
    expect(issues.map((x) => x.id)).toContain('host.disk');
    const r = trackingReport({ input: i, issues, throughput: [] }, 'myhost');
    expect(r.status).toBe('WARN');
    expect(r.ok).toBe(false);
    expect(r.issues.map((x) => x.id)).toEqual(['tracking.spool.101.pending']);
    expect(JSON.stringify(r)).not.toContain('myhost');
    expect(r.gateways).toEqual([{ instance: 1, connections: 20, positionsPerSec: 4, spool: { mode: 'spooling', pendingEntries: 7, oldestSpooledAt: iso(1000), notAcked: 0 } }]);
    expect(r.processors[0]).toMatchObject({ lastBatchAt: iso(1000) });
    expect(r.lastPersistedAgeSec).toBe(5);
  });

  it('cache down → CRITICAL', () => {
    const i = input(spool(), { valkey: { ...valkey, reachable: false } });
    const r = trackingReport({ input: i, issues: evaluateChecks(i, t), throughput: [] }, 'myhost');
    expect(r.status).toBe('CRITICAL');
    expect(r.cache.reachable).toBe(false);
  });

  it('notifier / relay issues are not tracking issues', () => {
    expect(trackingIssues([{ id: 'pipeline.notifier-failures', check: '', section: 'pipeline', severity: 'WARN', message: '' }])).toEqual([]);
    expect(trackingIssues([{ id: 'valkey.unreachable', check: '', section: 'valkey', severity: 'CRITICAL', message: '' }])).toHaveLength(1);
  });
});

describe('gateway local health', () => {
  const listeners = [{ protocol: 'gt06', port: 5023, listening: true, connections: 3 }];
  it('ok / degraded (spooling, positions safe) / failing (refusing, listener down, no spool)', () => {
    expect(gatewayHealth({ listeners, spool: spool(), lastNotAckedAt: null, now: NOW }).status).toBe('ok');
    const degraded = gatewayHealth({ listeners, spool: spool({ cacheReady: false, mode: 'spooling', pendingEntries: 3 }), lastNotAckedAt: null, now: NOW });
    expect(degraded.status).toBe('degraded');
    expect(degraded.reasons.join(' ')).toMatch(/spooled to disk/);
    expect(gatewayHealth({ listeners, spool: spool({ cacheReady: false }), lastNotAckedAt: NOW - 1000, now: NOW }).status).toBe('failing');
    expect(gatewayHealth({ listeners: [{ ...listeners[0], listening: false }], spool: spool(), lastNotAckedAt: null, now: NOW }).status).toBe('failing');
    expect(gatewayHealth({ listeners, spool: spool({ enabled: false, mode: 'disabled', cacheReady: false }), lastNotAckedAt: null, now: NOW }).status).toBe('failing');
  });
});

describe('processor duplicate handling', () => {
  it('reads the gateway mid from stream entries (absent on old entries)', () => {
    expect(toEntries([['1-0', ['data', '{}', 'remote', 'r', 'mid', 'abc-1']], ['2-0', ['data', '{}', 'remote', 'r']]])).toEqual([
      { id: '1-0', data: '{}', remote: 'r', mid: 'abc-1' },
      { id: '2-0', data: '{}', remote: 'r', mid: undefined },
    ].map((e) => (e.mid === undefined ? { id: e.id, data: e.data, remote: e.remote } : e)));
  });

  it('RecentIds is bounded and evicts the oldest', () => {
    const r = new RecentIds(2);
    r.add('a');
    r.add('b');
    r.add('c');
    expect([r.has('a'), r.has('b'), r.has('c'), r.size]).toEqual([false, true, true, 2]);
  });
});
