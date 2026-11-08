import { companyFeatures, withFeatures } from './company-features';

describe('company add-ons', () => {
  it('reads the switched-on add-ons and ignores unknown ones', () => {
    expect(companyFeatures({ settings: { features: ['attendanceInsightsPlus', 'nope'] } })).toEqual(['attendanceInsightsPlus']);
    expect(companyFeatures({ settings: {} })).toEqual([]);
    expect(companyFeatures({ settings: null })).toEqual([]);
  });

  it('the platform company has every add-on', () => {
    expect(companyFeatures({ settings: {}, isPlatform: true })).toEqual(['attendanceInsightsPlus']);
  });

  it('replacing the add-ons keeps the other settings', () => {
    expect(withFeatures({ thresholds: { offlineAfterSec: 600 }, features: ['attendanceInsightsPlus'] }, [])).toEqual({ thresholds: { offlineAfterSec: 600 }, features: [] });
  });
});
