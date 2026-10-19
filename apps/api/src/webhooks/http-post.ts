import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { guardedLookup, isPrivateAddress } from './url-guard';

/** Response bytes kept in the delivery log. */
export const RESPONSE_KEEP_BYTES = 2048;
/** Stop reading a response after this many bytes. */
const RESPONSE_READ_LIMIT = 64 * 1024;

export interface PostResult {
  status: number;
  body: string;
  durationMs: number;
}

export interface PostOptions {
  timeoutMs: number;
  allowPrivate: boolean;
}

/**
 * POST a JSON body. Redirects are never followed (a 3xx is returned as-is and counts as a failure), the whole request
 * is bounded by `timeoutMs`, and private addresses are refused unless allowed. Rejects on network errors.
 */
export function postJson(url: string, body: string, headers: Record<string, string>, opts: PostOptions): Promise<PostResult> {
  const started = Date.now();
  return new Promise<PostResult>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      reject(new Error('Invalid URL'));
      return;
    }
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (!opts.allowPrivate && isIP(host) && isPrivateAddress(host)) {
      reject(new Error(`Refused private address ${host}`));
      return;
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      reject(new Error('Unsupported protocol'));
      return;
    }
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      target,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
        lookup: guardedLookup(opts.allowPrivate) as never,
        timeout: opts.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          if (size < RESPONSE_READ_LIMIT) chunks.push(c);
          size += c.length;
          if (size >= RESPONSE_READ_LIMIT) res.destroy();
        });
        const done = () => {
          clearTimeout(timer);
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8').slice(0, RESPONSE_KEEP_BYTES),
            durationMs: Date.now() - started,
          });
        };
        res.on('end', done);
        res.on('close', done);
        res.on('error', done);
      },
    );
    // Overall deadline (the socket `timeout` only covers inactivity).
    const timer = setTimeout(() => req.destroy(new Error(`Timed out after ${opts.timeoutMs / 1000} s`)), opts.timeoutMs);
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${opts.timeoutMs / 1000} s`)));
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end(body);
  });
}
