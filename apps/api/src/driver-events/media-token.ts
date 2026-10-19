import { createHmac, timingSafeEqual } from 'node:crypto';

/** <img> / <video> tags cannot send an Authorization header: media URLs carry a short-lived signed token. */
export const MEDIA_TOKEN_TTL_SEC = 30 * 60;

export interface MediaTokenClaims {
  /** User id. */
  u: string;
  /** Company id. */
  c: string;
  /** DriverEventMedia id. */
  m: string;
  exp: number;
}

const key = (secret: string) => createHmac('sha256', secret).update('veetrax:driver-media-token:v1').digest();
const sign = (payload: string, secret: string) => createHmac('sha256', key(secret)).update(payload).digest('base64url');

export function signMediaToken(claims: Omit<MediaTokenClaims, 'exp'>, secret: string, now = Date.now(), ttlSec = MEDIA_TOKEN_TTL_SEC): string {
  // Round the expiry so a list rendered twice within a few minutes yields the same URLs (browser cache hits).
  const exp = Math.ceil((Math.floor(now / 1000) + ttlSec) / 300) * 300;
  const payload = Buffer.from(JSON.stringify({ ...claims, exp })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** Claims of a valid, unexpired token for `mediaId`; null otherwise. */
export function verifyMediaToken(token: string, mediaId: string, secret: string, now = Date.now()): MediaTokenClaims | null {
  const [payload, sig, extra] = (token ?? '').split('.');
  if (!payload || !sig || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let claims: MediaTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as MediaTokenClaims;
  } catch {
    return null;
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;
  if (claims.m !== mediaId || typeof claims.u !== 'string' || typeof claims.c !== 'string') return null;
  return claims;
}

export const mediaUrl = (mediaId: string, token: string) => `/api/driver-events/media/${mediaId}?token=${encodeURIComponent(token)}`;
