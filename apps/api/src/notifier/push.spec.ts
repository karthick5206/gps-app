import { createPushProvider, ExpoPushProvider } from './push';

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
