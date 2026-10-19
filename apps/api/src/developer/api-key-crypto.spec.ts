import { createHash } from 'node:crypto';
import { decide } from './rate-limit';
import {
  displayPrefix,
  generateApiKey,
  hashApiKey,
  hasScope,
  ipAllowed,
  isWellFormedApiKey,
  looksLikeApiKey,
  normaliseScopes,
  parseIpEntry,
} from './api-key-crypto';

describe('API key crypto', () => {
  it('generates vtx_live_ keys, stores only a SHA-256 hash and a short prefix', () => {
    const k = generateApiKey();
    expect(k.secret).toMatch(/^vtx_live_[A-Za-z0-9_-]{43}$/);
    expect(isWellFormedApiKey(k.secret)).toBe(true);
    expect(k.hash).toBe(createHash('sha256').update(k.secret).digest('hex'));
    expect(k.hash).not.toContain(k.secret.slice(9));
    expect(k.prefix).toBe(k.secret.slice(0, 15));
    expect(displayPrefix(k.secret)).toBe(k.prefix);
    expect(generateApiKey().secret).not.toBe(k.secret);
  });

  it('verifies by hash equality only', () => {
    const k = generateApiKey();
    expect(hashApiKey(k.secret)).toBe(k.hash);
    expect(hashApiKey(`${k.secret}x`)).not.toBe(k.hash);
  });

  it('tells keys from JWTs', () => {
    expect(looksLikeApiKey('vtx_live_abc')).toBe(true);
    expect(looksLikeApiKey('eyJhbGciOiJIUzI1NiJ9.e30.x')).toBe(false);
    expect(isWellFormedApiKey('vtx_live_short')).toBe(false);
  });

  it('normalises scopes; critical implies write:commands', () => {
    expect(normaliseScopes(['read:vehicles', 'bogus', 'read:vehicles'])).toEqual(['read:vehicles']);
    expect(normaliseScopes(['write:commands:critical'])).toEqual(['write:commands', 'write:commands:critical']);
    expect(hasScope(['read:vehicles'], 'read:positions')).toBe(false);
    expect(hasScope(['write:commands:critical'], 'write:commands')).toBe(true);
    expect(hasScope(['write:commands'], 'write:commands:critical')).toBe(false);
  });

  it('parses and matches IP allow-lists (v4, v6, CIDR, IPv4-mapped)', () => {
    expect(parseIpEntry(' 203.0.113.5 ')).toBe('203.0.113.5');
    expect(parseIpEntry('10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(parseIpEntry('10.0.0.0/33')).toBeNull();
    expect(parseIpEntry('example.com')).toBeNull();
    expect(parseIpEntry('2001:db8::/32')).toBe('2001:db8::/32');
    const list = ['203.0.113.5', '10.0.0.0/8', '2001:db8::/32'];
    expect(ipAllowed([], '1.2.3.4')).toBe(true);
    expect(ipAllowed(list, '203.0.113.5')).toBe(true);
    expect(ipAllowed(list, '::ffff:10.9.8.7')).toBe(true);
    expect(ipAllowed(list, '2001:db8::1')).toBe(true);
    expect(ipAllowed(list, '198.51.100.1')).toBe(false);
    expect(ipAllowed(list, null)).toBe(false);
  });
});

describe('rate limit decision', () => {
  const now = Date.UTC(2026, 9, 19, 10, 0, 45); // 45 s into the minute
  it('allows up to the limits', () => {
    const d = decide(60, 100, 60, 10_000, now);
    expect(d.allowed).toBe(true);
    expect(d.remainingMinute).toBe(0);
  });
  it('refuses over the minute limit with Retry-After to the end of the minute', () => {
    const d = decide(61, 100, 60, 10_000, now);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSec).toBe(15);
  });
  it('refuses over the daily limit until UTC midnight', () => {
    const d = decide(1, 10_001, 60, 10_000, now);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSec).toBe(14 * 3600 - 45);
  });
});
