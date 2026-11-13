import { Test } from '@nestjs/testing';
import { HealthController } from '../health.controller';
import { HealthProbeService } from '../monitoring/health-probe.service';
import { RoutingSwitchService } from './routing-switch.service';

/**
 * v1.16.0 production finding: `@Optional() x: RoutingSwitchService | null` emits `Object` as design:paramtypes, so Nest
 * injected nothing and GET /api/health/routing always answered "off" (the release gate then reported the emergency
 * switch). The parameter now names its token with @Inject; this test builds the real injector to keep it that way.
 */
describe('RoutingSwitchService injection (v1.16.0)', () => {
  it('HealthController receives the routing switch service and reports idle while the platform switch is off', async () => {
    const routingSwitch = { platformOn: async () => false, readinessNow: async () => ({ ready: true, items: [] }) };
    const mod = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: HealthProbeService, useValue: {} },
        { provide: RoutingSwitchService, useValue: routingSwitch },
      ],
    }).compile();
    const ctl = mod.get(HealthController);
    const res = { status: () => res } as never;
    const prev = process.env.ETMS_ROUTING;
    delete process.env.ETMS_ROUTING;
    try {
      expect(await ctl.routing(res)).toEqual({ ok: true, status: 'IDLE', switch: 'idle', failing: [] });
    } finally {
      if (prev !== undefined) process.env.ETMS_ROUTING = prev;
    }
  });
});
