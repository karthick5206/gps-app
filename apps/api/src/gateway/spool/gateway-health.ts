import { SpoolMetrics } from '@veetracer/shared';
import { createServer, Server } from 'node:http';

/** Positions not acknowledged within this window make the gateway "failing". */
export const NOT_ACKED_WINDOW_MS = 60_000;

export interface GatewayHealthInput {
  listeners: { protocol: string; port: number; listening: boolean; connections: number }[];
  spool: SpoolMetrics;
  /** Epoch ms of the last time `notAcked` increased, or null. */
  lastNotAckedAt: number | null;
  now: number;
}

export interface GatewayHealth {
  /** ok: cache ready, spool empty. degraded: positions are safe on disk but not flowing (cache down / backlog). failing: positions are being refused or a listener is down. */
  status: 'ok' | 'degraded' | 'failing';
  reasons: string[];
  cacheReady: boolean;
  spool: SpoolMetrics;
  listeners: GatewayHealthInput['listeners'];
}

/** Pure: gateway status for the local health endpoint (unit-tested). */
export function gatewayHealth(input: GatewayHealthInput): GatewayHealth {
  const reasons: string[] = [];
  let failing = false;
  for (const l of input.listeners) {
    if (!l.listening) {
      failing = true;
      reasons.push(`${l.protocol} port ${l.port} is not listening`);
    }
  }
  if (input.lastNotAckedAt !== null && input.now - input.lastNotAckedAt < NOT_ACKED_WINDOW_MS) {
    failing = true;
    reasons.push('positions are being refused (cache down and spool full or unwritable): devices are not acknowledged');
  }
  const s = input.spool;
  if (!s.cacheReady) reasons.push(s.enabled ? 'cache unavailable: positions are spooled to disk' : 'cache unavailable and the spool is disabled');
  if (!s.enabled && !s.cacheReady) failing = true;
  if (s.backpressure) reasons.push('processor backlog near the stream cap: positions are spooled to disk');
  if (s.pendingEntries > 0) reasons.push(`${s.pendingEntries} position(s) waiting in the spool`);
  const status = failing ? 'failing' : reasons.length ? 'degraded' : 'ok';
  return { status, reasons, cacheReady: s.cacheReady, spool: s, listeners: input.listeners };
}

/**
 * Localhost-only HTTP endpoint for the Windows watchdog, which must see the gateway even while the cache (and so the
 * heartbeat in System Health) is down.
 *   GET /health/live → 200 while the process runs
 *   GET /health      → 200 ok/degraded, 503 failing; JSON body from gatewayHealth()
 */
export function startGatewayHealthServer(port: number, read: () => GatewayHealth): Promise<Server> {
  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    if (url === '/health/live') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }
    if (url === '/health' || url === '/health/ready') {
      const h = read();
      res.writeHead(h.status === 'failing' ? 503 : 200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: h.status === 'ok', ...h }));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
