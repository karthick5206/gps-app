/** Injectable `fetch` for engine-neutral HTTP clients (moved out of the branch's Valhalla adapter, doc 17 §4.1 E-11). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const defaultFetch: FetchLike = (url, init) => fetch(url, init);

/** Largest answer the routing clients read from the optimiser or GraphHopper (E4 gates security L2). */
export const MAX_ENGINE_RESPONSE_BYTES = 16 * 1024 * 1024;

export class ResponseTooLarge extends Error {
  constructor(readonly limit: number) {
    super(`response larger than ${limit} bytes`);
    this.name = 'ResponseTooLarge';
  }
}

/**
 * Reads a JSON body with a byte cap (E4 gates security L2): a declared Content-Length over the cap is refused before
 * reading, and a streamed body is cut off (and the stream cancelled) once it passes the cap, so a misbehaving local
 * service cannot make a worker hold an unbounded answer in memory. Throws ResponseTooLarge, or SyntaxError for non-JSON.
 */
export async function readJsonCapped(res: Response, limit = MAX_ENGINE_RESPONSE_BYTES): Promise<unknown> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => undefined);
    throw new ResponseTooLarge(limit);
  }
  if (!res.body) return JSON.parse(await res.text());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLarge(limit);
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
