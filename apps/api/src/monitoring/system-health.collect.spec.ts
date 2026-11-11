import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { AppEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MapServiceMonitor, mapServiceTargets } from './map-services';
import { SystemHealthService } from './system-health.service';

/**
 * Integration-style test of the System Health collect path with stubbed map services (release-gate spec G6 test plan
 * "system-health.service collect with stubs"): collect → input.maps → checks → toDto().maps, and the
 * `.catch → snapshot` fallback. The data sources (Valkey, PostgreSQL, host) are stubbed healthy; Martin is a local
 * HTTP stub whose answer the test switches.
 */
function stub(status: { code: number }): Promise<Server> {
  const server = createServer((_req, res) => {
    res.writeHead(status.code, { 'content-type': 'text/plain' });
    res.end(status.code === 200 ? 'OK' : 'down');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function service(martinUrl: string): SystemHealthService {
  const svc = new SystemHealthService({} as PrismaService, {} as RedisService, { gt06Port: 0, teltonikaPort: 0, jt808Port: 0 } as unknown as AppEnv);
  const mutable = svc as unknown as { config: SystemHealthService['config']; mapServices: MapServiceMonitor };
  mutable.config = { ...svc.config, expectedRoles: [] };
  mutable.mapServices = new MapServiceMonitor(mapServiceTargets({ MARTIN_URL: martinUrl }), { minIntervalMs: 0, timeoutMs: 1000 });
  jest.spyOn(svc, 'valkeyInfo').mockResolvedValue({
    status: 'OK', reachable: true, error: null, version: '8.0.0', latencyMs: 1, usedMemory: 1, maxMemory: 0, memoryPercent: null,
    aofEnabled: true, rdbLastSaveStatus: 'ok', rdbLastSaveAt: null, connectedClients: 1, evictedKeys: 0,
  });
  jest.spyOn(svc, 'heartbeats').mockResolvedValue([]);
  jest.spyOn(svc, 'series').mockResolvedValue([]);
  jest.spyOn(svc, 'streamStats').mockResolvedValue({ exists: false, length: 0, entriesAdded: null, entriesRead: null, lag: null, pending: 0, consumers: [], oldestPendingId: null });
  jest.spyOn(svc, 'database').mockResolvedValue({
    status: 'OK', reachable: true, error: null, latencyMs: 1, activeConnections: 1, totalConnections: 1, maxConnections: 100, sizeBytes: 1, topTables: [], insertsPerMin: null,
  });
  jest.spyOn(svc, 'host').mockResolvedValue({
    status: 'OK', hostname: 'test', platform: 'linux', dataDir: '/', diskTotal: 100, diskFree: 90, diskFreePercent: 90, loadAvg: [0], cpus: 1, memTotal: 1, memFree: 1, uptimeSec: 1,
  });
  jest.spyOn(svc, 'lastPersistedAt').mockResolvedValue(null);
  return svc;
}

describe('SystemHealthService.collect with stubbed map services', () => {
  const status = { code: 200 };
  let server: Server;
  let svc: SystemHealthService;

  beforeAll(async () => {
    server = await stub(status);
    svc = service(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** One monitor round: collect + DTO, reduced to what the map card and the issue list show. */
  async function round(now: number) {
    const c = await svc.collect(now);
    const dto = svc.toDto(c, [], []);
    const martin = dto.maps.find((m) => m.name === 'martin')!;
    return { mapIssues: dto.issues.filter((i) => i.section === 'maps').map((i) => `${i.id}:${i.severity}`), martin, dto };
  }

  it('up → OK; down once → still OK; down twice → CRITICAL; up again → recovered', async () => {
    const t0 = Date.parse('2026-11-11T10:00:00Z');
    let r = await round(t0);
    expect(r.mapIssues).toEqual([]);
    expect(r.martin).toMatchObject({ configured: true, ok: true, status: 'OK', consecutiveFailures: 0, checkedAt: '2026-11-11T10:00:00.000Z' });
    expect(r.dto.maps.filter((m) => !m.configured).map((m) => m.name)).toEqual(['graphhopper', 'photon']);

    status.code = 503; // Martin down
    r = await round(t0 + 15_000);
    expect(r.mapIssues).toEqual([]);
    expect(r.martin).toMatchObject({ ok: false, status: 'OK', error: 'HTTP 503', consecutiveFailures: 1 });

    r = await round(t0 + 30_000);
    expect(r.mapIssues).toEqual(['maps.martin:CRITICAL']);
    expect(r.martin).toMatchObject({ ok: false, status: 'CRITICAL', consecutiveFailures: 2 });
    expect(r.dto.status).toBe('CRITICAL');
    expect(r.dto.issues.find((i) => i.id === 'maps.martin')!.message).toContain('map tiles unavailable');

    status.code = 200; // back up
    r = await round(t0 + 45_000);
    expect(r.mapIssues).toEqual([]);
    expect(r.martin).toMatchObject({ ok: true, status: 'OK', consecutiveFailures: 0, error: null });
  });

  it('a failing probe round falls back to the last snapshot instead of failing collect', async () => {
    jest.spyOn(svc.mapServices, 'collect').mockRejectedValueOnce(new Error('boom'));
    const r = await round(Date.parse('2026-11-11T11:00:00Z'));
    expect(r.martin).toMatchObject({ configured: true, ok: true, status: 'OK' });
    expect(r.mapIssues).toEqual([]);
  });
});
