import { etmsRoutingEnabled } from './etms-routing-flag';

describe('etmsRoutingEnabled (ETMS_ROUTING)', () => {
  it('is off by default', () => {
    expect(etmsRoutingEnabled({})).toBe(false);
    expect(etmsRoutingEnabled({ ETMS_ROUTING: '' })).toBe(false);
    expect(etmsRoutingEnabled({ ETMS_ROUTING: 'off' })).toBe(false);
    expect(etmsRoutingEnabled({ ETMS_ROUTING: '1' })).toBe(false);
    expect(etmsRoutingEnabled({ ETMS_ROUTING: 'true' })).toBe(false);
  });

  it('is on only with ETMS_ROUTING=on', () => {
    expect(etmsRoutingEnabled({ ETMS_ROUTING: 'on' })).toBe(true);
    expect(etmsRoutingEnabled({ ETMS_ROUTING: ' ON ' })).toBe(true);
  });

  it('ETMS=off switches it off too', () => {
    expect(etmsRoutingEnabled({ ETMS: 'off', ETMS_ROUTING: 'on' })).toBe(false);
    expect(etmsRoutingEnabled({ ETMS: 'on', ETMS_ROUTING: 'on' })).toBe(true);
  });

  it('reads process.env by default', () => {
    const saved = { ...process.env };
    try {
      delete process.env.ETMS;
      process.env.ETMS_ROUTING = 'on';
      expect(etmsRoutingEnabled()).toBe(true);
      delete process.env.ETMS_ROUTING;
      expect(etmsRoutingEnabled()).toBe(false);
    } finally {
      process.env = saved;
    }
  });
});
