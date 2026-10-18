import { effectiveRetentionDays } from './retention.service';

describe('effectiveRetentionDays', () => {
  it('clamps to the supported 30–180 day range and defaults to 90', () => {
    expect(effectiveRetentionDays(90)).toBe(90);
    expect(effectiveRetentionDays(7)).toBe(30);
    expect(effectiveRetentionDays(400)).toBe(180);
    expect(effectiveRetentionDays(null)).toBe(90);
    expect(effectiveRetentionDays(Number.NaN)).toBe(90);
  });
});
