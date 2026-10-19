import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../access/auth.guard';
import { AuthContextService } from '../access/auth-context.service';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { generateApiKey } from './api-key-crypto';
import { ApiKeyGuard, RateLimitedException } from './api-key.guard';
import { ApiKeysService } from './api-keys.service';

const key = generateApiKey();
const row = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-1111-1111-111111111111',
  companyId: '22222222-2222-2222-2222-222222222222',
  branchId: null,
  name: 'ERP',
  prefix: key.prefix,
  keyHash: key.hash,
  scopes: ['read:vehicles'],
  ipAllowList: [],
  ratePerMinute: 2,
  ratePerDay: 100,
  expiresAt: null,
  revokedAt: null,
  createdById: '33333333-3333-3333-3333-333333333333',
  company: { status: 'ACTIVE' },
  ...over,
});

function setup(over: Record<string, unknown> = {}, scope: string | null = 'read:vehicles') {
  const prisma = {
    apiKey: {
      findUnique: jest.fn(async ({ where }: { where: { keyHash: string } }) => (where.keyHash === key.hash ? row(over) : null)),
      update: jest.fn(async () => ({})),
    },
  };
  const counts = new Map<string, number>();
  const redis = {
    client: {
      eval: jest.fn(async (_s: string, _n: number, m: string, d: string) => {
        counts.set(m, (counts.get(m) ?? 0) + 1);
        counts.set(d, (counts.get(d) ?? 0) + 1);
        return [counts.get(m), counts.get(d)];
      }),
    },
  };
  const keys = new ApiKeysService(prisma as unknown as PrismaService, {} as AuditService);
  const reflector = { getAllAndOverride: jest.fn(() => scope ?? undefined) } as unknown as Reflector;
  const guard = new ApiKeyGuard(reflector, keys, redis as unknown as RedisService);
  return { guard, keys, prisma };
}

function http(authorization?: string, ip = '203.0.113.9') {
  const headers: Record<string, string> = {};
  const req: Record<string, unknown> = { headers: authorization ? { authorization } : {}, ip };
  const res = { setHeader: (k: string, v: string) => (headers[k] = v) };
  const ctx = {
    getType: () => 'http',
    getHandler: () => null,
    getClass: () => null,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { ctx, req, headers };
}

describe('ApiKeyGuard (public API v1)', () => {
  afterEach(() => jest.clearAllMocks());

  it('accepts a valid key with the scope and builds a company-wide key context', async () => {
    const { guard, keys } = setup();
    const h = http(`Bearer ${key.secret}`);
    await expect(guard.canActivate(h.ctx)).resolves.toBe(true);
    const auth = h.req.auth as { companyId: string; dataScope: string; apiKey: { scopes: string[] }; permissions: object };
    expect(auth.companyId).toBe(row().companyId);
    expect(auth.dataScope).toBe('COMPANY');
    expect(auth.permissions).toEqual({});
    expect(auth.apiKey.scopes).toEqual(['read:vehicles']);
    expect(h.headers['X-RateLimit-Limit']).toBe('2');
    await keys.onModuleDestroy();
  });

  it('refuses user JWTs on v1', async () => {
    const { guard } = setup();
    await expect(guard.canActivate(http('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig').ctx)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(http().ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('refuses unknown, revoked and expired keys', async () => {
    await expect(setup().guard.canActivate(http(`Bearer ${generateApiKey().secret}`).ctx)).rejects.toThrow('Invalid API key');
    await expect(setup({ revokedAt: new Date() }).guard.canActivate(http(`Bearer ${key.secret}`).ctx)).rejects.toThrow('revoked');
    await expect(setup({ expiresAt: new Date(Date.now() - 1000) }).guard.canActivate(http(`Bearer ${key.secret}`).ctx)).rejects.toThrow('expired');
  });

  it('enforces scopes (fail closed when a route has none)', async () => {
    await expect(setup({}, 'read:positions').guard.canActivate(http(`Bearer ${key.secret}`).ctx)).rejects.toThrow(ForbiddenException);
    await expect(setup({}, null).guard.canActivate(http(`Bearer ${key.secret}`).ctx)).rejects.toThrow(ForbiddenException);
  });

  it('enforces the IP allow-list and branch scope', async () => {
    await expect(setup({ ipAllowList: ['10.0.0.0/8'] }).guard.canActivate(http(`Bearer ${key.secret}`).ctx)).rejects.toThrow(ForbiddenException);
    const h = http(`Bearer ${key.secret}`, '::ffff:10.1.2.3');
    await setup({ ipAllowList: ['10.0.0.0/8'], branchId: 'b1' }).guard.canActivate(h.ctx);
    expect(h.req.auth).toMatchObject({ dataScope: 'ASSIGNED', branchIds: ['b1'] });
  });

  it('returns 429 with Retry-After once the per-minute limit is used up', async () => {
    const { guard } = setup();
    await guard.canActivate(http(`Bearer ${key.secret}`).ctx);
    await guard.canActivate(http(`Bearer ${key.secret}`).ctx);
    const h = http(`Bearer ${key.secret}`);
    const err = await guard.canActivate(h.ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedException);
    expect((err as RateLimitedException).getStatus()).toBe(429);
    expect(Number(h.headers['Retry-After'])).toBeGreaterThan(0);
  });
});

describe('JwtAuthGuard (app API)', () => {
  it('refuses API keys on normal app routes', async () => {
    const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
    const contexts = { fromToken: jest.fn() } as unknown as AuthContextService;
    const guard = new JwtAuthGuard(reflector, contexts);
    await expect(guard.canActivate(http(`Bearer ${key.secret}`).ctx)).rejects.toThrow('API keys can only be used');
    expect(contexts.fromToken).not.toHaveBeenCalled();
  });
});
