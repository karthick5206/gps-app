import { keepMailCopies } from '../auth/mailer.service';
import { consoleSmsLine } from './sms';

/** R-28: login codes, reset links and customer mails must not be written to disk or logs in production. */
describe('production echo guards', () => {
  const sms = { to: '+919444907658', text: 'Your VeeTrax code is 482913. Do not share', dltTemplateId: '1777', senderId: 'VIBHAV', variables: ['482913'] };

  it('development: the console SMS line keeps the full text (developer convenience)', () => {
    expect(consoleSmsLine(sms, false)).toContain('482913');
  });

  it('production: the console SMS line withholds text, variables and most of the number', () => {
    const line = consoleSmsLine(sms, true);
    expect(line).not.toContain('482913');
    expect(line).not.toContain('Do not share');
    expect(line).not.toContain('9444907658');
    expect(line).toContain('7658');
    expect(line).toMatch(/NOT DELIVERED/);
  });

  it('mail copies: always in development, opt-in only in production', () => {
    expect(keepMailCopies({ NODE_ENV: 'development' })).toBe(true);
    expect(keepMailCopies({})).toBe(true);
    expect(keepMailCopies({ NODE_ENV: 'production' })).toBe(false);
    expect(keepMailCopies({ NODE_ENV: 'production', MAIL_KEEP_COPIES: 'true' })).toBe(true);
    expect(keepMailCopies({ NODE_ENV: 'production', MAIL_KEEP_COPIES: '1' })).toBe(false);
  });
});
