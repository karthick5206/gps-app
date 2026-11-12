import { createServer, type Server } from 'net';
import type { SolverProblem } from '@veetracer/shared';
import { RoutingError } from '../routing.errors';
import { OptimizerClient, readOptimizerConfig } from './optimizer.client';

/**
 * T3 E2E (load test) T3-D6, client side: a busy optimiser that closes the connection while the request body is still
 * being uploaded (a reset / broken pipe instead of a readable 429) is BUSY (retried without using an attempt, T3-D2),
 * not UNAVAILABLE. A refused connection or a timeout stays UNAVAILABLE. The service itself now drains the body after its
 * 429 (server.py), so the client normally sees the 429; this covers older services and resets.
 */
const TOKEN = 'x'.repeat(32);
const problem: SolverProblem = { matrix: { durationsS: [[0, 60], [60, 0]] }, vehicles: [{ id: 'v1', startIndex: 0 }], stops: [{ id: 's1', locationIndex: 1 }], options: { timeLimitS: 1 } };

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return e instanceof RoutingError ? e.code : `other: ${(e as Error).message}`;
  }
}

const failing = (cause: unknown) => {
  const env = { ETMS_ROUTING: 'on', OPTIMIZER_URL: 'http://127.0.0.1:8090/', OPTIMIZER_TOKEN: TOKEN };
  return new OptimizerClient(readOptimizerConfig(env), async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause });
  });
};

describe('T3-D6 optimiser client: reset during the upload', () => {
  const large = { ...problem, pad: 'x'.repeat(600_000) } as unknown as SolverProblem;

  it('a reset / broken pipe / closed socket during a large upload (≥ 256 KB) is OPTIMIZER_BUSY', async () => {
    for (const code of ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']) expect(await codeOf(failing({ code }).solve(large))).toBe('OPTIMIZER_BUSY');
  });

  it('a reset with a small body (it fits the socket buffers: the service went away) stays OPTIMIZER_UNAVAILABLE', async () => {
    for (const code of ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']) expect(await codeOf(failing({ code }).solve(problem))).toBe('OPTIMIZER_UNAVAILABLE');
  });

  it('a refused connection or a timeout stays OPTIMIZER_UNAVAILABLE', async () => {
    expect(await codeOf(failing({ code: 'ECONNREFUSED' }).solve(problem))).toBe('OPTIMIZER_UNAVAILABLE');
    const env = { ETMS_ROUTING: 'on', OPTIMIZER_URL: 'http://127.0.0.1:8090/', OPTIMIZER_TOKEN: TOKEN };
    const timeout = new OptimizerClient(readOptimizerConfig(env), async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    expect(await codeOf(timeout.solve(problem))).toBe('OPTIMIZER_UNAVAILABLE');
  });

  describe('against a socket that drops the upload', () => {
    let srv: Server;
    let port = 0;
    beforeAll(async () => {
      srv = createServer((s) => s.once('data', () => s.resetAndDestroy()));
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
      port = (srv.address() as { port: number }).port;
    });
    afterAll(() => new Promise<void>((r) => srv.close(() => r())));

    it('a 4 MB body cut off by the service is OPTIMIZER_BUSY, quickly', async () => {
      const c = new OptimizerClient(readOptimizerConfig({ ETMS_ROUTING: 'on', OPTIMIZER_URL: `http://127.0.0.1:${port}/`, OPTIMIZER_TOKEN: TOKEN }));
      const big = { ...problem, pad: 'x'.repeat(4_000_000) } as unknown as SolverProblem;
      const t0 = Date.now();
      expect(await codeOf(c.solve(big))).toBe('OPTIMIZER_BUSY');
      expect(Date.now() - t0).toBeLessThan(5_000);
    });
  });
});
