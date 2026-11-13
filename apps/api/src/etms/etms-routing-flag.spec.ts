import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import { routingEnvModeOf, routingOffReason, transportSettingsOf } from '@veetracer/shared';
import { PlanningFeatureGuard } from './planning/planning-feature.guard';
import { etmsRoutingEnabled } from './transport-feature.guard';
import { companyAutoRouting, routingOffReasonFor, routingOffReasonNow, RoutingSwitchCache, setPlatformRoutingSnapshot } from '../routing-switch/routing-switch';

/**
 * v1.16 automatic route planning switches (owner decision 2026-11-13). ETMS_ROUTING is only the emergency kill switch:
 * an explicit `off` (or ETMS=off) stops everything; unset / auto / on let the database switches decide (platform switch,
 * default OFF, and the company's own switch, default OFF). So an upgrade with an unset or unchanged .env stays OFF.
 */
describe('ETMS_ROUTING env (v1.16: kill switch only)', () => {
  it.each([
    [{}, true],
    [{ ETMS_ROUTING: '' }, true],
    [{ ETMS_ROUTING: 'auto' }, true],
    [{ ETMS_ROUTING: 'on' }, true],
    [{ ETMS_ROUTING: ' ON ' }, true],
    [{ ETMS_ROUTING: 'off' }, false],
    [{ ETMS_ROUTING: ' OFF ' }, false],
    [{ ETMS_ROUTING: 'on', ETMS: 'off' }, false],
    [{ ETMS: 'off' }, false],
  ] as [NodeJS.ProcessEnv, boolean][])('%j → routing code may run: %s', (env, on) => {
    expect(etmsRoutingEnabled(env)).toBe(on);
    expect(routingEnvModeOf(env)).toBe(on ? 'auto' : 'off');
  });
});

describe('three-switch rule', () => {
  it.each([
    ['off', true, true, 'ENV_OFF'],
    ['off', false, false, 'ENV_OFF'],
    ['auto', false, true, 'PLATFORM_OFF'],
    ['auto', false, false, 'PLATFORM_OFF'],
    ['auto', true, false, 'COMPANY_OFF'],
    ['auto', true, true, null],
  ] as const)('env %s, platform %s, company %s → %s', (envMode, platform, company, reason) => {
    expect(routingOffReason({ envMode, platform, company })).toBe(reason);
  });

  it('the company switch lives in Company.settings.etms.autoRouting and defaults off', () => {
    expect(companyAutoRouting({})).toBe(false);
    expect(companyAutoRouting({ etms: { autoRouting: 'true' } })).toBe(false);
    expect(companyAutoRouting({ etms: { autoRouting: true } })).toBe(true);
    expect(transportSettingsOf({ etms: { autoRouting: false } })).not.toHaveProperty('autoRouting');
  });
});

describe('PlanningFeatureGuard (sync: env + platform snapshot + AuthContext.autoRouting)', () => {
  const exec = (auth: object | undefined) => ({ getType: () => 'http', switchToHttp: () => ({ getRequest: () => ({ auth }) }) }) as unknown as ExecutionContext;
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    setPlatformRoutingSnapshot(false);
  });

  it('platform snapshot starts OFF: hidden even with the company on and the env unset', () => {
    delete process.env.ETMS_ROUTING;
    expect(PlanningFeatureGuard.hiddenFor({ autoRouting: true })).toBe(true);
  });

  it('all on → open; company off → 404; env off → 404 whatever the switches say', () => {
    delete process.env.ETMS_ROUTING;
    setPlatformRoutingSnapshot(true);
    expect(new PlanningFeatureGuard().canActivate(exec({ autoRouting: true }))).toBe(true);
    expect(() => new PlanningFeatureGuard().canActivate(exec({ autoRouting: false }))).toThrow(NotFoundException);
    expect(() => new PlanningFeatureGuard().canActivate(exec(undefined))).toThrow(NotFoundException);
    process.env.ETMS_ROUTING = 'off';
    expect(routingOffReasonNow(true)).toBe('ENV_OFF');
    expect(() => new PlanningFeatureGuard().canActivate(exec({ autoRouting: true }))).toThrow(NotFoundException);
  });
});

describe('RoutingSwitchCache (worker idle loop / API refresh)', () => {
  afterEach(() => setPlatformRoutingSnapshot(false));

  it('reads at most once per TTL, keeps the last value on a read error, publishes the snapshot', async () => {
    let t = 0;
    let value = false;
    let fail = false;
    const read = jest.fn(async () => {
      if (fail) throw new Error('db down');
      return value;
    });
    const cache = new RoutingSwitchCache(read, 5_000, () => t);
    expect(await cache.platformOn()).toBe(false);
    value = true;
    t = 4_000;
    expect(await cache.platformOn()).toBe(false); // cached
    expect(read).toHaveBeenCalledTimes(1);
    t = 5_000;
    expect(await cache.platformOn()).toBe(true);
    expect(routingOffReasonNow(true, {})).toBeNull(); // snapshot published
    fail = true;
    t = 20_000;
    expect(await cache.platformOn()).toBe(true); // last known value
    cache.store(false);
    expect(routingOffReasonNow(true, {})).toBe('PLATFORM_OFF');
  });

  it('routingOffReasonFor: env first (no read), then platform, then the company row', async () => {
    const company = { findUnique: jest.fn(async () => ({ settings: { etms: { autoRouting: true } } as unknown })) };
    const off = { platformOn: jest.fn(async () => false) };
    const on = { platformOn: jest.fn(async () => true) };
    expect(await routingOffReasonFor({ company } as never, on, 'c1', { ETMS_ROUTING: 'off' })).toBe('ENV_OFF');
    expect(on.platformOn).not.toHaveBeenCalled();
    expect(await routingOffReasonFor({ company } as never, off, 'c1', {})).toBe('PLATFORM_OFF');
    expect(company.findUnique).not.toHaveBeenCalled();
    expect(await routingOffReasonFor({ company } as never, on, 'c1', {})).toBeNull();
    company.findUnique.mockResolvedValueOnce({ settings: {} });
    expect(await routingOffReasonFor({ company } as never, on, 'c1', {})).toBe('COMPANY_OFF');
  });
});
