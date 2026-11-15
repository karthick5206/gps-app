import { monthlyCharge, pickRateCard, tripCharge } from '@veetracer/shared';

const trip = { km: 21.4, durationMin: 70, plannedMin: 50, passengers: 4, night: false };

describe('rate engine', () => {
  it('prices each model', () => {
    expect(tripCharge('TRIP', { perTrip: 450 }, {}, trip).base).toBe(450);
    expect(tripCharge('KM', { perKm: 14, minKm: 10 }, {}, trip).base).toBe(299.6);
    expect(tripCharge('KM', { perKm: 14, minKm: 25 }, {}, trip).base).toBe(350);
    expect(tripCharge('SLAB', { baseKm: 20, baseFare: 400, perKmAfter: 12 }, {}, trip).base).toBe(416.8);
    expect(tripCharge('PACKAGE', { hours: 1, km: 20, fare: 500, perExtraKm: 10, perExtraHour: 100 }, {}, trip).base).toBe(614);
    expect(tripCharge('SEAT', { perSeat: 120 }, {}, trip).base).toBe(480);
    expect(tripCharge('MONTHLY', { monthlyFee: 38000 }, {}, trip).base).toBe(0);
  });

  it('adds night, escort, waiting and dead km', () => {
    const c = tripCharge('KM', { perKm: 10 }, { nightAllowance: 100, escortPerNightTrip: 250, waitingFreeMin: 10, waitingPerHour: 120, deadKmPerTrip: 5 }, { ...trip, night: true });
    expect(c.base).toBe(264); // (21.4 + 5) × 10
    expect(c.addons).toBe(370); // 100 + 250 + 10 min waiting (70 − 50 − 10) at 120/h = 20
    expect(c.addonText.join(' ')).toContain('waiting 10 min');
  });

  it('monthly: fee plus extra km', () => {
    expect(monthlyCharge({ monthlyFee: 38000, includedKm: 2500, perExtraKm: 12 }, 2620).amount).toBe(39440);
    expect(monthlyCharge({ monthlyFee: 38000, includedKm: 2500, perExtraKm: 12 }, 2000).amount).toBe(38000);
  });

  it('picks the most specific valid card', () => {
    const base = { isActive: true, validTo: null };
    const cards = [
      { ...base, id: 'all', branchId: null, vehicleCategory: null, validFrom: '2026-01-01' },
      { ...base, id: 'branch', branchId: 'b1', vehicleCategory: null, validFrom: '2026-01-01' },
      { ...base, id: 'branch-suv', branchId: 'b1', vehicleCategory: 'SUV', validFrom: '2026-01-01' },
      { ...base, id: 'future', branchId: 'b1', vehicleCategory: 'SUV', validFrom: '2026-12-01' },
    ];
    expect(pickRateCard(cards, '2026-11-16', 'b1', 'SUV')?.id).toBe('branch-suv');
    expect(pickRateCard(cards, '2026-11-16', 'b1', 'SEDAN')?.id).toBe('branch');
    expect(pickRateCard(cards, '2026-11-16', 'b2', 'SUV')?.id).toBe('all');
    expect(pickRateCard(cards, '2026-12-05', 'b1', 'SUV')?.id).toBe('future');
    expect(pickRateCard([{ ...base, id: 'old', branchId: null, vehicleCategory: null, validFrom: '2026-01-01', validTo: '2026-06-30' }], '2026-11-16', null, null)).toBeNull();
  });
});
