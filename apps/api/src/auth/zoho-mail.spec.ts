import { parseFrom, sendZohoMail, zohoMailConfig } from './zoho-mail';

describe('Zoho CPaaS mail', () => {
  it('reads config and adds the auth prefix once', () => {
    expect(zohoMailConfig({})).toBeNull();
    expect(zohoMailConfig({ ZOHO_MAIL_KEY: 'abc' })).toEqual({ key: 'Zoho-enczapikey abc', baseUrl: 'https://cpaas.zoho.in' });
    expect(zohoMailConfig({ ZOHO_MAIL_KEY: 'Zoho-enczapikey abc', ZOHO_MAIL_URL: 'https://api.zeptomail.in/' })).toEqual({ key: 'Zoho-enczapikey abc', baseUrl: 'https://api.zeptomail.in' });
  });

  it('parses the from header', () => {
    expect(parseFrom('VeeTracer Alerts <alerts@mintplus.co.in>')).toEqual({ name: 'VeeTracer Alerts', address: 'alerts@mintplus.co.in' });
    expect(parseFrom('alerts@mintplus.co.in')).toEqual({ address: 'alerts@mintplus.co.in' });
  });

  it('posts the message with attachments and surfaces API errors', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = jest.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ request_id: 'r1' }), { status: 201 });
    }) as unknown as typeof fetch;
    const id = await sendZohoMail({ key: 'Zoho-enczapikey k', baseUrl: 'https://cpaas.zoho.in' }, { from: 'VT <a@b.in>', to: 'x@y.in', subject: 'S', html: '<b>h</b>', text: 'h', attachments: [{ filename: 'r.csv', content: 'a,b', contentType: 'text/csv' }] }, ok);
    expect(id).toBe('r1');
    expect(calls[0].url).toBe('https://cpaas.zoho.in/v1.1/email');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Zoho-enczapikey k');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      from: { address: 'a@b.in', name: 'VT' },
      to: [{ email_address: { address: 'x@y.in' } }],
      htmlbody: '<b>h</b>',
      attachments: [{ name: 'r.csv', mime_type: 'text/csv', content: Buffer.from('a,b').toString('base64') }],
    });
    const bad = jest.fn(async () => new Response('{"error":{"code":"TM_3201","message":"Invalid from address"}}', { status: 400 })) as unknown as typeof fetch;
    await expect(sendZohoMail({ key: 'k', baseUrl: 'https://x' }, { from: 'a@b.in', to: 'x@y.in', subject: 'S', html: '', text: '' }, bad)).rejects.toThrow('Zoho mail HTTP 400');
  });

  it('sends reply_to when configured', async () => {
    let body: Record<string, unknown> = {};
    const ok = jest.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response('{}', { status: 201 });
    }) as unknown as typeof fetch;
    await sendZohoMail({ key: 'k', baseUrl: 'https://x' }, { from: 'VeeTracer <noreply@veetracer.com>', replyTo: 'info@vaidhika.in', to: 'x@y.in', subject: 'S', html: '', text: '' }, ok);
    expect(body.reply_to).toEqual([{ address: 'info@vaidhika.in' }]);
    await sendZohoMail({ key: 'k', baseUrl: 'https://x' }, { from: 'a@b.in', to: 'x@y.in', subject: 'S', html: '', text: '' }, ok);
    expect(body.reply_to).toBeUndefined();
  });
});
