import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { Socket } from 'net';
import { haversineMeters } from '../../tracking/geo';

/**
 * A GraphHopper stand-in for the ETMS E3 harness (12 WP 3.8; 16 §4 "GraphHopper 18989"). It answers `GET /route`
 * (car profile, `point=lat,lng` repeated, encoded polyline at precision 5) and `GET /health` like GraphHopper 10, with
 * straight-line geometry and a fixed road factor / speed so ETAs are predictable. Synthetic only: no map data, no
 * outside network. Modes:
 * - `up`      normal answers;
 * - `hang`    accepts the request and never answers (the client's own timeout fires);
 * - `error`   HTTP 500 (engine fault);
 * - `noroute` HTTP 400 (GraphHopper's "no route / point not near a road");
 * - stopped   `stop()` closes the listener, so the port refuses connections (the production failure mode:
 *             GraphHopper process down while ROUTER_URL is still set). `start()` again on the same port brings it back.
 */
export type GraphHopperStubMode = 'up' | 'hang' | 'error' | 'noroute';

export const STUB_ROAD_FACTOR = 1.3;
export const STUB_SPEED_KPH = 30;

/** Google polyline encoding of [lat, lng] pairs (GraphHopper `points_encoded=true`, multiplier 1e5 by default). */
export function encodePolyline(points: [number, number][], precision = 5): string {
  const f = 10 ** precision;
  let out = '';
  let pLat = 0;
  let pLng = 0;
  const enc = (v: number) => {
    let x = v < 0 ? ~(v << 1) : v << 1;
    while (x >= 0x20) {
      out += String.fromCharCode((0x20 | (x & 0x1f)) + 63);
      x >>= 5;
    }
    out += String.fromCharCode(x + 63);
  };
  for (const [lat, lng] of points) {
    const la = Math.round(lat * f);
    const ln = Math.round(lng * f);
    enc(la - pLat);
    enc(ln - pLng);
    pLat = la;
    pLng = ln;
  }
  return out;
}

/** The stub's answer for some points: distance = straight line × road factor, time at the stub speed. */
export function stubRoute(points: [number, number][]): { distance: number; time: number; points: string; points_encoded_multiplier: number } {
  let straight = 0;
  for (let i = 1; i < points.length; i++) straight += haversineMeters(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
  const distance = Math.round(straight * STUB_ROAD_FACTOR);
  const time = Math.round((distance / ((STUB_SPEED_KPH * 1000) / 3600)) * 1000);
  return { distance, time, points: encodePolyline(points), points_encoded_multiplier: 1e5 };
}

export class GraphHopperStub {
  mode: GraphHopperStubMode = 'up';
  /** Requests seen per path since start (or the last `reset()`). */
  readonly hits: Record<string, number> = {};
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private boundPort = 0;

  constructor(private readonly host = '127.0.0.1') {}

  get port(): number {
    return this.boundPort;
  }

  get url(): string {
    return `http://${this.host}:${this.boundPort}`;
  }

  get running(): boolean {
    return this.server !== null;
  }

  reset(): void {
    for (const k of Object.keys(this.hits)) delete this.hits[k];
  }

  /** Listens on `port` (0 = any free port; a previous port is reused after `stop()`). Resolves with the base URL. */
  async start(port = this.boundPort): Promise<string> {
    if (this.server) return this.url;
    const server = createServer((req, res) => this.handle(req, res));
    server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, this.host, () => resolve());
    });
    const addr = server.address();
    this.boundPort = typeof addr === 'object' && addr ? addr.port : port;
    this.server = server;
    return this.url;
  }

  /** Closes the listener and every open (including hanging) connection: the port now refuses connections. */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://stub');
    this.hits[url.pathname] = (this.hits[url.pathname] ?? 0) + 1;
    if (this.mode === 'hang') return; // never answer; the socket is destroyed on stop()
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (this.mode === 'error') return json(500, { message: 'stub: engine error' });
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
      return;
    }
    if (url.pathname !== '/route') return json(404, { message: 'stub: not found' });
    if (this.mode === 'noroute') return json(400, { message: 'stub: Connection between locations not found' });
    const points = url.searchParams
      .getAll('point')
      .map((p) => p.split(',').map(Number) as [number, number])
      .filter((p) => p.length === 2 && p.every(Number.isFinite));
    if (points.length < 2) return json(400, { message: 'stub: at least 2 points' });
    json(200, { hints: { 'visited_nodes.sum': 0 }, info: { copyrights: ['synthetic stub'], took: 0 }, paths: [stubRoute(points)] });
  }
}
