import { aggregateMileage, mileageTotals } from './mileage-report';
import { ObjInfo } from './report-queries';

const obj = (name: string): ObjInfo => ({ name, plateNumber: `TN ${name}`, branchId: null, branchName: null, type: 'VEHICLE', vehicleType: null, speedLimitKph: null });
const objects = new Map([
  ['a', obj('Car A')],
  ['b', obj('Car B')],
]);

describe('mileage report (manual fuel entries)', () => {
  it('km/L, cost per km and price per litre from fill-ups and GPS distance', () => {
    const rows = aggregateMileage(
      objects,
      [
        { objectId: 'a', kind: 'FUEL', amountPaise: 200_000, litres: 20 },
        { objectId: 'a', kind: 'FUEL', amountPaise: 100_000, litres: 10 },
        { objectId: 'a', kind: 'SERVICE', amountPaise: 150_000, litres: null },
        { objectId: 'x', kind: 'FUEL', amountPaise: 1_000, litres: 1 }, // not in scope
      ],
      new Map([['a', 450]]),
    );
    expect(rows).toEqual([
      { objectId: 'a', objectName: 'Car A', plateNumber: 'TN Car A', fillUps: 2, litres: 30, fuelCost: 3000, otherCost: 1500, totalCost: 4500, distanceKm: 450, kmPerL: 15, costPerKm: 10, pricePerL: 100 },
    ]);
  });

  it('no distance or no fuel gives blanks, not zero mileage', () => {
    const [r] = aggregateMileage(objects, [{ objectId: 'b', kind: 'FUEL', amountPaise: 50_000, litres: 5 }], new Map());
    expect(r.kmPerL).toBeNull();
    expect(r.costPerKm).toBeNull();
    expect(r.pricePerL).toBe(100);
  });

  it('fleet totals are recomputed from sums', () => {
    const rows = aggregateMileage(
      objects,
      [
        { objectId: 'a', kind: 'FUEL', amountPaise: 100_000, litres: 10 },
        { objectId: 'b', kind: 'FUEL', amountPaise: 100_000, litres: 10 },
      ],
      new Map([['a', 200], ['b', 100]]),
    );
    expect(mileageTotals(rows)).toMatchObject({ vehicles: 2, fillUps: 2, litres: 20, distanceKm: 300, kmPerL: 15, costPerKm: 6.67, pricePerL: 100 });
  });
});
