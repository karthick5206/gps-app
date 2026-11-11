import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { Socket } from 'net';
import { haversineMeters } from '../../../tracking/geo';
import { encodePolyline } from '../../../etms/testing/graphhopper-stub';

/**
 * Matrix-capable GraphHopper 11 stand-in (synthetic, loopback only, no map data). Extends what the E3 stub
 * (`etms/testing/graphhopper-stub.ts`) answers with what the matrix builder sends:
 * - `GET /route` with 2..k points, `calc_points`, `points_encoded`, `details=leg_time&details=leg_distance`;
 *   errors in GraphHopper's JSON shape ("Cannot find point N", "Connection between locations not found");
 * - `GET /info` (version, data_date, import_date, profiles) and `GET /health`.
 *
 * Road model: deterministic and ASYMMETRIC (a leg heading north costs more), so a builder that copies d(i,j) into
 * d(j,i) fails the tests. Leg distance = straight line × 1.3 + (north-bound ? 40 m : 0); time at 30 km/h (+8 %
 * north-bound). Behaviour switches: `mode`, `offRoad`, `island`, `noExit`, `failEvery`, `legDelayMs`, `legDetails`,
 * `walkSkew`, `snapOffsetM`.
 */
export type MatrixStubMode = 'up' | 'hang' | 'error' | 'noroute';

type P = [number, number]; // [lat, lng]

export function stubLeg(a: P, b: P): { distance: number; time: number } {
  const straight = haversineMeters(a[0], a[1], b[0], b[1]);
  if (straight === 0) return { distance: 0, time: 0 };
  const north = b[0] > a[0];
  const distance = Math.round((straight * 1.3 + (north ? 40 : 0)) * 10) / 10;
  const time = Math.round((distance / (30_000 / 3600)) * 1000 * (north ? 1.08 : 1));
  return { distance, time };
}

export class GraphHopperMatrixStub {
  mode: MatrixStubMode = 'up';
  /** /route requests hang (never answered) while /health and /info stay up: a slow, overloaded engine. */
  hangRoute = false;
  /** Points the "graph" cannot snap (→ 400 Cannot find point N). */
  offRoad: (lat: number, lng: number) => boolean = () => false;
  /** Road component of a point; legs between components have no route. */
  island: (lat: number, lng: number) => string = () => 'main';
  /** Points that can be reached but not left (one-way trap). */
  noExit: (lat: number, lng: number) => boolean = () => false;
  /** Every Nth `/route` request answers 500 (0 = never). */
  failEvery = 0;
  /** Artificial engine time per leg (ms). */
  legDelayMs = 0;
  /** Whether walks carry leg_time / leg_distance details. */
  legDetails = true;
  /** Multiplier on walk leg times (≠ 1 simulates walks that disagree with single routes). */
  walkSkew = 1;
  /** How far (m, northward) the snapped waypoint is from the input point. */
  snapOffsetM: (lat: number, lng: number) => number = () => 3;
  info: Record<string, unknown> = { version: '11.1', data_date: '2026-11-01T00:00:00Z', import_date: '2026-11-10T02:00:00Z', profiles: [{ name: 'car' }] };

  readonly calls = { pair: 0, walk: 0, snap: 0, info: 0, health: 0, legs: 0, failed: 0 };
  /** Max requests the stub was answering at once (proves the in-flight cap). */
  maxInFlight = 0;
  private inFlight = 0;
  private routeCount = 0;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private boundPort = 0;

  get url(): string {
    return `http://127.0.0.1:${this.boundPort}`;
  }

  reset(): void {
    for (const k of Object.keys(this.calls) as (keyof typeof this.calls)[]) this.calls[k] = 0;
    this.maxInFlight = 0;
    this.routeCount = 0;
  }

  async start(port = this.boundPort): Promise<string> {
    if (this.server) return this.url;
    const server = createServer((req, res) => void this.handle(req, res));
    server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    this.boundPort = typeof addr === 'object' && addr ? addr.port : port;
    this.server = server;
    return this.url;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://stub');
    const json = (status: number, body: unknown) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/health') this.calls.health++;
    if (url.pathname === '/info') this.calls.info++;
    if (this.mode === 'hang') return;
    if (this.mode === 'error') return json(500, { message: 'stub: engine error' });
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
      return;
    }
    if (url.pathname === '/info') return json(200, this.info);
    if (url.pathname !== '/route') return json(404, { message: 'stub: not found' });
    if (this.hangRoute) return;

    const pts = url.searchParams.getAll('point').map((p) => p.split(',').map(Number) as P);
    const snap = pts.length === 2 && pts[0][0] === pts[1][0] && pts[0][1] === pts[1][1] && url.searchParams.get('calc_points') === 'true';
    const details = url.searchParams.getAll('details');
    const walk = details.includes('leg_time');
    if (snap) this.calls.snap++;
    else if (walk) this.calls.walk++;
    else this.calls.pair++;
    this.routeCount++;
    if (this.failEvery > 0 && this.routeCount % this.failEvery === 0) {
      this.calls.failed++;
      return json(500, { message: 'stub: intermittent engine error' });
    }
    if (this.mode === 'noroute') return json(400, { message: 'Connection between locations not found', hints: [{ message: 'Connection between locations not found', details: 'com.graphhopper.util.exceptions.ConnectionNotFoundException' }] });
    if (pts.length < 2 || pts.some((p) => p.length !== 2 || !p.every(Number.isFinite))) return json(400, { message: 'stub: bad points' });

    const bad = pts.findIndex((p) => this.offRoad(p[0], p[1]));
    if (bad >= 0) {
      const message = `Cannot find point ${bad}: ${pts[bad][0]},${pts[bad][1]}`;
      return json(400, { message, hints: [{ message, details: 'com.graphhopper.util.exceptions.PointNotFoundException', point_index: bad }] });
    }
    const legs = pts.length - 1;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.legDelayMs > 0) await new Promise((r) => setTimeout(r, this.legDelayMs * Math.max(1, legs)));
      if (res.destroyed) return;
      const out: { distance: number; time: number }[] = [];
      for (let i = 1; i < pts.length; i++) {
        const [a, b] = [pts[i - 1], pts[i]];
        const same = a[0] === b[0] && a[1] === b[1];
        if (!same && (this.island(a[0], a[1]) !== this.island(b[0], b[1]) || this.noExit(a[0], a[1]))) {
          return json(400, { message: 'Connection between locations not found', hints: [{ message: 'Connection between locations not found', details: 'com.graphhopper.util.exceptions.ConnectionNotFoundException' }] });
        }
        const l = stubLeg(a, b);
        out.push(walk ? { distance: l.distance, time: Math.round(l.time * this.walkSkew) } : l);
      }
      this.calls.legs += legs;
      const distance = Math.round(out.reduce((t, l) => t + l.distance, 0) * 10) / 10;
      const time = out.reduce((t, l) => t + l.time, 0);
      const path: Record<string, unknown> = { distance, time, weight: time / 1000 };
      if (url.searchParams.get('calc_points') !== 'false') {
        const snapped = pts.map(([lat, lng]) => [lat + this.snapOffsetM(lat, lng) / 111_195, lng] as P);
        if (url.searchParams.get('points_encoded') === 'false') {
          path.points = { type: 'LineString', coordinates: snapped.map(([la, ln]) => [ln, la]) };
          path.snapped_waypoints = { type: 'LineString', coordinates: snapped.map(([la, ln]) => [ln, la]) };
        } else {
          path.points = encodePolyline(snapped);
          path.snapped_waypoints = encodePolyline(snapped);
          path.points_encoded = true;
          path.points_encoded_multiplier = 1e5;
        }
      }
      if (walk && this.legDetails) {
        path.details = {
          leg_time: out.map((l, i) => [i, i + 1, l.time]),
          leg_distance: out.map((l, i) => [i, i + 1, l.distance]),
        };
      }
      json(200, { hints: { 'visited_nodes.sum': legs * 100 }, info: { copyrights: ['synthetic stub'], took: 0 }, paths: [path] });
    } finally {
      this.inFlight--;
    }
  }
}
