import { etmsRoutingEnabled } from './transport-feature.guard';

describe('ETMS_ROUTING switch (doc 17 §7: off by default)', () => {
  it.each([
    [{}, false],
    [{ ETMS_ROUTING: 'off' }, false],
    [{ ETMS_ROUTING: 'true' }, false],
    [{ ETMS_ROUTING: 'on' }, true],
    [{ ETMS_ROUTING: ' ON ' }, true],
    [{ ETMS_ROUTING: 'on', ETMS: 'off' }, false],
  ] as [NodeJS.ProcessEnv, boolean][])('%j → %s', (env, on) => {
    expect(etmsRoutingEnabled(env)).toBe(on);
  });
});
