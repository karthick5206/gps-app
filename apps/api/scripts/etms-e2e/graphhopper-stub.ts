/**
 * Stand-alone GraphHopper stub for manual / stack runs of the ETMS harness (12 WP 3.8). Point the API at it with
 * ROUTER_URL=http://127.0.0.1:18989 ROUTER_ENGINE=graphhopper and switch modes over the control port:
 *
 *   npx tsx scripts/etms-e2e/graphhopper-stub.ts [--port 18989] [--control-port 18990]
 *   curl "http://127.0.0.1:18990/mode?set=hang"     # up | hang | error | noroute | down
 *   curl "http://127.0.0.1:18990/stats"
 *
 * `down` closes the routing port (connection refused, like a stopped GraphHopper); `up` reopens it on the same port.
 * Both listeners bind 127.0.0.1 only. Synthetic straight-line routes; no map data, no outside network.
 */
import { createServer } from 'node:http';
import { GraphHopperStub, type GraphHopperStubMode } from '../../src/etms/testing/graphhopper-stub';

const argv = process.argv.slice(2);
const opt = (n: string, d: number) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const PORT = opt('port', 18989);
const CONTROL = opt('control-port', PORT + 1);
const MODES = ['up', 'hang', 'error', 'noroute', 'down'] as const;

async function main() {
  const stub = new GraphHopperStub();
  await stub.start(PORT);
  const control = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://control');
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/mode') {
        const set = url.searchParams.get('set') as (typeof MODES)[number] | null;
        if (set) {
          if (!MODES.includes(set)) return reply(400, { error: `mode must be one of ${MODES.join(', ')}` });
          if (set === 'down') await stub.stop();
          else {
            stub.mode = set as GraphHopperStubMode;
            if (!stub.running) await stub.start(PORT);
          }
          console.log(`mode → ${set}`);
        }
        return reply(200, { mode: stub.running ? stub.mode : 'down', port: PORT });
      }
      if (url.pathname === '/stats') return reply(200, { mode: stub.running ? stub.mode : 'down', hits: stub.hits });
      reply(404, { error: 'GET /mode?set=…, /stats' });
    })();
  });
  await new Promise<void>((r) => control.listen(CONTROL, '127.0.0.1', () => r()));
  console.log(`GraphHopper stub on http://127.0.0.1:${PORT} (control http://127.0.0.1:${CONTROL})`);
  const close = async () => {
    await stub.stop();
    control.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void close());
  process.on('SIGTERM', () => void close());
}

void main();
