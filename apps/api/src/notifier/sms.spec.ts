import { createSmsProvider, SmartpingSmsProvider } from './sms';

const env = { SMARTPING_USERNAME: 'acct.trans', SMARTPING_PASSWORD: 'pw', SMARTPING_ENTITY_ID: '1701159267852525735', SMARTPING_SENDER: 'VIBHAV' };
const reply = (status: number, body: unknown) => jest.fn().mockResolvedValue({ ok: status < 400, status, text: async () => JSON.stringify(body) });

describe('SmartpingSmsProvider', () => {
  const msg = { to: '+919444907658', text: 'Your code is 123456 . Do not share', dltTemplateId: '1777179276261487525', senderId: 'VIBHAV' };

  it('sends the DLT fields and the number without "+" and returns the transaction id', async () => {
    const fetchImpl = reply(200, { transactionId: 987, state: 'SUBMIT_ACCEPTED', statusCode: 200, description: 'Message accepted' });
    const r = await new SmartpingSmsProvider(env, fetchImpl as unknown as typeof fetch).send(msg);
    expect(r).toEqual({ provider: 'smartping', messageId: '987' });
    const url = new URL(fetchImpl.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe('https://pgapi.smartping.io/fe/api/v1/send');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      username: 'acct.trans',
      password: 'pw',
      from: 'VIBHAV',
      to: '919444907658',
      text: 'Your code is 123456 . Do not share',
      unicode: 'false',
      dltPrincipalEntityId: '1701159267852525735',
      dltContentId: '1777179276261487525',
    });
  });

  it('throws Smartping errors (e.g. authentication failure) so the caller logs a FAILED delivery', async () => {
    const fetchImpl = reply(200, { transactionId: 0, state: 'SUBMIT_FAILED', statusCode: 2070, description: 'Authentication failure', pdu: 0 });
    await expect(new SmartpingSmsProvider(env, fetchImpl as unknown as typeof fetch).send(msg)).rejects.toThrow('Authentication failure');
  });

  it('refuses to send without credentials or a registered DLT template id', async () => {
    const fetchImpl = jest.fn();
    await expect(new SmartpingSmsProvider({}, fetchImpl as unknown as typeof fetch).send(msg)).rejects.toThrow('not configured');
    await expect(new SmartpingSmsProvider(env, fetchImpl as unknown as typeof fetch).send({ ...msg, dltTemplateId: 'DLT-PENDING-3' })).rejects.toThrow('DLT template id');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is selected with SMS_PROVIDER=smartping', () => {
    expect(createSmsProvider('smartping').name).toBe('smartping');
    expect(createSmsProvider('console').name).toBe('console');
  });
});
