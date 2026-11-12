/**
 * Real-process stack for the HTTP stage of the ETMS E3 gate (12 WP 3.8, the chaos-run pattern): the built `dist/` API
 * and processor on free local ports, against a scratch `*_test` database and a PRIVATE Valkey database index.
 *
 * Valkey rules (doc 16 I2): never index 0; the index must be empty when the stage starts (another run or agent may own
 * it otherwise) and only that index is flushed, at the end. Caveat: Valkey pub/sub channels are server-wide, not per
 * database, so cache-invalidate / live-update messages of the stack under test are also seen by any other stack on the
 * same Valkey server (they name synthetic companies / objects only, so nothing is shown to anyone; QA's db-1 stack had
 * the same property). Use a private valkey-server (`--valkey-url`) for complete isolation.
 *
 * Every process is stopped in `stop()` (SIGTERM, then `taskkill /T /F` on Windows), also from a process `exit` hook.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import Redis from 'ioredis';
import { randomBytes } from 'node:crypto';

export const redact = (s: string): string => s.replace(/((?:postgres(?:ql)?|rediss?):\/\/[^:/@]*):[^@]*@/g, '$1:***@');

/** A free TCP port on 127.0.0.1 (the OS picks it). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** `redis://host:port[/x]` → the same server with database `db`. Refuses index 0. */
export function valkeyUrl(base: string, db: number): string {
  if (!Number.isInteger(db) || db <= 0 || db > 15) throw new Error(`refusing Valkey database index ${db}: use 1-15, never 0`);
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
}

/** Opens the private index; refuses a non-empty one. */
export async function claimValkeyDb(url: string): Promise<void> {
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await r.connect();
    const n = await r.dbsize();
    if (n > 0) throw new Error(`Valkey database ${new URL(url).pathname} holds ${n} keys: not ours, refusing (pick another --valkey-db)`);
  } finally {
    r.disconnect();
  }
}

/** FLUSHDB on that one index only (never FLUSHALL). */
export async function flushValkeyDb(url: string): Promise<void> {
  const db = Number(new URL(url).pathname.replace('/', ''));
  if (!db) throw new Error('refusing to flush Valkey database 0');
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await r.connect();
    await r.flushdb();
  } finally {
    r.disconnect();
  }
}

export interface StackOptions {
  apiDir: string;
  databaseUrl: string;
  redisUrl: string;
  routerUrl: string | null;
  outDir: string;
  processor?: boolean;
  /** Also start dist/notifier/main.js (E5 WP 5.5: pushes / SMS through the fake providers). */
  notifier?: boolean;
  /** Extra environment for every process (applied after the defaults), e.g. PUSH_PROVIDER=fake. */
  extraEnv?: Record<string, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const live = new Set<ChildProcess>();
process.on('exit', () => {
  for (const c of live) killTree(c);
});

function killTree(c: ChildProcess): void {
  if (c.exitCode !== null || !c.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
  else c.kill('SIGKILL');
}

export class Stack {
  apiPort = 0;
  private readonly procs: { name: string; child: ChildProcess }[] = [];

  constructor(private readonly o: StackOptions) {
    if (!/\/[a-z0-9_]+_test(\?|$)/.test(o.databaseUrl) || /\/(veetracer|veetrax_assess)(\?|$)/.test(o.databaseUrl)) throw new Error('the stack runs only on a *_test database');
    if (!Number(new URL(o.redisUrl).pathname.replace('/', ''))) throw new Error('the stack never uses Valkey database 0');
  }

  get api(): string {
    return `http://127.0.0.1:${this.apiPort}/api`;
  }

  private env(extra: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Nothing of the caller's own stack configuration leaks in.
    for (const k of Object.keys(env)) if (/^(DATABASE_URL|REDIS_|API_PORT|GT06_|ROUTER_|GEOCODER|MARTIN_URL|ETMS|CI$|DB_TEST|E3H_)/.test(k)) delete env[k];
    return {
      ...env,
      NODE_ENV: 'test',
      DATABASE_URL: this.o.databaseUrl,
      REDIS_URL: this.o.redisUrl,
      JWT_SECRET: randomBytes(32).toString('hex'),
      MEDIA_PORT: '0',
      ATTACH_PORT: '0',
      MEDIA_HTTP_PORT: '0',
      GEOCODER: 'none',
      SYSTEM_MONITOR: 'off',
      LICENCE_JOB: 'off',
      ETMS_BOOKING_JOB: 'off',
      OTP_DEV_ECHO: 'true',
      MAIL_DEV_ECHO: 'true',
      WEB_URL: 'http://127.0.0.1:9',
      CORS_ORIGINS: 'http://127.0.0.1:9',
      ...(this.o.routerUrl ? { ROUTER_URL: this.o.routerUrl, ROUTER_ENGINE: 'graphhopper' } : {}),
      ...(this.o.extraEnv ?? {}),
      ...extra,
    };
  }

  private spawnNode(name: string, script: string, env: NodeJS.ProcessEnv): ChildProcess {
    const log = createWriteStream(join(this.o.outDir, `${name}.log`));
    const child = spawn(process.execPath, [script], { cwd: this.o.apiDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const sink = (b: Buffer) => log.write(redact(b.toString()));
    child.stdout?.on('data', sink);
    child.stderr?.on('data', sink);
    child.on('exit', () => {
      live.delete(child);
      log.end();
    });
    live.add(child);
    this.procs.push({ name, child });
    return child;
  }

  async start(): Promise<void> {
    this.apiPort = await freePort();
    const api = this.spawnNode('api', 'dist/main.js', this.env({ API_PORT: String(this.apiPort) }));
    let up = false;
    for (let i = 0; i < 120 && api.exitCode === null; i++) {
      const s = await fetch(`${this.api}/health`).then((r) => r.status, () => 0);
      if (s > 0) {
        up = true;
        break;
      }
      await sleep(500);
    }
    if (!up) throw new Error(`API did not come up on :${this.apiPort} (see api.log)`);
    if (this.o.processor !== false) {
      const p = this.spawnNode('processor', 'dist/processor/main.js', this.env({ PROCESSOR_CONSUMER: `e3h-processor-${process.pid}` }));
      await sleep(3_000);
      if (p.exitCode !== null) throw new Error('processor exited at start (see processor.log)');
    }
    if (this.o.notifier) {
      const n = this.spawnNode('notifier', 'dist/notifier/main.js', this.env({ NOTIFIER_CONSUMER: `e5s-notifier-${process.pid}` }));
      await sleep(3_000);
      if (n.exitCode !== null) throw new Error('notifier exited at start (see notifier.log)');
    }
  }

  async stop(): Promise<void> {
    for (const { child } of [...this.procs].reverse()) {
      if (child.exitCode !== null) continue;
      child.kill('SIGTERM');
      for (let i = 0; i < 20 && child.exitCode === null; i++) await sleep(250);
      killTree(child);
    }
  }
}
