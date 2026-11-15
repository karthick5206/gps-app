import { minimumTopUp, monthlyCharge, pickRateCard, tripCharge } from '@veetracer/shared';

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

describe('dedicated cabs and minimum guarantee (v1.16.13)', () => {
  it('prorates the monthly fee and included km by days attached', () => {
    const p = { monthlyFee: 30000, includedKm: 3000, perExtraKm: 10 };
    // 15 of 30 days: fee 15,000, included 1,500 km; 1,600 km → 100 extra.
    expect(monthlyCharge(p, 1600, { days: 15, daysInMonth: 30 }).amount).toBe(16000);
    // Proration switched off: full fee, full included km.
    expect(monthlyCharge({ ...p, prorate: false }, 1600, { days: 15, daysInMonth: 30 }).amount).toBe(30000);
    // A whole month: no proration text, no extra.
    expect(monthlyCharge(p, 2000, { days: 30, daysInMonth: 30 }).amount).toBe(30000);
  });

  it('tops a vehicle up to its minimum guarantee, prorated', () => {
    expect(minimumTopUp({ perTrip: 450, minMonthly: 20000 }, 13500)).toEqual({ topUp: 6500, basis: expect.stringContaining('minimum ₹20000') });
    expect(minimumTopUp({ perTrip: 450, minMonthly: 20000 }, 25000)).toBeNull();
    expect(minimumTopUp({ perTrip: 450, minMonthly: 20000 }, 5000, { days: 15, daysInMonth: 30 })?.topUp).toBe(5000);
    expect(minimumTopUp({ perTrip: 450 }, 0)).toBeNull();
  });
});
