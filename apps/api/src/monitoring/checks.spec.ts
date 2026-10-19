import { DatabaseDto, HostDto, PortDto, ProcessInstanceDto, ProcessRole, QueueDto, ValkeyDto } from '@veetracer/shared';
import { bufferSecondsLeft, CheckInput, evaluateChecks, statusOf } from './checks';
import { loadMonitorConfig, loadThresholds } from './thresholds';
import { diffIssues } from './transitions';
import { pairs, parseInfo, shortError, streamIdTime } from './util';

const NOW = Date.parse('2026-10-19T10:00:00Z');
const t = loadThresholds({});
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function instance(role: ProcessRole, over: Partial<ProcessInstanceDto> = {}, metrics: object = {}): ProcessInstanceDto {
  return {
    role,
    instanceId: `host-${role}`,
    host: 'host',
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
    ...over,
  };
}

const gatewayMetrics = (connections: number, lastPositionAt: string | null) => ({
  listeners: [{ protocol: 'gt06', port: 5023, listening: true, error: null, connections, lastPositionAt }],
});

const port = (over: Partial<PortDto> = {}): PortDto => ({
  protocol: 'gt06',
  port: 5023,
  status: 'OK',
  listening: true,
  instances: 1,
  error: null,
  connections: 20,
  positionsPerSec: 4,
  framesPerSec: 4,
  dropped: 0,
  errors: 0,
  enqueueFailures: 0,
  lastPacketAt: iso(1000),
  ...over,
});

const queue = (over: Partial<QueueDto> = {}): QueueDto => ({
  key: 'vt:positions',
  group: 'processor',
  status: 'OK',
  length: 800_000,
  maxLength: 2_000_000,
  entriesAdded: 800_000,
  lag: 0,
  pending: 0,
  backlog: 0,
  oldestPendingAgeSec: null,
  consumers: [],
  inputPerSec: 4,
  bufferSecondsLeft: null,
  ...over,
});

const database: DatabaseDto = { status: 'OK', reachable: true, error: null, latencyMs: 3, activeConnections: 1, totalConnections: 10, maxConnections: 100, sizeBytes: 1e9, topTables: [], insertsPerMin: 240 };
const valkey: ValkeyDto = { status: 'OK', reachable: true, error: null, version: '9.1.2', latencyMs: 0.3, usedMemory: 1e8, maxMemory: 0, memoryPercent: null, aofEnabled: true, rdbLastSaveStatus: 'ok', rdbLastSaveAt: iso(60_000), connectedClients: 12, evictedKeys: 0 };
const host: HostDto = { status: 'OK', hostname: 'h', platform: 'linux', dataDir: '/var', diskTotal: 100, diskFree: 50, diskFreePercent: 50, loadAvg: [1, 1, 1], cpus: 8, memTotal: 16e9, memFree: 8e9, uptimeSec: 1000 };

function healthy(): CheckInput {
  return {
    now: NOW,
    expectedRoles: ['api', 'gateway', 'processor', 'notifier', 'summarizer'],
    processes: (['api', 'gateway', 'processor', 'notifier', 'summarizer'] as ProcessRole[]).map((role) => ({
      role,
      status: 'OK',
      instances: [instance(role, {}, role === 'gateway' ? gatewayMetrics(20, iso(3000)) : {})],
    })),
    ports: [port()],
    queues: [queue(), queue({ key: 'vt:notify', group: 'notifier', maxLength: 100_000 })],
    database: { ...database },
    valkey: { ...valkey },
    host: { ...host },
    notifications: { sent: 10, failed: 0 },
    startupGrace: false,
  };
}

const ids = (input: CheckInput) => evaluateChecks(input, t).map((i) => `${i.id}:${i.severity}`);

describe('evaluateChecks', () => {
  it('healthy system → no issues', () => {
    expect(ids(healthy())).toEqual([]);
  });

  it('data forwarding target failing for more than 5 minutes → WARN', () => {
    const relay = (failingMsAgo: number | null) => ({
      id: 't1', name: 'State backend', type: 'RAW_TCP', connected: 0, sessions: 3, bytes: 0, frames: 0, queued: 900, dropped: 4,
      lastSuccessAt: null, lastError: { message: 'ECONNREFUSED', at: iso(1000) }, failingSince: failingMsAgo === null ? null : iso(failingMsAgo), recentErrors: [],
    });
    const input = healthy();
    input.processes = input.processes.map((p) => (p.role === 'gateway' ? { ...p, instances: [instance('gateway', {}, { ...gatewayMetrics(20, iso(3000)), relay: [relay(6 * 60_000)] })] } : p));
    const issues = evaluateChecks(input, t);
    expect(issues.map((i) => `${i.id}:${i.severity}`)).toEqual(['relay.t1:WARN']);
    expect(issues[0].message).toMatch(/State backend.*ECONNREFUSED/);
    input.processes = input.processes.map((p) => (p.role === 'gateway' ? { ...p, instances: [instance('gateway', {}, { ...gatewayMetrics(20, iso(3000)), relay: [relay(60_000)] })] } : p));
    expect(ids(input)).toEqual([]);
  });

  it('a role without instances is CRITICAL (not during the startup grace)', () => {
    const input = healthy();
    input.processes.find((p) => p.role === 'processor')!.instances = [];
    expect(ids(input)).toEqual(['process.processor:CRITICAL']);
    expect(ids({ ...input, startupGrace: true })).toEqual([]);
  });

  it('stale heartbeat CRITICAL and event-loop lag WARN per instance', () => {
    const input = healthy();
    input.processes[0].instances = [instance('api', { ageSec: 18, eventLoopLagMs: 350 })];
    expect(ids(input)).toEqual(['process.api.host-api.stale:CRITICAL', 'process.api.host-api.eventloop:WARN']);
  });

  it('processor database errors: CRITICAL while failing, clear after a successful batch or outside the window', () => {
    const input = healthy();
    const failing = { dbErrors: 4, lastDbError: { message: "Can't reach database server", at: iso(5000) }, lastDbOkAt: iso(60_000), backoffMs: 8000 };
    input.processes[2].instances = [instance('processor', {}, failing)];
    expect(ids(input)).toEqual(['process.processor.host-processor.database:CRITICAL']);
    input.processes[2].instances = [instance('processor', {}, { ...failing, lastDbOkAt: iso(1000) })];
    expect(ids(input)).toEqual([]);
    input.processes[2].instances = [instance('processor', {}, { ...failing, lastDbError: { message: 'x', at: iso(10 * 60_000) }, lastDbOkAt: null })];
    expect(ids(input)).toEqual([]);
  });

  it('port not listening → CRITICAL', () => {
    const input = healthy();
    input.ports.push(port({ protocol: 'teltonika', port: 5027, listening: false, instances: 0, error: 'EADDRINUSE', connections: 0 }));
    const issues = evaluateChecks(input, t);
    expect(issues.map((i) => i.id)).toEqual(['port.teltonika.5027']);
    expect(issues[0].message).toContain('EADDRINUSE');
  });

  it('no positions for 5 min while devices are connected → WARN', () => {
    const input = healthy();
    input.processes[1].instances = [instance('gateway', {}, gatewayMetrics(20, iso(6 * 60_000)))];
    expect(ids(input)).toEqual(['pipeline.no-positions:WARN']);
    input.ports = [port({ connections: 0 })];
    expect(ids(input)).toEqual([]);
  });

  it('queue lag thresholds, oldest pending, buffer time left', () => {
    const input = healthy();
    input.queues[0] = queue({ lag: 6000 });
    expect(ids(input)).toEqual(['queue.vt:positions.lag:WARN']);
    input.queues[0] = queue({ lag: 60_000, oldestPendingAgeSec: 90, pending: 500, bufferSecondsLeft: 5 * 60 });
    expect(ids(input)).toEqual(['queue.vt:positions.buffer:CRITICAL', 'queue.vt:positions.lag:CRITICAL', 'queue.vt:positions.pending-age:WARN']);
    input.queues[0] = queue({ bufferSecondsLeft: 20 * 60 });
    expect(ids(input)).toEqual(['queue.vt:positions.buffer:WARN']);
  });

  it('database, Valkey and disk checks', () => {
    const input = healthy();
    input.database = { ...database, latencyMs: 450 };
    input.valkey = { ...valkey, maxMemory: 1000, usedMemory: 850, memoryPercent: 85, aofEnabled: false };
    input.host = { ...host, diskFreePercent: 4 };
    expect(ids(input)).toEqual(['host.disk:CRITICAL', 'database.latency:WARN', 'valkey.aof:WARN', 'valkey.memory:WARN']);
    input.database = { ...database, reachable: false, latencyMs: null, error: 'SELECT 1 timed out after 2000 ms' };
    input.valkey = { ...valkey, reachable: false, error: 'connect ECONNREFUSED' };
    input.host = { ...host };
    expect(ids(input)).toEqual(['database.unreachable:CRITICAL', 'valkey.unreachable:CRITICAL']);
    input.valkey = { ...valkey, memoryPercent: 95 };
    expect(ids(input)).toContain('valkey.memory:CRITICAL');
  });

  it('notification failure ratio over the window (needs a minimum number of sends)', () => {
    const input = healthy();
    input.notifications = { sent: 6, failed: 4 };
    expect(ids(input)).toEqual(['pipeline.notifier-failures:WARN']);
    input.notifications = { sent: 1, failed: 2 };
    expect(ids(input)).toEqual([]);
  });

  it('statusOf covers ids under a prefix', () => {
    const issues = evaluateChecks({ ...healthy(), processes: [{ role: 'api', status: 'OK', instances: [instance('api', { eventLoopLagMs: 300 })] }], expectedRoles: ['api'] }, t);
    expect(statusOf(issues, 'process.api')).toBe('WARN');
    expect(statusOf(issues, 'process.api.host-api')).toBe('WARN');
    expect(statusOf(issues, 'process.gateway')).toBe('OK');
  });
});

describe('bufferSecondsLeft', () => {
  it('uses the net fill rate; null when the stream is not filling', () => {
    expect(bufferSecondsLeft(2_000_000, 0, 1000, 0)).toBe(2000);
    expect(bufferSecondsLeft(2_000_000, 1_000_000, 1000, 500)).toBe(2000);
    expect(bufferSecondsLeft(2_000_000, 0, 1000, 1000)).toBeNull();
    expect(bufferSecondsLeft(2_000_000, 0, null, null)).toBeNull();
  });
});

describe('diffIssues', () => {
  const issue = (id: string, severity: 'WARN' | 'CRITICAL') => ({ id, check: id, section: 'queues' as const, severity, message: `${id} ${severity}` });
  const COOLDOWN = 15 * 60_000;

  it('new issue → event + alert; unchanged keeps since and does not alert again', () => {
    const first = diffIssues([], [issue('a', 'WARN')], new Map(), NOW, COOLDOWN);
    expect(first.events).toMatchObject([{ id: 'a', from: 'OK', to: 'WARN' }]);
    expect(first.alert.map((i) => i.id)).toEqual(['a']);
    const second = diffIssues(first.active, [issue('a', 'WARN')], first.records, NOW + 15_000, COOLDOWN);
    expect(second.events).toEqual([]);
    expect(second.alert).toEqual([]);
    expect(second.active[0].since).toBe(first.active[0].since);
  });

  it('escalation alerts even within the cooldown; recovery only when the alert was sent', () => {
    const a = diffIssues([], [issue('a', 'WARN')], new Map(), NOW, COOLDOWN);
    const b = diffIssues(a.active, [issue('a', 'CRITICAL')], a.records, NOW + 15_000, COOLDOWN);
    expect(b.alert.map((i) => i.severity)).toEqual(['CRITICAL']);
    const records = new Map([...a.records, ...b.records]);
    const c = diffIssues(b.active, [], records, NOW + 30_000, COOLDOWN);
    expect(c.events).toMatchObject([{ id: 'a', from: 'CRITICAL', to: 'OK' }]);
    expect(c.recovered.map((i) => i.id)).toEqual(['a']);
    expect(c.records.get('a')).toMatchObject({ notified: false });
  });

  it('flapping within the cooldown: no second alert and no recovery mail for the suppressed one', () => {
    const records = new Map([['a', { alertAt: NOW - 60_000, notified: false }]]);
    const raised = diffIssues([], [issue('a', 'WARN')], records, NOW, COOLDOWN);
    expect(raised.alert).toEqual([]);
    expect(raised.events).toHaveLength(1);
    const cleared = diffIssues(raised.active, [], records, NOW + 15_000, COOLDOWN);
    expect(cleared.recovered).toEqual([]);
    const later = diffIssues([], [issue('a', 'WARN')], records, NOW + COOLDOWN, COOLDOWN);
    expect(later.alert).toHaveLength(1);
  });
});

describe('thresholds and helpers', () => {
  it('env overrides thresholds; invalid values fall back to defaults', () => {
    const custom = loadThresholds({ HEALTH_QUEUE_LAG_WARN: '100', HEALTH_DISK_WARN_PCT: 'abc' });
    expect(custom.queueLagWarn).toBe(100);
    expect(custom.diskWarnPct).toBe(15);
    expect(t.queueLagCrit).toBe(50_000);
  });

  it('monitor config: roles, recipients, cooldown', () => {
    const c = loadMonitorConfig({ SYSTEM_ALERT_EMAILS: 'ops@example.com, bad, noc@example.com', SYSTEM_HEALTH_ROLES: 'api,gateway,bogus', SYSTEM_ALERT_COOLDOWN_MIN: '5' });
    expect(c.alertEmails).toEqual(['ops@example.com', 'noc@example.com']);
    expect(c.expectedRoles).toEqual(['api', 'gateway']);
    expect(c.cooldownMin).toBe(5);
    expect(loadMonitorConfig({}).expectedRoles).toHaveLength(5);
  });

  it('parses XINFO pairs, INFO text, stream ids and Prisma-style errors', () => {
    expect(pairs(['length', 3, 'lag', null])).toEqual({ length: 3, lag: null });
    expect(parseInfo('# Memory\r\nused_memory:100\r\nmaxmemory:0\r\n')).toEqual({ used_memory: '100', maxmemory: '0' });
    expect(streamIdTime('1792379623201-0')).toBe(1792379623201);
    expect(shortError(new Error('\nInvalid `prisma.$queryRaw()` invocation:\n\n\nCan\'t reach database server at `localhost:1`'))).toBe("Can't reach database server at `localhost:1`");
  });
});
