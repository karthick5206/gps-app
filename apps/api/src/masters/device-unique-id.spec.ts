import { normalizeUniqueIdForProtocol, stripJt808LeadingZeros } from './device-unique-id';

describe('device unique id normalisation', () => {
  it('drops JT808 leading zeros so the id matches what the gateway reports', () => {
    expect(stripJt808LeadingZeros('JT808', '014800018486')).toBe('14800018486');
    expect(stripJt808LeadingZeros('jt808', ' 0014800016301 ')).toBe('14800016301');
    expect(stripJt808LeadingZeros('JT808', '14800018486')).toBe('14800018486');
    expect(stripJt808LeadingZeros('JT808', '0')).toBe('0');
  });

  it('leaves other protocols and non-numeric ids alone', () => {
    expect(stripJt808LeadingZeros('GT06', '0123456789')).toBe('0123456789');
    expect(stripJt808LeadingZeros('JT808', 'ABC0123')).toBe('ABC0123');
    expect(normalizeUniqueIdForProtocol('TELTONIKA', '0356307042441013')).toBe('0356307042441013');
  });

  it('still normalises mobile tracker numbers', () => {
    expect(normalizeUniqueIdForProtocol('MOBILE', '98765 43210')).toBe('919876543210');
  });
});
