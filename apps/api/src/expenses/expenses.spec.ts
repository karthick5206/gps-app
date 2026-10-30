import { parseBillText, vehicleCost } from '@veetracer/shared';

describe('expenses', () => {
  it('km per litre and cost per km', () => {
    expect(vehicleCost(600, 40, 400_000, 100_000)).toEqual({ kmPerLitre: 15, costPerKmPaise: 833 });
    expect(vehicleCost(0, 40, 400_000, 0)).toEqual({ kmPerLitre: null, costPerKmPaise: null });
  });

  it('reads amount and litres from fuel bill text', () => {
    expect(parseBillText('HP PETROL PUMP\nRate: 102.63\nVolume(L): 24.36\nAmount Rs: 2,500.00\nThank you')).toEqual({ amount: 2500, litres: 24.36 });
    expect(parseBillText('Qty(Ltr) 9.74  Sale Amount 1000')).toEqual({ amount: 1000, litres: 9.74 });
    expect(parseBillText('Total ₹ 3,250  15.20 L')).toEqual({ amount: 3250, litres: 15.2 });
    expect(parseBillText('no numbers here')).toEqual({ amount: null, litres: null });
  });
});
