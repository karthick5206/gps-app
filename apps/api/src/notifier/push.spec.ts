import { createPushProvider, ExpoPushProvider, pushStyle } from './push';

describe('ExpoPushProvider', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.PUSH_PROVIDER;
  });

  function mockFetch(tickets: unknown[], status = 200) {
    const calls: { url: string; body: unknown[]; headers: Record<string, string> }[] = [];
    global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify({ data: tickets }), { status });
    }) as typeof fetch;
    return calls;
  }

  it('sends one message per token and collects unregistered tokens', async () => {
    const calls = mockFetch([{ status: 'ok' }, { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }]);
    const res = await new ExpoPushProvider('secret').send(['ExponentPushToken[a]', 'ExponentPushToken[b]'], { title: 'Overspeed', body: 'TN 01 at 92 km/h', data: { alertId: 'x' } });
    expect(res).toEqual({ sent: 1, invalidTokens: ['ExponentPushToken[b]'], error: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBe('Bearer secret');
    expect(calls[0].body[0]).toMatchObject({ to: 'ExponentPushToken[a]', title: 'Overspeed', priority: 'high', channelId: 'alerts', data: { alertId: 'x' } });
  });

  it('reports other ticket errors and throws on HTTP failure', async () => {
    mockFetch([{ status: 'error', message: 'MessageRateExceeded', details: { error: 'MessageRateExceeded' } }]);
    expect(await new ExpoPushProvider().send(['ExponentPushToken[a]'], { title: 't', body: 'b' })).toEqual({ sent: 0, invalidTokens: [], error: 'MessageRateExceeded' });
    mockFetch([], 503);
    await expect(new ExpoPushProvider().send(['ExponentPushToken[a]'], { title: 't', body: 'b' })).rejects.toThrow('Expo push HTTP 503');
  });

  it('can be disabled', async () => {
    process.env.PUSH_PROVIDER = 'none';
    const p = createPushProvider();
    expect(p.enabled).toBe(false);
    await expect(p.send([], { title: 't', body: 'b' })).rejects.toThrow('Push not configured');
  });
});

describe('pushStyle', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('routes SOS and CRASH to the sos channel with the siren', () => {
    expect(pushStyle('SOS')).toEqual({ channelId: 'sos', sound: 'sos_siren.wav' });
    expect(pushStyle('CRASH')).toEqual({ channelId: 'sos', sound: 'sos_siren.wav' });
  });

  it('keeps normal alerts on the alerts channel with the default sound', () => {
    expect(pushStyle('OVERSPEED')).toEqual({ channelId: 'alerts', sound: 'default' });
    expect(pushStyle(undefined)).toEqual({ channelId: 'alerts', sound: 'default' });
  });

  it('sends emergency pushes with channel sos, the siren sound, high priority and the alert type', async () => {
    const bodies: unknown[][] = [];
    global.fetch = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ data: [{ status: 'ok' }] }), { status: 200 });
    }) as typeof fetch;
    const data = { alertId: 'a1', type: 'SOS' };
    await new ExpoPushProvider().send(['ExponentPushToken[a]'], { title: 'SOS', body: 'Help', data, ...pushStyle(data.type) });
    expect(bodies[0][0]).toMatchObject({ channelId: 'sos', sound: 'sos_siren.wav', priority: 'high', data: { type: 'SOS' } });
    await new ExpoPushProvider().send(['ExponentPushToken[a]'], { title: 'Overspeed', body: 'x', data: { type: 'OVERSPEED' }, ...pushStyle('OVERSPEED') });
    expect(bodies[1][0]).toMatchObject({ channelId: 'alerts', sound: 'default' });
  });
});
