/**
 * Copies VeeTrax state keys from one cache to another (Memurai → Valkey cut-over), keeping TTLs.
 * See docs/reliability/production-rollout.md §4. Streams are NOT copied: the cut-over drains them instead.
 *
 *   npx tsx scripts/cache-copy.ts --from redis://127.0.0.1:6379 --to redis://:password@10.0.0.5:6379 [--dry-run]
 *
 * Copied: live / track state, rules / fuel / IO detector state, offline command queues and command states, forwarding
 * rules, webhook company set, cached Super Admin e-mail. A key that already exists on the target is left alone (the
 * target's copy is newer). Strings, sets, lists, hashes and sorted sets; anything else is reported and skipped.
 */
import Redis from 'ioredis';

const PATTERNS = ['vt:live:*', 'vt:track:*', 'vt:alertstate:*', 'vt:fuel:*', 'vt:io:*', 'vt:cmd:queue:*', 'vt:cmd:state:*', 'vt:relay:rules', 'vt:wh:companies', 'vt:health:sa-email'];

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const from = arg('from');
  const to = arg('to');
  const dry = process.argv.includes('--dry-run');
  if (!from || !to) throw new Error('usage: --from <redis url> --to <redis url> [--dry-run]');
  const src = new Redis(from, { maxRetriesPerRequest: 2 });
  const dst = new Redis(to, { maxRetriesPerRequest: 2 });
  const counts = { copied: 0, existing: 0, skipped: 0, expired: 0 };
  try {
    for (const pattern of PATTERNS) {
      let cursor = '0';
      do {
        const [next, keys] = await src.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = next;
        for (const key of keys) {
          const [type, ttl] = await Promise.all([src.type(key), src.pttl(key)]);
          if (ttl === -2) {
            counts.expired++;
            continue;
          }
          if (await dst.exists(key)) {
            counts.existing++;
            continue;
          }
          if (dry) {
            counts.copied++;
            continue;
          }
          const m = dst.multi();
          if (type === 'string') m.set(key, (await src.getBuffer(key)) ?? '');
          else if (type === 'set') m.sadd(key, ...(await src.smembers(key)));
          else if (type === 'list') m.rpush(key, ...(await src.lrange(key, 0, -1)));
          else if (type === 'hash') m.hset(key, await src.hgetall(key));
          else if (type === 'zset') {
            const flat = await src.zrange(key, 0, -1, 'WITHSCORES');
            const args: (string | number)[] = [];
            for (let i = 0; i < flat.length; i += 2) args.push(Number(flat[i + 1]), flat[i]);
            if (args.length) m.zadd(key, ...args);
          } else {
            console.warn(`skip ${key}: type ${type}`);
            counts.skipped++;
            continue;
          }
          if (ttl > 0) m.pexpire(key, ttl);
          await m.exec();
          counts.copied++;
        }
      } while (cursor !== '0');
    }
    console.log(`${dry ? 'DRY RUN: would copy' : 'copied'} ${counts.copied} key(s); ${counts.existing} already on the target; ${counts.skipped} skipped; ${counts.expired} expired meanwhile`);
  } finally {
    src.disconnect();
    dst.disconnect();
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
