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
const byPath = new Map(rules.map((r) => r.split('=')).map(([p, s]) => [p.startsWith('/') ? p : `/${p}`, Number(s)]));

createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  const status = byPath.get(path) ?? Number(fallback);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: status === 200, status: status === 200 ? 'OK' : 'CRITICAL', stub: true, path }));
}).listen(Number(port), '127.0.0.1', () => console.log(`listening ${port}`));
