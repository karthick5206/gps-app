import { photonAddress, photonConfidence } from './geocoding.service';

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

describe('photonConfidence', () => {
  it('maps the Photon match type to a confidence, house numbers highest', () => {
    expect(photonConfidence({ type: 'house', housenumber: '12', street: 'MG Road' })).toBe(0.9);
    expect(photonConfidence({ type: 'house', name: 'Tidel Park' })).toBe(0.8);
    expect(photonConfidence({ type: 'street' })).toBe(0.6);
    expect(photonConfidence({ type: 'locality' })).toBe(0.4);
    expect(photonConfidence({ type: 'city' })).toBe(0.25);
    expect(photonConfidence({ type: 'COUNTRY' })).toBe(0.05);
  });

  it('is null without a usable type (no importance in the Photon API output)', () => {
    expect(photonConfidence(undefined)).toBeNull();
    expect(photonConfidence({ importance: '0.7' })).toBeNull();
    expect(photonConfidence({ type: 'planet' })).toBeNull();
  });
});
