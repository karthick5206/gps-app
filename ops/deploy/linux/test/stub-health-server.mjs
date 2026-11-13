// Tiny HTTP stub for testing health-gate.sh and the System Health map checks without the real services.
//   node stub-health-server.mjs <port> [status=200] [path=status ...]
// e.g. node stub-health-server.mjs 18080 200 api/health/tracking=503
// Every path answers <status> unless listed; body {"ok":...,"status":...}. Writes "listening <port>" once ready.
import { createServer } from 'node:http';

const [port, fallback = '200', ...rules] = process.argv.slice(2);
if (!port) {
  console.error('usage: node stub-health-server.mjs <port> [status] [path=status ...]');
  process.exit(2);
}
// Paths may be given without the leading slash (Git Bash rewrites arguments that start with /).
// A value like 200@idle also puts "switch":"idle" into the body (GET /api/health/routing, v1.16).
const byPath = new Map(rules.map((r) => r.split('=')).map(([p, s]) => [p.startsWith('/') ? p : `/${p}`, s]));

createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  const [code, sw] = (byPath.get(path) ?? fallback).split('@');
  const status = Number(code);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: status === 200, status: status === 200 ? 'OK' : 'CRITICAL', stub: true, path, ...(sw ? { switch: sw, failing: status === 200 ? [] : ['worker', 'engine'] } : {}) }));
}).listen(Number(port), '127.0.0.1', () => console.log(`listening ${port}`));
