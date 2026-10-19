/** Rejects with `<label> timed out after <ms> ms` when the promise doesn't settle in time. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    timer.unref();
  });
  // A late rejection of the original promise must not become an unhandled rejection.
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** XINFO-style flat reply `[k1, v1, k2, v2, …]` → object. */
export function pairs(reply: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(reply)) return out;
  for (let i = 0; i + 1 < reply.length; i += 2) out[String(reply[i])] = reply[i + 1];
  return out;
}

/** INFO text → key/value map. */
export function parseInfo(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

export const toNumber = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Milliseconds part of a stream entry id (`1792379623201-0`). */
export const streamIdTime = (id: string): number | null => toNumber(id.split('-')[0]);

/** Short one-line error message (Prisma errors span many lines). */
export function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = message.split('\n').map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? 'error').slice(0, 300);
}
