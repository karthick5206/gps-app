import { mapIo } from '../gateway/teltonika/decoder';
import { aggregateFuelDays, calibrate, emptyFuelState, FuelConfig, FuelEventOut, fuelLitres, parseFuelConfig, refillThreshold, stepFuel } from './fuel-logic';

const cfg = (over: Partial<FuelConfig> = {}): FuelConfig => ({ ...parseFuelConfig({ source: 'can_level_l' }), tankCapacityL: 100, ...over });

/** Deterministic ±amp noise. */
function noise(i: number, amp: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 2 * amp;
}

function run(readings: { t: number; litres: number; speedKph: number }[], c: FuelConfig): FuelEventOut[] {
  const state = emptyFuelState();
  const out: FuelEventOut[] = [];
  for (const r of readings) {
    const e = stepFuel(state, { ...r, lat: 13, lng: 80 }, c);
    if (e) out.push(e);
  }
  return out;
}

const MIN = 60_000;

describe('calibration', () => {
  const table: [number, number][] = [[0, 0], [1000, 50], [3000, 150], [500, 20]];

  it('interpolates piecewise linearly (table order does not matter)', () => {
    expect(calibrate(250, table)).toBe(10);
    expect(calibrate(500, table)).toBe(20);
    expect(calibrate(750, table)).toBe(35);
    expect(calibrate(2000, table)).toBe(100);
  });

  it('clamps out-of-range values to the ends of the table', () => {
    expect(calibrate(-50, table)).toBe(0);
    expect(calibrate(9999, table)).toBe(150);
    expect(calibrate(10, [])).toBeNull();
  });

  it('reads litres from each source', () => {
    expect(fuelLitres({ fuelLevelPct: 40 }, cfg({ source: 'can_level_pct', tankCapacityL: 60 }))).toBe(24);
    expect(fuelLitres({ fuelLevelPct: 40 }, cfg({ source: 'can_level_pct', tankCapacityL: null }))).toBeNull();
    expect(fuelLitres({ fuelLevelL: 33.33 }, cfg({ source: 'can_level_l' }))).toBe(33.3);
    expect(fuelLitres({ fuelSensorRaw: 2000 }, cfg({ source: 'lls', calibration: table, tankCapacityL: 200 }))).toBe(100);
    expect(fuelLitres({ fuelSensorRaw: 42 }, cfg({ source: 'lls' }))).toBe(42);
    expect(fuelLitres({ adc1: 0.75 }, cfg({ source: 'analog', calibration: table, tankCapacityL: 200 }))).toBe(35);
    expect(fuelLitres({ fuelLevelL: 20 }, cfg({ source: 'none' }))).toBeNull();
  });

  it('refill threshold defaults to max(10 L, 5 % of the tank)', () => {
    expect(refillThreshold({ refillMinL: null, tankCapacityL: 60 })).toBe(10);
    expect(refillThreshold({ refillMinL: null, tankCapacityL: 400 })).toBe(20);
    expect(refillThreshold({ refillMinL: 15, tankCapacityL: 400 })).toBe(15);
  });
});

describe('refill / drain detection', () => {
  it('no false positives from ±2 L noise while driving and consuming fuel', () => {
    const readings = Array.from({ length: 600 }, (_, i) => ({ t: i * 30_000, litres: 80 - i * 0.05 + noise(i, 2), speedKph: 50 }));
    expect(run(readings, cfg())).toEqual([]);
  });

  it('no false positives from ±2 L noise and single spikes while parked', () => {
    const readings = Array.from({ length: 200 }, (_, i) => ({ t: i * 30_000, litres: 50 + noise(i, 2) + (i === 50 ? 30 : i === 120 ? -25 : 0), speedKph: 0 }));
    expect(run(readings, cfg())).toEqual([]);
  });

  it('detects a refill once the level settles, with before / after levels', () => {
    const readings: { t: number; litres: number; speedKph: number }[] = [];
    let t = 0;
    for (let i = 0; i < 20; i++) readings.push({ t: (t += 30_000), litres: 20 + noise(i, 1.5), speedKph: 0 });
    for (let i = 0; i < 10; i++) readings.push({ t: (t += 30_000), litres: 20 + (i + 1) * 4 + noise(i, 1), speedKph: 0 }); // pumping 40 L
    for (let i = 0; i < 20; i++) readings.push({ t: (t += 30_000), litres: 60 + noise(i + 7, 1.5), speedKph: 0 });
    const events = run(readings, cfg());
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('REFILL');
    expect(events[0].litresBefore).toBeGreaterThan(17);
    expect(events[0].litresBefore).toBeLessThan(23);
    expect(events[0].deltaL).toBeGreaterThan(35);
    expect(events[0].deltaL).toBeLessThan(45);
  });

  it('detects a drain while parked (theft) and reports it when the vehicle drives off', () => {
    const readings: { t: number; litres: number; speedKph: number }[] = [];
    let t = 0;
    for (let i = 0; i < 20; i++) readings.push({ t: (t += 30_000), litres: 70 + noise(i, 1.5), speedKph: 0 });
    for (let i = 0; i < 8; i++) readings.push({ t: (t += 30_000), litres: 70 - (i + 1) * 2.5 + noise(i, 1), speedKph: 0 }); // −20 L in 4 min
    for (let i = 0; i < 3; i++) readings.push({ t: (t += 30_000), litres: 50 + noise(i, 1), speedKph: 0 });
    readings.push({ t: (t += 30_000), litres: 50, speedKph: 40 });
    const events = run(readings, cfg());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'DRAIN' });
    expect(events[0].deltaL).toBeGreaterThan(15);
  });

  it('a slow drop over hours while parked (evaporation / temperature) is not a drain', () => {
    const readings = Array.from({ length: 240 }, (_, i) => ({ t: i * MIN, litres: 60 - i * 0.03 + noise(i, 1), speedKph: 0 }));
    expect(run(readings, cfg())).toEqual([]);
  });

  it('detects a refill across a data gap while parked (tracker asleep)', () => {
    const readings = [
      ...Array.from({ length: 10 }, (_, i) => ({ t: i * 30_000, litres: 15, speedKph: 0 })),
      ...Array.from({ length: 15 }, (_, i) => ({ t: 3 * 3600_000 + i * 30_000, litres: 55, speedKph: 0 })),
    ];
    const events = run(readings, cfg());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'REFILL', litresBefore: 15, litresAfter: 55, deltaL: 40 });
  });
});

describe('daily fuel aggregation', () => {
  it('consumption = start + refills − drains − end; km/L and L/100 km', () => {
    const rows = aggregateFuelDays(
      [
        { objectId: 'a', day: '2026-10-18', startL: 40, endL: 50, distanceKm: 300 },
        { objectId: 'a', day: '2026-10-19', startL: 50, endL: 48, distanceKm: 0.2 },
        { objectId: 'b', day: '2026-10-19', startL: null, endL: null, distanceKm: 10 },
      ],
      [
        { objectId: 'a', day: '2026-10-18', type: 'REFILL', deltaL: 40 },
        { objectId: 'a', day: '2026-10-18', type: 'DRAIN', deltaL: 10 },
      ],
    );
    expect(rows[0]).toMatchObject({ refills: 1, refillL: 40, drains: 1, drainL: 10, consumptionL: 20, kmPerL: 15, lPer100Km: 6.7 });
    expect(rows[1]).toMatchObject({ consumptionL: 2, kmPerL: null, lPer100Km: null });
    expect(rows[2]).toMatchObject({ consumptionL: null, kmPerL: null });
  });
});

describe('Teltonika fuel IO mapping', () => {
  const rec = (io: Record<number, number>) =>
    mapIo({ io: Object.entries(io).map(([id, value]) => ({ id: Number(id), value, size: 2 })), eventIoId: 0, priority: 0 } as unknown as Parameters<typeof mapIo>[0]).attributes;

  it('maps CAN fuel level %, litres and fuel used', () => {
    expect(rec({ 89: 63, 84: 455, 83: 123456 })).toMatchObject({ fuelLevelPct: 63, fuelLevelL: 45.5, fuelUsedL: 12345.6 });
  });

  it('maps LLS level and temperature, dropping sensor error codes', () => {
    expect(rec({ 201: 1234, 202: 25, 203: 0xfff6, 204: 0xfb })).toMatchObject({ fuelSensorRaw: 1234, fuelSensorTemp: 25, fuelSensorTemp2: -5 });
    expect(rec({ 203: 0xfff6 }).fuelSensorRaw2).toBeUndefined();
    expect(rec({ 201: 10 }).io201).toBeUndefined();
  });

  it('keeps AIN1 as adc1 volts for analog sensors', () => {
    expect(rec({ 9: 4520 })).toMatchObject({ adc1: 4.52 });
  });
});
