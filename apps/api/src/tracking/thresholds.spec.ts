import { DEFAULT_THRESHOLDS } from '@veetracer/shared';
import { companyThresholds } from './thresholds';

describe('companyThresholds', () => {
  it('falls back to defaults', () => {
    expect(companyThresholds({})).toEqual(DEFAULT_THRESHOLDS);
    expect(companyThresholds(null)).toEqual(DEFAULT_THRESHOLDS);
  });

  it('overrides valid numeric fields only', () => {
    expect(companyThresholds({ thresholds: { idleAfterSec: 300, offlineAfterSec: 'x', driftRadiusM: -1 } })).toEqual({
      ...DEFAULT_THRESHOLDS,
      idleAfterSec: 300,
    });
  });
});
