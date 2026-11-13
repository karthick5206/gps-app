import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { readJsonCapped, ResponseTooLarge } from './fetch-like';
import { GraphHopperMatrixEngine } from './matrix/gh-matrix-client';
import { OptimizerClient, readOptimizerConfig } from './optimizer/optimizer.client';

/**
 * E4 activation gates, security review of the routing-ON path (synthetic points only):
 * - L1: the optimiser and GraphHopper clients followed HTTP redirects, so a misbehaving local service could make the
 *   API re-send a problem body, or a GraphHopper URL with pickup coordinates, to another host.
 * - L2: neither client capped the size of the answer it read.
 */
const TOKEN = 't'.repeat(32);

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ srv: Server; url: string; hits: string[] }> {
  const hits: string[] = [];
  const srv = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    handler!(req, res);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, hits };
}
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

describe('E4 gates security L1: redirects are never followed', () => {
  it('optimiser: a 307 to another host fails as OPTIMIZER_UNAVAILABLE and the other host never sees the problem', async () => {
    const elsewhere = await listen((_q, res) => res.end('{}'));
    const optimiser = await listen((req, res) => {
      req.resume();
      res.writeHead(307, { Location: `${elsewhere.url}/optimize` }).end();
    });
    try {
      const c = new OptimizerClient(readOptimizerConfig({ ETMS_ROUTING: 'on', OPTIMIZER_URL: optimiser.url, OPTIMIZER_TOKEN: TOKEN }));
      await expect(c.solve({ matrix: { durationsS: [[0]] }, vehicles: [{ id: 'v' }], stops: [], options: { timeLimitS: 1 } } as never)).rejects.toMatchObject({ code: 'OPTIMIZER_UNAVAILABLE' });
      expect(await c.health()).toBe(false);
      expect(elsewhere.hits).toEqual([]);
    } finally {
      await close(optimiser.srv);
      await close(elsewhere.srv);
    }
  });

  it('GraphHopper: a 302 is an engine failure and the coordinates never reach the other host', async () => {
    const elsewhere = await listen((_q, res) => res.end('{"paths":[{"distance":1,"time":1}]}'));
    const gh = await listen((req, res) => res.writeHead(302, { Location: `${elsewhere.url}${req.url}` }).end());
    try {
      const engine = new GraphHopperMatrixEngine(gh.url);
      const r = await engine.pair({ lat: 13.01, lng: 80.21 }, { lat: 13.02, lng: 80.22 }, 'car');
      expect(r).toMatchObject({ kind: 'failure' });
      expect(gh.hits).toHaveLength(1);
      expect(elsewhere.hits).toEqual([]);
    } finally {
      await close(gh.srv);
      await close(elsewhere.srv);
    }
  });
});

describe('E4 gates security L2: answers are read with a byte cap', () => {
  it('readJsonCapped: declared and streamed (chunked) bodies over the cap are refused; small ones parse', async () => {
    const big = await listen((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' }); // chunked, no Content-Length
      for (let i = 0; i < 64; i++) res.write('x'.repeat(16 * 1024));
      res.end();
    });
    try {
      await expect(readJsonCapped(await fetch(big.url), 100_000)).rejects.toBeInstanceOf(ResponseTooLarge);
      const declared = new Response('{"a":1}', { headers: { 'content-length': '200000' } });
      await expect(readJsonCapped(declared, 100_000)).rejects.toBeInstanceOf(ResponseTooLarge);
      expect(await readJsonCapped(new Response('{"a":1}'), 100_000)).toEqual({ a: 1 });
    } finally {
      await close(big.srv);
    }
  });

  it('optimiser: an answer over 16 MB is OPTIMIZER_UNAVAILABLE ("too large"), not parsed', async () => {
    const optimiser = await listen((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const chunk = 'x'.repeat(1024 * 1024);
        let n = 0;
        const more = () => {
          while (n < 18) {
            n++;
            if (!res.write(chunk)) return res.once('drain', more);
          }
          res.end();
        };
        more();
      });
    });
    try {
      const c = new OptimizerClient(readOptimizerConfig({ ETMS_ROUTING: 'on', OPTIMIZER_URL: optimiser.url, OPTIMIZER_TOKEN: TOKEN }));
      await expect(c.solve({ matrix: { durationsS: [[0]] }, vehicles: [{ id: 'v' }], stops: [], options: { timeLimitS: 1 } } as never)).rejects.toMatchObject({ code: 'OPTIMIZER_UNAVAILABLE', message: 'Optimizer answer is too large' });
    } finally {
      optimiser.srv.closeAllConnections();
      await close(optimiser.srv);
    }
  });
});
