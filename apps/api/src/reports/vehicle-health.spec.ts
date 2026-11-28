import { batteryVerdict, BatteryDay, IDLE_LITRES_PER_HOUR } from '@veetracer/shared';
import { idleCostRows } from './vehicle-health-report';
import { ObjInfo } from './report-queries';

const days = (rest: (number | null)[], charge: number | null = 14.1): BatteryDay[] =>
  rest.map((r, i) => ({ day: `2026-11-${String(i + 1).padStart(2, '0')}`, restV: r, chargeV: charge, minRestV: r }));

describe('batteryVerdict', () => {
  it('good 12 V battery', () => {
    const v = batteryVerdict(days([12.7, 12.68, 12.66]));
    expect(v).toMatchObject({ status: 'GOOD', systemV: 12, restV: 12.68, chargeV: 14.1 });
  });
  it('weak, replace and falling', () => {
    expect(batteryVerdict(days([12.3, 12.3, 12.3])).status).toBe('WEAK');
    expect(batteryVerdict(days([11.9, 12.0, 11.95])).status).toBe('REPLACE');
    // Still above 12.4 V but down 0.4 V over the period.
    expect(batteryVerdict(days([12.95, 12.9, 12.92, 12.55, 12.5, 12.52])).status).toBe('WEAK');
  });
  it('charging problems win over resting', () => {
    expect(batteryVerdict(days([12.7, 12.7], 12.6)).status).toBe('NOT_CHARGING');
    expect(batteryVerdict(days([12.7, 12.7], 15.6)).status).toBe('OVERCHARGING');
  });
  it('24 V trucks use doubled limits', () => {
    expect(batteryVerdict(days([25.3, 25.2, 25.2], 28.2))).toMatchObject({ status: 'GOOD', systemV: 24 });
    expect(batteryVerdict(days([24.0, 24.1, 24.0], 28.2)).status).toBe('REPLACE');
  });
  it('no voltage = no data', () => {
    expect(batteryVerdict([]).status).toBe('NO_DATA');
    expect(batteryVerdict(days([4.1, 4.0], 4.1)).status).toBe('NO_DATA'); // phone-style readings, not a vehicle battery
  });
});

describe('idleCostRows', () => {
  const objects = new Map<string, ObjInfo>([
    ['a', { name: 'Car A', plateNumber: 'TN 01', branchId: null, branchName: null, type: 'VEHICLE', vehicleType: 'CAR', speedLimitKph: null }],
    ['b', { name: 'Truck B', plateNumber: 'TN 02', branchId: null, branchName: null, type: 'VEHICLE', vehicleType: 'TRUCK', speedLimitKph: null }],
  ]);
  const day = (objectId: string, idleSec: number) =>
    ({ objectId, objectName: objects.get(objectId)!.name, plateNumber: null, branchName: null, day: '2026-11-27', idleSec, engineSec: idleSec * 4 }) as never;
  it('uses the fuel bill price when there is one, else the default', () => {
    const r = idleCostRows([day('a', 3600), day('b', 7200)], 'DAY', objects, new Map([['a', 102.5]]), {});
    const a = r.rows.find((x) => x.objectId === 'a')!;
    const b = r.rows.find((x) => x.objectId === 'b')!;
    expect(a).toMatchObject({ litresPerHour: IDLE_LITRES_PER_HOUR.CAR, litres: 0.8, pricePerL: 102.5, priceSource: 'FUEL_LOG', rupees: 82, idlePct: 25 });
    expect(b).toMatchObject({ litresPerHour: 2.5, litres: 5, pricePerL: 100, priceSource: 'DEFAULT', rupees: 500 });
    expect(r.totals).toMatchObject({ vehicles: 2, idleSec: 10800, litres: 5.8, rupees: 582 });
  });
  it('options override the default price and the rate', () => {
    const r = idleCostRows([day('b', 3600)], 'DAY', objects, new Map(), { fuelPricePerL: 90, idleLitresPerHour: 2 });
    expect(r.rows[0]).toMatchObject({ litresPerHour: 2, litres: 2, pricePerL: 90, rupees: 180 });
  });
});
