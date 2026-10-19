import { createHmac, timingSafeEqual } from 'node:crypto';

/** Stream URLs are opened by video players that cannot send an Authorization header: a short-lived signed token. */
export const VIDEO_TOKEN_TTL_SEC = 180;

export interface VideoTokenClaims {
  /** User id. */
  u: string;
  /** Company id. */
  c: string;
  /** Video session id. */
  s: string;
  /** Expiry, seconds since epoch. */
  exp: number;
}

const key = (secret: string) => createHmac('sha256', secret).update('veetrax:video-token:v1').digest();
const sign = (payload: string, secret: string) => createHmac('sha256', key(secret)).update(payload).digest('base64url');

export function signVideoToken(claims: Omit<VideoTokenClaims, 'exp'>, secret: string, now = Date.now(), ttlSec = VIDEO_TOKEN_TTL_SEC): { token: string; expiresAt: Date } {
  const exp = Math.floor(now / 1000) + ttlSec;
  const payload = Buffer.from(JSON.stringify({ ...claims, exp })).toString('base64url');
  return { token: `${payload}.${sign(payload, secret)}`, expiresAt: new Date(exp * 1000) };
}

/** Claims of a valid, unexpired token for `sessionId`; null otherwise. */
export function verifyVideoToken(token: string, sessionId: string, secret: string, now = Date.now()): VideoTokenClaims | null {
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let claims: VideoTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as VideoTokenClaims;
  } catch {
    return null;
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;
  if (claims.s !== sessionId || typeof claims.u !== 'string' || typeof claims.c !== 'string') return null;
  return claims;
}
