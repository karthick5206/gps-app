import { RoutingError } from '../routing.errors';
import { OptimizerClient, readOptimizerConfig, tokenFromFile } from './optimizer.client';
import { SolverProblem } from '@veetracer/shared';
import { decideFailure } from '../../routing-jobs/job-state';

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
  it('v1.16: off only with the kill switch (ETMS_ROUTING=off or ETMS=off); unset / auto configure it', () => {
    expect(readOptimizerConfig({ ...ON, ETMS_ROUTING: 'off' }).problem).toBe('ETMS_ROUTING is off');
    expect(readOptimizerConfig({ ...ON, ETMS: 'off' }).problem).toBe('ETMS_ROUTING is off');
    expect(readOptimizerConfig({ OPTIMIZER_URL: ON.OPTIMIZER_URL, OPTIMIZER_TOKEN: TOKEN }).problem).toBeNull();
    expect(readOptimizerConfig({ OPTIMIZER_URL: ON.OPTIMIZER_URL, OPTIMIZER_TOKEN: TOKEN, ETMS_ROUTING: 'auto' }).problem).toBeNull();
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
    // E4 review L4: the optimiser refusing the API's token or source is final and says so (never busy, never retried).
    expect(await codeOf(client(json(401, { error: 'unauthorised' })).c.solve(problem))).toBe('OPTIMIZER_REFUSED');
    expect(await codeOf(client(json(403, { error: 'source not allowed' })).c.solve(problem))).toBe('OPTIMIZER_REFUSED');
    // A body over the service's limit is a limit, final like a 400.
    expect(await codeOf(client(json(413, { error: 'body must be 1..8388608 bytes' })).c.solve(problem))).toBe('LIMIT_EXCEEDED');
    expect(await codeOf(client(json(500, {})).c.solve(problem))).toBe('OPTIMIZER_UNAVAILABLE');
    expect(await codeOf(client(new Error('ECONNREFUSED')).c.solve(problem))).toBe('OPTIMIZER_UNAVAILABLE');
    expect(await codeOf(client(json(200, { hello: 1 })).c.solve(problem))).toBe('OPTIMIZER_UNAVAILABLE');
  });

  it('the 400 message of the service reaches the caller', async () => {
    await expect(client(json(400, { error: 'stops: 501 > 500' })).c.solve(problem)).rejects.toMatchObject({ message: 'stops: 501 > 500' });
  });
});

describe('E4 security review fixes (optimiser client)', () => {
  it('L9: OPTIMIZER_TOKEN_FILE wins over OPTIMIZER_TOKEN; an unreadable or empty file leaves the client off', () => {
    const files: Record<string, string> = { '/etc/veetrax/optimizer-client.token': `${'f'.repeat(40)}\n` };
    const read = (p: string) => {
      if (!(p in files)) throw Object.assign(new Error(`ENOENT: no such file ${p}`), { code: 'ENOENT' });
      return files[p];
    };
    expect(readOptimizerConfig({ ...ON, OPTIMIZER_TOKEN_FILE: '/etc/veetrax/optimizer-client.token' }, read)).toEqual({ baseUrl: 'http://127.0.0.1:8090', token: 'f'.repeat(40), problem: null });
    expect(readOptimizerConfig({ ETMS_ROUTING: 'on', OPTIMIZER_URL: ON.OPTIMIZER_URL, OPTIMIZER_TOKEN_FILE: '/etc/veetrax/optimizer-client.token' }, read).token).toBe('f'.repeat(40));
    expect(readOptimizerConfig({ ...ON, OPTIMIZER_TOKEN_FILE: '/nope' }, read)).toEqual({ baseUrl: '', token: '', problem: 'OPTIMIZER_TOKEN_FILE is not readable (ENOENT)' });
    files['/empty'] = '  \n';
    expect(readOptimizerConfig({ ...ON, OPTIMIZER_TOKEN_FILE: '/empty' }, read).problem).toBe('OPTIMIZER_TOKEN_FILE is empty');
    // the optimiser's EnvironmentFile format (/etc/veetrax/optimizer.env) is read as well
    files['/etc/veetrax/optimizer.env'] = `# generated\nOPTIMIZER_TOKEN="${'e'.repeat(43)}"\r\n`;
    expect(readOptimizerConfig({ ...ON, OPTIMIZER_TOKEN_FILE: '/etc/veetrax/optimizer.env' }, read).token).toBe('e'.repeat(43));
    expect(tokenFromFile('OPTIMIZER_TOKEN=a\nOPTIMIZER_TOKEN=b\n')).toBe('b');
    expect(tokenFromFile('OPTIMIZER_TOKEN=\n')).toBe('');
  });

  it('L5: a 400 (malformed input or limits) is final — LIMIT_EXCEEDED, which the job state machine never retries', async () => {
    for (const body of [{ status: 'INVALID_INPUT', error: 'invalid JSON body' }, { status: 'INVALID_INPUT', error: 'options.timeLimitS must be a number' }, {}]) {
      const e = await client(json(400, body)).c.solve(problem).catch((x: RoutingError) => x);
      expect(e).toBeInstanceOf(RoutingError);
      expect((e as RoutingError).code).toBe('LIMIT_EXCEEDED');
      expect(decideFailure({ code: 'LIMIT_EXCEEDED', message: (e as RoutingError).message }, { attempts: 1, maxAttempts: 3, cancelRequested: false }, 0)).toMatchObject({ to: 'FAILED' });
    }
    // a JSON 500 from the service stays transient (OPTIMIZER_UNAVAILABLE: retried with back-off)
    expect(await codeOf(client(json(500, { status: 'ERROR', error: 'internal error' })).c.solve(problem))).toBe('OPTIMIZER_UNAVAILABLE');
  });

  it('L4: a 400 text is scrubbed of coordinate-looking values and bounded', async () => {
    const e = (await client(json(400, { error: `bad point 13.0812,80.2654 ${'x'.repeat(400)}` })).c.solve(problem).catch((x: RoutingError) => x)) as RoutingError;
    expect(e.message).not.toMatch(/13\.0812|80\.2654/);
    expect(e.message.length).toBeLessThanOrEqual(200);
  });
});
