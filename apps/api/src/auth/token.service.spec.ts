import { RedisKeys } from '../redis/keys';
import { parseSessionsRevoked, publishSessionsRevoked, revocationMatches } from './session-revocation';
import { TokenService } from './token.service';
import { sha256 } from '../common/secrets';

const USER = '11111111-1111-4111-8111-111111111111';
const S1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const S2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function setup(count = 1) {
  const prisma = {
    session: {
      findUnique: jest.fn(async () => ({ id: S1, userId: USER, revokedAt: null, refreshTokenHash: sha256('rt') })),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count })),
    },
  };
  const publish = jest.fn(async () => 1);
  const redis = { client: { publish } };
  const tokens = new TokenService(prisma as never, {} as never, {} as never, redis as never);
  const sent = () => publish.mock.calls.map((c) => {
    const [channel, body] = c as unknown as [string, string];
    expect(channel).toBe(RedisKeys.sessionsRevoked);
    return JSON.parse(body) as Record<string, unknown>;
  });
  return { prisma, publish, tokens, sent };
}

describe('TokenService publishes every revocation (R-14)', () => {
  it('channel name follows the vt: convention', () => {
    expect(RedisKeys.sessionsRevoked).toBe('vt:sessions:revoked');
  });

  it('revoke (logout) publishes the session id', async () => {
    const { tokens, sent } = setup();
    await expect(tokens.revoke('rt')).resolves.toBe(USER);
    expect(sent()).toEqual([expect.objectContaining({ sessionIds: [S1], at: expect.any(Number) })]);
  });

  it('revoke of an unknown or already revoked token publishes nothing', async () => {
    const { tokens, prisma, publish } = setup();
    prisma.session.findUnique.mockResolvedValueOnce(null as never);
    await expect(tokens.revoke('nope')).resolves.toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });

  it('revokeOwn publishes that session only when one was revoked', async () => {
    const { tokens, sent } = setup();
    await expect(tokens.revokeOwn(USER, S2)).resolves.toBe(true);
    expect(sent()).toEqual([expect.objectContaining({ sessionIds: [S2] })]);
    const none = setup(0);
    await expect(none.tokens.revokeOwn(USER, S2)).resolves.toBe(false);
    expect(none.publish).not.toHaveBeenCalled();
  });

  it('revokeOthers publishes userId + allExcept (current session kept)', async () => {
    const { tokens, sent } = setup(2);
    await expect(tokens.revokeOthers(USER, S1)).resolves.toBe(2);
    expect(sent()).toEqual([expect.objectContaining({ userId: USER, allExcept: S1 })]);
  });

  it('revokeOthers without a current session covers every session', async () => {
    const { tokens, sent } = setup(2);
    await tokens.revokeOthers(USER, null);
    const [msg] = sent();
    expect(msg).toMatchObject({ userId: USER });
    expect(msg).not.toHaveProperty('allExcept');
  });

  it('revokeAll (password reset) publishes the user id', async () => {
    const { tokens, sent } = setup(3);
    await tokens.revokeAll(USER);
    expect(sent()).toEqual([expect.objectContaining({ userId: USER })]);
  });

  it('a Valkey failure is logged, never thrown (the 60 s re-check is the fallback)', async () => {
    const { tokens, publish } = setup();
    publish.mockRejectedValueOnce(new Error('ECONNREFUSED') as never);
    await expect(tokens.revoke('rt')).resolves.toBe(USER);
  });
});

describe('session revocation message', () => {
  it('publishSessionsRevoked skips empty messages', async () => {
    const publish = jest.fn();
    await publishSessionsRevoked({ client: { publish } } as never, {});
    await publishSessionsRevoked({ client: { publish } } as never, { sessionIds: [] });
    expect(publish).not.toHaveBeenCalled();
  });

  it('parse rejects junk and keeps only string ids', () => {
    expect(parseSessionsRevoked('not json')).toBeNull();
    expect(parseSessionsRevoked('{}')).toBeNull();
    expect(parseSessionsRevoked(JSON.stringify({ sessionIds: [1, null] }))).toBeNull();
    expect(parseSessionsRevoked(JSON.stringify({ sessionIds: [S1, 7], at: 5 }))).toEqual({ sessionIds: [S1], at: 5 });
    expect(parseSessionsRevoked(JSON.stringify({ userId: USER, allExcept: S1 }))).toEqual({ userId: USER, allExcept: S1, at: 0 });
  });

  it('matches by session id, by user, and honours allExcept', () => {
    const at = 0;
    expect(revocationMatches({ sessionIds: [S1], at }, { userId: USER, sessionId: S1 })).toBe(true);
    expect(revocationMatches({ sessionIds: [S1], at }, { userId: USER, sessionId: S2 })).toBe(false);
    expect(revocationMatches({ sessionIds: [S1], at }, { userId: USER, sessionId: null })).toBe(false);
    expect(revocationMatches({ userId: USER, at }, { userId: USER, sessionId: S2 })).toBe(true);
    expect(revocationMatches({ userId: USER, at }, { userId: 'other', sessionId: S2 })).toBe(false);
    expect(revocationMatches({ userId: USER, allExcept: S1, at }, { userId: USER, sessionId: S1 })).toBe(false);
    expect(revocationMatches({ userId: USER, allExcept: S1, at }, { userId: USER, sessionId: S2 })).toBe(true);
    // A legacy socket without a session id is not the kept session.
    expect(revocationMatches({ userId: USER, allExcept: S1, at }, { userId: USER, sessionId: null })).toBe(true);
  });
});
