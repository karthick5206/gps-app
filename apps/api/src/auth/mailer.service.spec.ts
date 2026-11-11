import { logSubject } from './mailer.service';

describe('mailer log lines (no codes in journald)', () => {
  it('masks sign-in / activation codes and phone numbers in subjects', () => {
    expect(logSubject('483920 is your VeeTrax sign-in code')).toBe('****** is your VeeTrax sign-in code');
    expect(logSubject('5521 is the VeeTrax Tracker activation code for +919800000001')).toBe('****** is the VeeTrax Tracker activation code for +******');
    expect(logSubject('Your code: 12345678')).not.toContain('12345678');
  });

  it('replaces links (a company template may put {{reset_link}} in the subject)', () => {
    expect(logSubject('Reset here https://app.veetrax.com/reset?token=abc123 now')).toBe('Reset here [link] now');
  });

  it('leaves ordinary subjects readable', () => {
    expect(logSubject('[CRITICAL] SOS / panic: TN 01 AB 123')).toBe('[CRITICAL] SOS / panic: TN 01 AB 123');
    expect(logSubject('Reset your VeeTrax password')).toBe('Reset your VeeTrax password');
  });
});
