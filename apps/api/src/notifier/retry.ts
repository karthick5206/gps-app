export const SEND_ATTEMPTS = 3;
export const BACKOFF_MS = [1000, 3000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry a send up to `attempts` times with backoff; returns the last error message (null on success). */
export async function withRetries(
  send: () => Promise<unknown>,
  attempts = SEND_ATTEMPTS,
  backoff: number[] = BACKOFF_MS,
): Promise<{ error: string | null; attempts: number }> {
  let error: string | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      await send();
      return { error: null, attempts: i + 1 };
    } catch (e) {
      error = (e as Error).message || String(e);
      if (i < attempts - 1) await sleep(backoff[Math.min(i, backoff.length - 1)]);
    }
  }
  return { error, attempts };
}
