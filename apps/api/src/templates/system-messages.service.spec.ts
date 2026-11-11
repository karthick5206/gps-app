import { SystemMessagesService } from './system-messages.service';
import { MailerService } from '../auth/mailer.service';

describe('SystemMessagesService.log (D6 G3)', () => {
  function make() {
    const create = jest.fn(async () => ({}));
    const svc = new SystemMessagesService({ notificationLog: { create } } as never);
    return { svc, create };
  }
  const base = { companyId: 'c1', channel: 'SMS' as const, recipient: '+911', templateId: null, subject: null, body: 'Code 123456', provider: 'console' };

  it('records SKIPPED (no sentAt, attempts 0) with its reason', async () => {
    const { svc, create } = make();
    await svc.log({ ...base, status: 'SKIPPED', error: 'SMS provider not configured', secrets: ['123456'] });
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'SKIPPED', error: 'SMS provider not configured', sentAt: null, attempts: 0, body: 'Code ******' }) });
  });

  it('records SENT with the provider message id and sentAt', async () => {
    const { svc, create } = make();
    await svc.log({ ...base, provider: 'smartping', status: 'SENT', providerMessageId: 'TX-1' });
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'SENT', providerMessageId: 'TX-1', attempts: 1, sentAt: expect.any(Date) }) });
  });

  it('the console SMS provider is never "configured"', () => {
    const prev = process.env.SMS_PROVIDER;
    delete process.env.SMS_PROVIDER;
    expect(make().svc.sms.configured).toBe(false);
    process.env.SMS_PROVIDER = prev;
  });
});

describe('MailerService.sendWithResult (D6 G3)', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('production without a provider: nothing delivered, provider null (callers record SKIPPED)', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SMTP_URL;
    delete process.env.ZOHO_MAIL_KEY;
    const res = await new MailerService().sendWithResult({ to: 'a@b.c', subject: 's', html: '<p>x</p>', text: 'x', messageId: '<k@veetrax.notify>' });
    expect(res).toEqual({ provider: null, messageId: null, file: '' });
  });
});
