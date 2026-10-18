import { photonAddress } from './geocoding.service';

describe('photonAddress', () => {
  it('builds a short Indian address and drops repeated parts', () => {
    expect(
      photonAddress({ name: 'Anna Salai', street: 'Anna Salai', locality: 'Teynampet', district: 'Chennai', city: 'Chennai', state: 'Tamil Nadu', postcode: '600018' }),
    ).toBe('Anna Salai, Teynampet, Chennai, Tamil Nadu 600018');
  });

  it('adds the house number to the street and falls back to district / county', () => {
    expect(photonAddress({ housenumber: '12', street: 'MG Road', district: 'Shivajinagar', county: 'Bengaluru Urban', state: 'Karnataka' })).toBe(
      '12 MG Road, Shivajinagar, Bengaluru Urban, Karnataka',
    );
  });

  it('returns null when nothing is usable', () => {
    expect(photonAddress({})).toBeNull();
  });
});
