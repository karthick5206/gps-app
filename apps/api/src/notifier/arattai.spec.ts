import { arattaiConfig, arattaiPhone, arattaiReady, ArattaiOtp } from './arattai';

const ready = { id: 'default', smsEnabled: true, emailEnabled: true, whatsappEnabled: false, arattaiEnabled: true, arattaiCompanyId: 'c1', arattaiBusinessNumberId: 'b1', arattaiOtpTemplateId: 't1', arattaiAlertTemplateId: 'a1', arattaiLanguage: 'en', arattaiClientId: 'id', arattaiClientSecret: 'secret', arattaiRefreshToken: 'rt', arattaiOauthState: null, arattaiConnectedAt: null, arattaiLastSentAt: null, arattaiLastError: null, updatedAt: new Date() };
const cfg = arattaiConfig(ready as never)!;

function fakePrisma(row: typeof ready | null) {
  const updates: unknown[] = [];
  return { updates, messagingSettings: { findUnique: async () => row, update: async (a: unknown) => (updates.push(a), row) } } as never;
}

describe('Arattai OTP', () => {
  it('formats Indian mobiles as country-hyphen-number and refuses others', () => {
    expect(arattaiPhone('919876543210')).toBe('91-9876543210');
    expect(arattaiPhone('+91 98765 43210')).toBe('91-9876543210');
    expect(arattaiPhone('9876543210')).toBe('91-9876543210');
    expect(arattaiPhone('14155550100')).toBeNull();
    expect(arattaiPhone('911234567890')).toBeNull();
  });

  it('is ready only when switched on with every id and the refresh token', () => {
    expect(arattaiReady(cfg)).toBe(true);
    expect(arattaiReady({ ...cfg, enabled: false })).toBe(false);
    expect(arattaiReady({ ...cfg, refreshToken: '' })).toBe(false);
    expect(arattaiReady(null)).toBe(false);
  });

  it('refreshes the token once, then sends the template with otp and validity minutes', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const http = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/oauth/v2/token')) return new Response(JSON.stringify({ access_token: 'AT', expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ data: { ack_key: 'k' } }), { status: 201 });
    }) as typeof fetch;
    const otp = new ArattaiOtp(fakePrisma(ready), http);
    expect(await otp.sendOtp('919876543210', '482913', 10)).toEqual({ sent: true, error: null });
    await otp.sendOtp('919876543211', '111111', 10);
    expect(calls.filter((c) => c.url.includes('/oauth/v2/token'))).toHaveLength(1);
    const send = calls.find((c) => c.url.endsWith('/api/v1/authentications'))!;
    expect(JSON.parse(send.init.body as string)).toEqual({ id: 't1', phone_number: '91-9876543210', language: 'en', variables: { otp: '482913', validity_minutes: '10' } });
    expect((send.init.headers as Record<string, string>)['Arattai-CompanyId']).toBe('c1');
    expect((send.init.headers as Record<string, string>).Authorization).toBe('Bearer AT');
  });

  it('switched off: sends nothing; a refusal is reported, never thrown', async () => {
    let called = false;
    const off = new ArattaiOtp(fakePrisma({ ...ready, arattaiEnabled: false }), (async () => ((called = true), new Response('{}'))) as never);
    expect(await off.sendOtp('919876543210', '1', 10)).toEqual({ sent: false, error: null });
    expect(called).toBe(false);
    const http = (async (url: string) => (url.includes('token') ? new Response(JSON.stringify({ access_token: 'AT' })) : new Response(JSON.stringify({ code: 'invalid_recipient', message: 'not on Arattai' }), { status: 400 }))) as typeof fetch;
    const r = await new ArattaiOtp(fakePrisma(ready), http).sendOtp('919876543210', '1', 10);
    expect(r.sent).toBe(false);
    expect(r.error).toContain('invalid_recipient');
  });

  it('alerts use the transactional template with alert, vehicle, time and details', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const http = (async (url: string, init: RequestInit) => (calls.push({ url, init }), url.includes('token') ? new Response(JSON.stringify({ access_token: 'AT' })) : new Response('{}', { status: 201 }))) as typeof fetch;
    await new ArattaiOtp(fakePrisma(ready), http).sendAlert('919876543210', { alert: 'Overspeed', vehicle: 'TN 22 BJ 9784', time: '9 Nov 20:10', details: '84 km/h near Alandur' });
    const send = calls.find((c) => c.url.endsWith('/api/v1/transactions'))!;
    expect(JSON.parse(send.init.body as string)).toEqual({ id: 'a1', phone_number: '91-9876543210', language: 'en', variables: { alert: 'Overspeed', vehicle: 'TN 22 BJ 9784', time: '9 Nov 20:10', details: '84 km/h near Alandur' } });
    await expect(new ArattaiOtp(fakePrisma({ ...ready, arattaiAlertTemplateId: '' }), http).sendAlert('919876543210', { alert: 'a', vehicle: 'v', time: 't', details: 'd' })).rejects.toThrow(/alert template/);
  });
});
