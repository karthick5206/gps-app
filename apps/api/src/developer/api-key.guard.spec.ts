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
import { ApiAccessService } from '../licences/api-access.service';

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

function setup(over: Record<string, unknown> = {}, scope: string | null = 'read:vehicles', access?: ApiAccessService) {
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
  const guard = new ApiKeyGuard(reflector, keys, redis as unknown as RedisService, access);
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

const DAY = 86_400_000;

/** Real ApiAccessService over fakes: the company's API seats, platform flag, plans and the Valkey quota counter. */
function access(seats: { expiresAt: Date; apiPlan: string }[], opts: { exempt?: boolean; apiPlans?: unknown } = {}) {
  const counters = new Map<string, number>();
  const prisma = { licenceSeat: { findMany: jest.fn(async () => seats.map((s, i) => ({ id: `s${i}`, activatedAt: new Date(), source: 'PURCHASE', ...s }))) } };
  const settings = { get: jest.fn(async () => ({ apiPlans: opts.apiPlans ?? {}, graceDays: 15 })) };
  const policy = { isExempt: jest.fn(async () => !!opts.exempt) };
  const redis = {
    client: {
      incr: jest.fn(async (k: string) => counters.set(k, (counters.get(k) ?? 0) + 1).get(k)),
      expire: jest.fn(async () => 1),
      get: jest.fn(async (k: string) => (counters.has(k) ? String(counters.get(k)) : null)),
    },
  };
  return new ApiAccessService(prisma as never, settings as never, policy as never, redis as never);
}

describe('ApiKeyGuard: Developer API licence', () => {
  const bearer = `Bearer ${key.secret}`;

  it('refuses keys without an API licence, and after the grace period with 402 LICENCE_EXPIRED', async () => {
    const none = await setup({}, 'read:vehicles', access([])).guard.canActivate(http(bearer).ctx).catch((e: unknown) => e);
    expect(none).toMatchObject({ status: 402, code: 'LICENCE_REQUIRED' });
    const expired = access([{ expiresAt: new Date(Date.now() - 16 * DAY), apiPlan: 'BASIC' }]);
    const err = await setup({}, 'read:vehicles', expired).guard.canActivate(http(bearer).ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 402, code: 'LICENCE_EXPIRED' });
    expect((err as { getResponse: () => unknown }).getResponse()).toMatchObject({ code: 'LICENCE_EXPIRED', message: expect.stringContaining('Developer API licence expired') });
  });

  it('keeps working during the grace period and for platform companies', async () => {
    const grace = access([{ expiresAt: new Date(Date.now() - 3 * DAY), apiPlan: 'BASIC' }]);
    await expect(setup({}, 'read:vehicles', grace).guard.canActivate(http(bearer).ctx)).resolves.toBe(true);
    await expect(setup({}, 'read:vehicles', access([], { exempt: true })).guard.canActivate(http(bearer).ctx)).resolves.toBe(true);
  });

  it('caps a key at the plan rate (minimum of key and plan)', async () => {
    const plans = { BASIC: { ratePerMinute: 1 } };
    const svc = access([{ expiresAt: new Date(Date.now() + 100 * DAY), apiPlan: 'BASIC' }], { apiPlans: plans });
    const { guard } = setup({ ratePerMinute: 50 }, 'read:vehicles', svc);
    const h = http(bearer);
    await guard.canActivate(h.ctx);
    expect(h.headers['X-RateLimit-Limit']).toBe('1');
    await expect(guard.canActivate(http(bearer).ctx)).rejects.toBeInstanceOf(RateLimitedException);
  });

  it('enforces the company-wide daily quota of the plan across keys', async () => {
    const plans = { STANDARD: { ratePerDay: 2 } };
    const svc = access([{ expiresAt: new Date(Date.now() + 100 * DAY), apiPlan: 'STANDARD' }], { apiPlans: plans });
    // Two keys of the same company: each is capped at the plan's 2/day, and together they share the company's 2/day.
    const a = setup({ ratePerMinute: 100, ratePerDay: 100 }, 'read:vehicles', svc).guard;
    const b = setup({ id: '44444444-4444-4444-4444-444444444444', ratePerMinute: 100, ratePerDay: 100 }, 'read:vehicles', svc).guard;
    const first = http(bearer);
    await a.canActivate(first.ctx);
    expect(first.headers['X-Quota-Limit-Day']).toBe('2');
    await a.canActivate(http(bearer).ctx);
    const h = http(bearer);
    const err = await b.canActivate(h.ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedException);
    expect((err as Error).message).toContain('Daily request limit');
    expect(await svc.requestsToday(row().companyId)).toBe(3);
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
