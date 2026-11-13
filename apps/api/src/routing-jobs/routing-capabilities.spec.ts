import type { AuthContext } from '../access/auth-context';
import { RoutingCapabilitiesService } from './routing-capabilities.controller';
import { setPlatformRoutingSnapshot } from '../routing-switch/routing-switch';

const ctx = { companyId: 'c1', autoRouting: true, dataScope: 'COMPANY', permissions: { etms_planning: ['view', 'create', 'command'], etms_dispatch: ['view'] } } as unknown as AuthContext;

function service(over: { reachable?: boolean; optimizer?: boolean; keys?: string[] } = {}) {
  const provider = {
    health: jest.fn(async () => (over.reachable === false ? { reachable: false, checkedAt: '', degraded: 'ENGINE_UNREACHABLE', message: 'GraphHopper http://127.0.0.1:8989 down' } : { reachable: true, checkedAt: '', latencyMs: 3 })),
    capabilities: jest.fn(async () => ({ ok: true, value: { engineVersion: '11.1', graphVersion: 'gh-11.1/2026-11-08' }, eta: {}, attribution: '' })),
  };
  const optimizer = { health: jest.fn(async () => over.optimizer ?? true) };
  const keys = over.keys ?? ['vt:health:proc:routing-worker:host-1', 'vt:health:proc:notifier:host-1'];
  const redis = { client: { zrangebyscore: jest.fn(async () => keys), exists: jest.fn(async () => 1) } };
  // Branch table (T2-D5): the capabilities list the caller's own branches only.
  const branches = [
    { id: 'b-n', companyId: 'c1', name: 'North' },
    { id: 'b-s', companyId: 'c1', name: 'South' },
    { id: 'b-x', companyId: 'c2', name: 'Other company' },
  ];
  const prisma = {
    branch: {
      findMany: jest.fn(async ({ where }: { where: { companyId: string; id: { in: string[] } } }) =>
        branches
          .filter((b) => b.companyId === where.companyId && where.id.in.includes(b.id))
          .map(({ id, name }) => ({ id, name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ),
    },
  };
  return { svc: new RoutingCapabilitiesService(provider as never, optimizer as never, redis as never, prisma as never), provider, optimizer, prisma };
}

describe('GET /api/routing/capabilities', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    setPlatformRoutingSnapshot(false);
  });

  it('off (v1.16 default: platform switch off): enabled false, offReason PLATFORM_OFF, nothing probed, access still reported', async () => {
    delete process.env.ETMS_ROUTING;
    const { svc, provider, optimizer } = service();
    const r = await svc.get(ctx);
    expect(r).toMatchObject({ enabled: false, offReason: 'PLATFORM_OFF', engine: null, engineReachable: false, engineDegraded: 'ENGINE_DISABLED', optimizer: false, workers: 0, liveTraffic: false });
    expect(r.access).toMatchObject({ enabled: false, canView: true, canPlan: true, canPublish: false, scope: 'COMPANY' });
    expect(provider.health).not.toHaveBeenCalled();
    expect(optimizer.health).not.toHaveBeenCalled();
  });

  it('v1.16: env kill switch → ENV_OFF; company switch off → COMPANY_OFF (platform numbers still shown)', async () => {
    setPlatformRoutingSnapshot(true);
    process.env.ETMS_ROUTING = 'off';
    expect(await service().svc.get(ctx)).toMatchObject({ enabled: false, offReason: 'ENV_OFF' });
    delete process.env.ETMS_ROUTING;
    const r = await service().svc.get({ ...ctx, autoRouting: false } as AuthContext);
    expect(r).toMatchObject({ enabled: false, offReason: 'COMPANY_OFF', engine: 'graphhopper', workers: 1 });
    expect(r.access.enabled).toBe(false);
  });

  it('on: engine, optimiser, live workers, matrix limits; uncalibrated ETA bands; never a host or URL', async () => {
    setPlatformRoutingSnapshot(true);
    const { svc } = service({ reachable: false, optimizer: false });
    const r = await svc.get(ctx);
    expect(r).toMatchObject({ enabled: true, offReason: null, engine: 'graphhopper', engineReachable: false, engineDegraded: 'ENGINE_UNREACHABLE', engineVersion: '11.1', optimizer: false, workers: 1 });
    expect(r.matrix.maxPoints).toBeGreaterThan(0);
    expect(Object.values(r.etaBands).every((b) => b === 'uncalibrated')).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/http|127\.0\.0\.1|8989|8090/);
  });

  it('probes are cached for 10 s', async () => {
    setPlatformRoutingSnapshot(true);
    const { svc, provider } = service();
    await svc.get(ctx, 1_000);
    await svc.get(ctx, 5_000);
    expect(provider.health).toHaveBeenCalledTimes(1);
    await svc.get(ctx, 20_000);
    expect(provider.health).toHaveBeenCalledTimes(2);
  });

  it('T2-D5: a branch-scoped caller gets their own branches (ids and names), never another company’s; whole-company callers none', async () => {
    delete process.env.ETMS_ROUTING;
    const { svc, prisma } = service();
    const assigned = { ...ctx, dataScope: 'ASSIGNED', branchIds: ['b-s', 'b-n', 'b-x'] } as unknown as AuthContext;
    expect((await svc.get(assigned)).access.branches).toEqual([
      { id: 'b-n', name: 'North' },
      { id: 'b-s', name: 'South' },
    ]);
    expect(prisma.branch.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { companyId: 'c1', id: { in: ['b-s', 'b-n', 'b-x'] } } }));
    expect((await svc.get(ctx)).access.branches).toEqual([]);
  });
});
