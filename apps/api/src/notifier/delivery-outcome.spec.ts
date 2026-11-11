import { notConfiguredReason, outcome, writesDevCopy } from './delivery-outcome';

describe('D6 G3 delivery outcome', () => {
  it('an unconfigured provider is SKIPPED, never SENT, even without an error', () => {
    expect(outcome({ channel: 'SMS', configured: false })).toEqual({ status: 'SKIPPED', error: 'SMS provider not configured', providerMessageId: null });
    expect(outcome({ channel: 'EMAIL', configured: false, messageId: 'x' })).toEqual({ status: 'SKIPPED', error: 'E-mail provider not configured', providerMessageId: null });
  });

  it('a development copy keeps SKIPPED with its reason', () => {
    expect(outcome({ channel: 'SMS', configured: false, devCopy: true }).error).toBe('SMS provider not configured (development copy only)');
    expect(outcome({ channel: 'SMS', configured: false, devCopy: true }).status).toBe('SKIPPED');
  });

  it('a configured provider error is FAILED', () => {
    expect(outcome({ channel: 'SMS', configured: true, error: 'Smartping 503' })).toEqual({ status: 'FAILED', error: 'Smartping 503', providerMessageId: null });
  });

  it('SENT only when a configured provider accepted it; keeps the provider id', () => {
    expect(outcome({ channel: 'SMS', configured: true, error: null, messageId: 'T-1' })).toEqual({ status: 'SENT', error: null, providerMessageId: 'T-1' });
    expect(outcome({ channel: 'PUSH', configured: true })).toEqual({ status: 'SENT', error: null, providerMessageId: null });
  });

  it('labels every channel', () => {
    expect(notConfiguredReason('WHATSAPP')).toBe('WhatsApp provider not configured');
    expect(notConfiguredReason('PUSH')).toBe('Push provider not configured');
    expect(notConfiguredReason('ARATTAI')).toBe('Arattai provider not configured');
  });

  it('writes development copies only outside production', () => {
    expect(writesDevCopy({ NODE_ENV: 'production' })).toBe(false);
    expect(writesDevCopy({ NODE_ENV: 'development' })).toBe(true);
    expect(writesDevCopy({})).toBe(true);
  });
});
