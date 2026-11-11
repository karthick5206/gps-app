/**
 * `--http` stage of the ETMS E3 gate: builds `dist/` (unless --no-build), starts the GraphHopper stub, the real API and
 * processor (stack.ts) against the scratch database and a private Valkey index, seeds synthetic accounts, runs the HTTP
 * checks (http-checks.ts) and the bot cycle with sim-trip (bots.ts), then stops every process and flushes that index —
 * also when something fails. Returns the checks in the gate's result shape (criteria HTTP, AC3b, BOT).
 */
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GraphHopperStub } from '../../src/etms/testing/graphhopper-stub';
import { runBotCycle } from './bots';
import { Api, Recorder, type CheckResult } from './http-client';
import { runHttpChecks } from './http-checks';
import { seedHttpAccounts } from './http-seed';
import { claimValkeyDb, flushValkeyDb, redact, Stack, valkeyUrl } from './stack';

export interface HttpStageOptions {
  apiDir: string;
  databaseUrl: string;
  outDir: string;
  build: boolean;
  valkeyBase: string;
  valkeyDb: number;
  secfix: boolean;
  known: boolean;
  tag: string;
}

function build(apiDir: string, outDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cli = join(dirname(require.resolve('@nestjs/cli/package.json', { paths: [apiDir] })), 'bin', 'nest.js');
    const child = spawn(process.execPath, [cli, 'build'], { cwd: apiDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    child.stderr.on('data', (b: Buffer) => (out += b.toString()));
    child.on('close', (code) => {
      writeFileSync(join(outDir, 'build.log'), redact(out));
      if (code === 0) resolve();
      else reject(new Error('nest build failed (see build.log)'));
    });
  });
}

export async function runHttpStage(o: HttpStageOptions): Promise<CheckResult[]> {
  const rec = new Recorder({ secfix: o.secfix, known: o.known });
  const redisUrl = valkeyUrl(o.valkeyBase, o.valkeyDb);
  await claimValkeyDb(redisUrl);
  if (o.build) {
    console.log('  nest build …');
    await build(o.apiDir, o.outDir);
  }
  const stub = new GraphHopperStub();
  const routerUrl = await stub.start(0);
  const stack = new Stack({ apiDir: o.apiDir, databaseUrl: o.databaseUrl, redisUrl, routerUrl, outDir: o.outDir });
  const prisma = new PrismaClient({ datasourceUrl: o.databaseUrl });
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
  try {
    const acc = await seedHttpAccounts(prisma, `${o.tag}-http`);
    await stack.start();
    console.log(`  stack up: API :${stack.apiPort}, processor, Valkey db ${o.valkeyDb}, GraphHopper stub ${routerUrl}`);
    const api = new Api(stack.api);
    await rec.step('HTTP', 'HTTP checks', () => runHttpChecks(api, acc, rec));
    await rec.step('BOT', 'bot cycle with sim-trip', () => runBotCycle(api, acc, prisma, redis, rec));
  } catch (e) {
    rec.check('HTTP', 'HTTP stage set-up (seed / stack start)', false, (e as Error).message);
  } finally {
    await stack.stop();
    await stub.stop();
    redis.disconnect();
    await prisma.$disconnect();
    await flushValkeyDb(redisUrl).catch((e: Error) => console.error(`  Valkey flush failed: ${e.message}`));
    console.log(`  stack stopped; Valkey db ${o.valkeyDb} flushed`);
  }
  return rec.results;
}
