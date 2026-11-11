import { Logger } from '@nestjs/common';
import { RedisKeys } from '../redis/keys';
import type { RedisService } from '../redis/redis.service';

/**
 * Pub/sub payload on `RedisKeys.sessionsRevoked` (R-14 / D6 G5). Every API instance's `LiveGateway` disconnects the
 * `/live` sockets it matches:
 * - `sessionIds`: exactly those sessions;
 * - `userId`: every session of that user, except `allExcept` when set (sign out other devices).
 */
export interface SessionsRevokedMessage {
  sessionIds?: string[];
  userId?: string;
  allExcept?: string;
  /** Epoch ms of the revocation. */
  at: number;
}

const logger = new Logger('SessionRevocation');

/**
 * Broadcast a revocation. Never throws: a lost message is covered by the gateway's 60 s session re-check.
 */
export async function publishSessionsRevoked(
  redis: Pick<RedisService, 'client'> | undefined,
  message: Omit<SessionsRevokedMessage, 'at'>,
): Promise<void> {
  if (!redis) return;
  if (!message.sessionIds?.length && !message.userId) return;
  try {
    await redis.client.publish(RedisKeys.sessionsRevoked, JSON.stringify({ ...message, at: Date.now() }));
  } catch (error) {
    logger.warn(`Could not publish session revocation: ${(error as Error).message}`);
  }
}

/** Parse a channel message; null when it is not a usable revocation. */
export function parseSessionsRevoked(raw: string): SessionsRevokedMessage | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  const sessionIds = Array.isArray(m.sessionIds) ? m.sessionIds.filter((x): x is string => typeof x === 'string' && x.length > 0) : undefined;
  const userId = typeof m.userId === 'string' && m.userId ? m.userId : undefined;
  const allExcept = typeof m.allExcept === 'string' && m.allExcept ? m.allExcept : undefined;
  if (!sessionIds?.length && !userId) return null;
  return { ...(sessionIds?.length ? { sessionIds } : {}), ...(userId ? { userId } : {}), ...(allExcept ? { allExcept } : {}), at: typeof m.at === 'number' ? m.at : 0 };
}

/** Does the revocation cover a socket opened by `userId` with `sessionId`? */
export function revocationMatches(msg: SessionsRevokedMessage, socket: { userId: string; sessionId: string | null }): boolean {
  if (socket.sessionId && msg.sessionIds?.includes(socket.sessionId)) return true;
  if (msg.userId && msg.userId === socket.userId) return !msg.allExcept || socket.sessionId !== msg.allExcept;
  return false;
}
