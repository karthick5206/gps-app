import { assertProductionSafe, deliveryChannels, productionWarnings } from './env';

/** R-02 / R-28: production must refuse dev echo and example secrets, and warn about undelivered messages. */
describe('production environment checks', () => {
  const secret = 'x'.repeat(64);

  it('accepts a safe production configuration', () => {
    expect(() => assertProductionSafe({ otpDevEcho: false, mailDevEcho: false, jwtSecret: secret })).not.toThrow();
  });

  it('refuses OTP or mail dev echo in production', () => {
    expect(() => assertProductionSafe({ otpDevEcho: true, mailDevEcho: false, jwtSecret: secret })).toThrow(/DEV_ECHO/);
    expect(() => assertProductionSafe({ otpDevEcho: false, mailDevEcho: true, jwtSecret: secret })).toThrow(/DEV_ECHO/);
  });

  it('refuses the .env.example JWT secret', () => {
    expect(() => assertProductionSafe({ otpDevEcho: false, mailDevEcho: false, jwtSecret: 'change-me-' + secret })).toThrow(/JWT_SECRET/);
  });

  it('warns when no SMS or mail provider is configured, and about private-network opt-ins', () => {
    const w = productionWarnings({ NODE_ENV: 'production', WEBHOOK_ALLOW_PRIVATE: 'true', RELAY_ALLOW_PRIVATE: 'true', MAIL_KEEP_COPIES: 'true' });
    expect(w.join('\n')).toMatch(/SMS provider/);
    expect(w.join('\n')).toMatch(/mail provider/);
    expect(w.join('\n')).toMatch(/WEBHOOK_ALLOW_PRIVATE/);
    expect(w.join('\n')).toMatch(/RELAY_ALLOW_PRIVATE/);
    expect(w.join('\n')).toMatch(/MAIL_KEEP_COPIES/);
  });

  it('deliveryChannels: dev always delivers (echo); production needs real providers', () => {
    expect(deliveryChannels({})).toEqual({ sms: true, email: true });
    expect(deliveryChannels({ NODE_ENV: 'production' })).toEqual({ sms: false, email: false });
    expect(deliveryChannels({ NODE_ENV: 'production', SMS_PROVIDER: 'console' })).toEqual({ sms: false, email: false });
    expect(deliveryChannels({ NODE_ENV: 'production', SMS_PROVIDER: 'smartping', ZOHO_MAIL_KEY: 'k' })).toEqual({ sms: true, email: true });
    expect(deliveryChannels({ NODE_ENV: 'production', SMTP_URL: 'smtps://x' })).toEqual({ sms: false, email: true });
  });

  it('no warnings when real providers are configured', () => {
    expect(productionWarnings({ SMS_PROVIDER: 'smartping', SMTP_URL: 'smtps://example' })).toEqual([]);
    expect(productionWarnings({ SMS_PROVIDER: 'smartping', ZOHO_MAIL_KEY: 'k' })).toEqual([]);
  });
});
