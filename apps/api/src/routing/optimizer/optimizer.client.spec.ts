import { RoutingError } from '../routing.errors';
import { OptimizerClient, readOptimizerConfig } from './optimizer.client';
import { SolverProblem } from '@veetracer/shared';

const TOKEN = 'x'.repeat(32);
const ON = { ETMS_ROUTING: 'on', OPTIMIZER_URL: 'http://127.0.0.1:8090/', OPTIMIZER_TOKEN: TOKEN };

const problem: SolverProblem = {
  matrix: { durationsS: [[0, 60], [60, 0]], distancesM: [[0, 900], [900, 0]] },
  vehicles: [{ id: 'v1', startIndex: 0, endIndex: 0, capacity: 4 }],
  stops: [{ id: 's1', locationIndex: 1, demand: 1 }],
  options: { timeLimitS: 2 },
};
const solved = { status: 'FEASIBLE', provenOptimal: false, routes: [{ vehicleId: 'v1', startS: 0, endS: 120, durationS: 120, distanceM: 1800, stops: [] }], unassigned: [] };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function client(reply: Response | Error, env: NodeJS.ProcessEnv = ON) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { c: new OptimizerClient(readOptimizerConfig(env), fetchImpl), calls };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return e instanceof RoutingError ? e.code : `other: ${(e as Error).message}`;
  }
}

describe('readOptimizerConfig', () => {
  it('is off unless ETMS_ROUTING=on', () => {
    expect(readOptimizerConfig({ OPTIMIZER_URL: ON.OPTIMIZER_URL, OPTIMIZER_TOKEN: TOKEN }).problem).toBe('ETMS_ROUTING is off');
    expect(readOptimizerConfig({ ...ON, ETMS: 'off' }).problem).toBe('ETMS_ROUTING is off');
  });

  it('needs a private URL and a token', () => {
    expect(readOptimizerConfig({ ETMS_ROUTING: 'on' }).problem).toBe('OPTIMIZER_URL is not set');
    expect(readOptimizerConfig({ ...ON, OPTIMIZER_URL: 'https://solver.example.com' }).problem).toMatch(/OPTIMIZER_URL refused: .*not a loopback or private host/);
    expect(readOptimizerConfig({ ...ON, OPTIMIZER_TOKEN: ' ' }).problem).toBe('OPTIMIZER_TOKEN is not set');
    expect(readOptimizerConfig(ON)).toEqual({ baseUrl: 'http://127.0.0.1:8090', token: TOKEN, problem: null });
  });
});

describe('OptimizerClient', () => {
  it('switched off: no request at all, OPTIMIZER_UNAVAILABLE', async () => {
    const { c, calls } = client(json(200, solved), {});
    expect(c.configured).toBe(false);
    expect(await c.health()).toBe(false);
    expect(await codeOf(c.solve(problem))).toBe('OPTIMIZER_UNAVAILABLE');
    expect(calls).toHaveLength(0);
  });

  it('posts the problem with the bearer token and returns the result', async () => {
    const { c, calls } = client(json(200, solved));
    await expect(c.solve(problem)).resolves.toEqual(solved);
    expect(calls[0].url).toBe('http://127.0.0.1:8090/optimize');
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(problem);
  });

  it('health sends the token too', async () => {
    const { c, calls } = client(json(200, { ok: true }));
    expect(await c.health()).toBe(true);
    expect(calls[0].url).toBe('http://127.0.0.1:8090/health');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(await client(json(401, {})).c.health()).toBe(false);
    expect(await client(new Error('ECONNREFUSED')).c.health()).toBe(false);
  });

  it('maps service answers to typed errors', async () => {
    expect(await codeOf(client(json(429, { error: 'optimizer busy' })).c.solve(problem))).toBe('OPTIMIZER_BUSY');
    expect(await codeOf(client(json(400, { status: 'INVALID_INPUT', error: 'vehicles required' })).c.solve(problem))).toBe('LIMIT_EXCEEDED');
    expect(await codeOf(client(json(401, { error: 'unauthorised' })).c.solve(problem))).toBe('OPTIMIZER_UNAVAILABLE');
    expect(await codeOf(client(json(500, {})).c.solve(problem))).toBe('OPTIMIZER_UNAVAILABLE');
    expect(await codeOf(client(new Error('ECONNREFUSED')).c.solve(problem))).toBe('OPTIMIZER_UNAVAILABLE');
    expect(await codeOf(client(json(200, { hello: 1 })).c.solve(problem))).toBe('OPTIMIZER_UNAVAILABLE');
  });

  it('the 400 message of the service reaches the caller', async () => {
    await expect(client(json(400, { error: 'stops: 501 > 500' })).c.solve(problem)).rejects.toMatchObject({ message: 'stops: 501 > 500' });
  });
});
