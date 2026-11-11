import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { CheckInput, evaluateChecks } from './checks';
import { MapServiceMonitor, MapServiceState, mapServiceTargets, probeMapService } from './map-services';
import { mapServiceDtos } from './system-health.service';
import { loadThresholds } from './thresholds';

const t = loadThresholds({});

/** Local stub of a map service: `/health` and `/status` answer `status` (or hang when status is 0). */
function stub(status: { code: number }, port = 0): Promise<Server> {
  const server = createServer((_req, res) => {
    if (status.code === 0) return; // never answers → timeout
    res.writeHead(status.code, { 'content-type': 'text/plain' });
    res.end(status.code === 200 ? 'OK' : 'down');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
const close = (s: Server) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); });
const portOf = (s: Server) => (s.address() as AddressInfo).port;

/** A minimal healthy check input (no processes expected), so only the map states produce issues. */
function baseInput(): CheckInput {
  return {
    now: Date.now(),
    expectedRoles: [],
    processes: [],
    ports: [],
    queues: [],
    database: { status: 'OK', reachable: true, error: null, latencyMs: 1, activeConnections: 0, totalConnections: 0, maxConnections: 0, sizeBytes: 0, topTables: [], insertsPerMin: null },
    valkey: { status: 'OK', reachable: true, error: null, version: null, latencyMs: 1, usedMemory: 0, maxMemory: 0, memoryPercent: null, aofEnabled: true, rdbLastSaveStatus: 'ok', rdbLastSaveAt: null, connectedClients: 0, evictedKeys: 0 },
    host: { status: 'OK', hostname: 'h', platform: 'linux', dataDir: '/', diskTotal: null, diskFree: null, diskFreePercent: null, loadAvg: [], cpus: 1, memTotal: 1, memFree: 1, uptimeSec: 1 },
    notifications: null,
    startupGrace: false,
  };
}

const mapIssues = (maps: MapServiceState[]) => evaluateChecks({ ...baseInput(), maps }, t).map((i) => `${i.id}:${i.severity}`);

describe('mapServiceTargets', () => {
  it('only configured services get a probe URL', () => {
    expect(mapServiceTargets({}).map((x) => x.probeUrl)).toEqual([null, null, null]);
    const all = mapServiceTargets({ ROUTER_URL: 'http://127.0.0.1:8989/', ROUTER_ENGINE: 'graphhopper', GEOCODER: 'photon', GEOCODER_URL: 'http://127.0.0.1:2322', MARTIN_URL: 'http://127.0.0.1:3000' });
    expect(all.map((x) => [x.name, x.probeUrl])).toEqual([
      ['graphhopper', 'http://127.0.0.1:8989/health'],
      ['photon', 'http://127.0.0.1:2322/status'],
      ['martin', 'http://127.0.0.1:3000/health'],
    ]);
  });

  it('Valhalla routing and the public Nominatim geocoder are not probed as GraphHopper / Photon', () => {
    const targets = mapServiceTargets({ ROUTER_URL: 'http://127.0.0.1:8002', GEOCODER: 'nominatim', GEOCODER_URL: 'https://nominatim.openstreetmap.org' });
    expect(targets.map((x) => x.probeUrl)).toEqual([null, null, null]);
  });
});

describe('probeMapService (local stub server)', () => {
  it('200 → ok; 503 → failed with the HTTP code; closed port → failed; no answer → timeout', async () => {
    const status = { code: 200 };
    const server = await stub(status);
    const url = `http://127.0.0.1:${portOf(server)}/health`;
    try {
      expect(await probeMapService(url)).toMatchObject({ ok: true, error: null });
      status.code = 503;
      expect(await probeMapService(url)).toMatchObject({ ok: false, error: 'HTTP 503' });
      status.code = 0;
      expect(await probeMapService(url, 200)).toMatchObject({ ok: false, latencyMs: null, error: 'no answer within 200 ms' });
    } finally {
      await close(server);
    }
    expect(await probeMapService(url, 1000)).toMatchObject({ ok: false, error: 'ECONNREFUSED' });
  });
});

describe('MapServiceMonitor', () => {
  it('up → OK, stopped → CRITICAL after 2 failed probes, restarted → recovered (Martin)', async () => {
    const status = { code: 200 };
    let server = await stub(status);
    const port = portOf(server);
    const monitor = new MapServiceMonitor(mapServiceTargets({ MARTIN_URL: `http://127.0.0.1:${port}` }), { minIntervalMs: 0, timeoutMs: 1000 });
    try {
      let maps = await monitor.collect();
      expect(maps.find((m) => m.name === 'martin')).toMatchObject({ configured: true, ok: true, consecutiveFailures: 0 });
      expect(maps.filter((m) => !m.configured).map((m) => m.name)).toEqual(['graphhopper', 'photon']);
      expect(mapIssues(maps)).toEqual([]);

      await close(server); // "kill" Martin
      maps = await monitor.collect();
      expect(maps.find((m) => m.name === 'martin')).toMatchObject({ ok: false, consecutiveFailures: 1, error: 'ECONNREFUSED' });
      expect(mapIssues(maps)).toEqual([]); // one failure: not reported yet
      maps = await monitor.collect();
      expect(mapIssues(maps)).toEqual(['maps.martin:CRITICAL']);

      server = await stub(status, port); // restart
      maps = await monitor.collect();
      expect(maps.find((m) => m.name === 'martin')).toMatchObject({ ok: true, consecutiveFailures: 0, error: null });
      expect(mapIssues(maps)).toEqual([]);
    } finally {
      await close(server);
    }
  });

  it('GraphHopper and Photon answering 503 → WARN after 2 probes', async () => {
    const status = { code: 503 };
    const server = await stub(status);
    const base = `http://127.0.0.1:${portOf(server)}`;
    const monitor = new MapServiceMonitor(mapServiceTargets({ ROUTER_URL: base, ROUTER_ENGINE: 'graphhopper', GEOCODER: 'photon', GEOCODER_URL: base }), { minIntervalMs: 0 });
    try {
      await monitor.collect();
      expect(mapIssues(await monitor.collect())).toEqual(['maps.graphhopper:WARN', 'maps.photon:WARN']);
    } finally {
      await close(server);
    }
  });

  it('reuses the last result within minIntervalMs and shares one probe between concurrent callers', async () => {
    const fetchImpl = jest.fn(async () => new Response('OK', { status: 200 }));
    const monitor = new MapServiceMonitor(mapServiceTargets({ MARTIN_URL: 'http://martin.test' }), { minIntervalMs: 10_000, fetchImpl: fetchImpl as unknown as typeof fetch });
    await Promise.all([monitor.collect(1_000), monitor.collect(1_000)]);
    await monitor.collect(5_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await monitor.collect(11_001);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('nothing configured → no probes at all', async () => {
    const fetchImpl = jest.fn();
    const monitor = new MapServiceMonitor(mapServiceTargets({}), { minIntervalMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    const maps = await monitor.collect();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(maps.every((m) => !m.configured && m.ok)).toBe(true);
    expect(mapIssues(maps)).toEqual([]);
  });
});

describe('mapServiceDtos (System Health report rows)', () => {
  it('status comes from the maps.<name> issue: a single failure still shows OK (retrying), 2 show the severity', async () => {
    const fetchImpl = jest.fn(async () => new Response('down', { status: 503 }));
    const monitor = new MapServiceMonitor(mapServiceTargets({ MARTIN_URL: 'http://martin.test' }), { minIntervalMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    const rows = async () => {
      const maps = await monitor.collect(Date.parse('2026-11-11T10:00:00Z'));
      const issues = evaluateChecks({ ...baseInput(), maps }, t);
      return mapServiceDtos(maps, issues);
    };
    let dto = await rows();
    expect(dto.map((d) => [d.name, d.configured, d.status])).toEqual([['graphhopper', false, 'OK'], ['photon', false, 'OK'], ['martin', true, 'OK']]);
    expect(dto[2]).toMatchObject({ ok: false, error: 'HTTP 503', consecutiveFailures: 1, probeUrl: 'http://martin.test/health', checkedAt: '2026-11-11T10:00:00.000Z' });
    dto = await rows();
    expect(dto[2]).toMatchObject({ status: 'CRITICAL', consecutiveFailures: 2 });
  });
});
