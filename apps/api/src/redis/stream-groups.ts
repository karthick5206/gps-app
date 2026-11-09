import type Redis from 'ioredis';

/**
 * The consumer group (or the whole stream) is gone: the cache restarted without its data (no persistence, or a
 * different instance after a cut-over). XREADGROUP / XAUTOCLAIM / XACK then fail with NOGROUP forever unless the
 * group is created again.
 */
export function isNoGroupError(error: unknown): boolean {
  return error instanceof Error && /\bNOGROUP\b/.test(error.message);
}

/** XGROUP CREATE … MKSTREAM, ignoring "already exists". Resolves true when it created the group. */
export async function ensureStreamGroup(client: Redis, stream: string, group: string, startId: '0' | '$' = '0'): Promise<boolean> {
  try {
    await client.xgroup('CREATE', stream, group, startId, 'MKSTREAM');
    return true;
  } catch (error) {
    if ((error as Error).message.includes('BUSYGROUP')) return false;
    throw error;
  }
}
