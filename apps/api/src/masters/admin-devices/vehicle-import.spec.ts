import { mapVehicleImportHeaders, parseVehicleType } from '@veetracer/shared';
import { istDay, istDayEnd, istDayStart, matchModel, planRows, type ModelRef, type PlanLookups, type ScopedRow } from './vehicle-import';

const V5: ModelRef = { id: 'm1', brand: 'Concox', model: 'V5', protocol: 'GT06', capabilities: [] };
const GT06N: ModelRef = { id: 'm2', brand: 'Concox', model: 'GT06N', protocol: 'GT06', capabilities: [] };
const C = 'c1';

function lookups(over: Partial<PlanLookups> = {}): PlanLookups {
  return {
    models: [V5, GT06N],
    defaultModel: null,
    devicesByImei: new Map(),
    vehiclesByPlate: new Map(),
    simOwner: new Map(),
    normalise: (_m, imei) => imei,
    defaultFrom: '2026-11-17',
    defaultUntil: '2026-12-17',
    now: new Date('2026-11-17T06:00:00Z'),
    ...over,
  };
}
const row = (r: Partial<ScopedRow> & { row: number }): ScopedRow => ({
  vehicleName: 'TN 02 BM 2227',
  imei: '355172106796574',
  model: 'Concox V5',
  sim: '5754180515393',
  companyId: C,
  companyName: 'AMEIRTHA TRAVELS',
  branchId: 'b1',
  branchName: 'Head Office',
  ...r,
});

describe('vehicle import headers', () => {
  it('maps the Ameitha sheet and the extended template', () => {
    expect(mapVehicleImportHeaders(['Vehicle name ', 'IMEI/unique ID', 'Model', 'SIM number'])).toEqual({ vehicleName: 0, imei: 1, model: 2, sim: 3 });
    const m = mapVehicleImportHeaders(['Vehicle name', 'IMEI', 'Model', 'SIM number', 'Plate number', 'Company', 'Branch', 'Vendor', 'Driver name', 'Driver mobile', 'Licence from', 'Licence until']);
    expect(m).toEqual({ vehicleName: 0, imei: 1, model: 2, sim: 3, plate: 4, company: 5, branch: 6, vendor: 7, driverName: 8, driverMobile: 9, licenceFrom: 10, licenceUntil: 11 });
    expect(mapVehicleImportHeaders(['Location', 'License Expiry'])).toEqual({ branch: 0, licenceUntil: 1 });
  });
});

describe('matchModel', () => {
  it('matches brand + model, or the model alone', () => {
    expect(matchModel([V5, GT06N], 'Concox V5')?.id).toBe('m1');
    expect(matchModel([V5, GT06N], 'concox-v5')?.id).toBe('m1');
    expect(matchModel([V5, GT06N], 'GT06N')?.id).toBe('m2');
    expect(matchModel([V5, GT06N], 'Teltonika')).toBeNull();
  });
});

describe('IST days', () => {
  it('bounds a licence day in India time', () => {
    expect(istDayStart('2026-11-17').toISOString()).toBe('2026-11-16T18:30:00.000Z');
    expect(istDayEnd('2026-12-17').toISOString()).toBe('2026-12-17T18:29:59.999Z');
    expect(istDay(new Date('2026-11-16T19:00:00Z'))).toBe('2026-11-17');
  });
});

describe('planRows', () => {
  it('plans a new device + vehicle with the default licence dates; plate = name', () => {
    const [p] = planRows([row({ row: 2 })], lookups());
    expect(p.result).toMatchObject({ action: 'NEW', plate: 'TN 02 BM 2227', modelLabel: 'Concox V5', vehicleType: 'CAR', licenceFrom: '2026-11-17', licenceUntil: '2026-12-17', errors: [] });
  });

  it('reads the vehicle type (map icon): words, plurals, unknown = Car with a warning', () => {
    expect(parseVehicleType('')).toBe('CAR');
    expect(parseVehicleType('School Bus')).toBe('SCHOOL_BUS');
    expect(parseVehicleType('Tempo Traveller')).toBe('VAN');
    expect(parseVehicleType('lorries')).toBeNull();
    expect(parseVehicleType('Buses')).toBe('BUS');
    expect(parseVehicleType('two-wheeler')).toBe('BIKE');
    const [p] = planRows([row({ row: 2, vehicleType: 'Spaceship' })], lookups());
    expect(p.result.vehicleType).toBe('CAR');
    expect(p.result.warnings[0]).toMatch(/Vehicle type "Spaceship" not recognised/);
    expect(mapVehicleImportHeaders(['Vehicle name', 'Vehicle type', 'IMEI', 'Model'])).toEqual({ vehicleName: 0, vehicleType: 1, imei: 2, model: 3 });
  });

  it('flags duplicates in the sheet, unknown models and bad licence dates', () => {
    const plans = planRows(
      [row({ row: 2 }), row({ row: 3, vehicleName: 'TN 67 BY 7893' }), row({ row: 4, vehicleName: 'tn02bm2227', imei: '355172106803347' }), row({ row: 5, vehicleName: 'X', imei: '111111', model: 'Unknown' }), row({ row: 6, vehicleName: 'Y', imei: '222222', licenceUntil: '2026-11-01' })],
      lookups(),
    );
    expect(plans.map((p) => p.result.action)).toEqual(['NEW', 'ERROR', 'ERROR', 'ERROR', 'ERROR']);
    expect(plans[1].result.errors).toContain('Same IMEI as row 2');
    expect(plans[2].result.errors).toContain('Same vehicle as row 2');
    expect(plans[3].result.errors[0]).toMatch(/Model "Unknown" not found/);
    expect(plans[4].result.errors[0]).toMatch(/must be after licence from|already over/);
  });

  it('uses the default model for an unknown one (warning)', () => {
    const [p] = planRows([row({ row: 2, model: 'Some tracker' })], lookups({ defaultModel: GT06N }));
    expect(p.result.action).toBe('NEW');
    expect(p.result.modelLabel).toBe('Concox GT06N');
    expect(p.result.warnings[0]).toMatch(/not recognised/);
  });

  it('fits to an existing vehicle, takes stock devices, skips re-imports, refuses other companies', () => {
    const vehicle = { id: 'o1', name: 'TN 02 BM 2227', plateNumber: 'TN02BM2227', deviceId: null, deviceUniqueId: null };
    const link = planRows([row({ row: 2 })], lookups({ vehiclesByPlate: new Map([[`${C}|TN02BM2227`, vehicle]]) }));
    expect(link[0].result.action).toBe('LINK');

    const stockDev = { id: 'd1', uniqueId: '355172106796574', companyId: null, companyName: null, simNumber: null, objectId: null, objectName: null };
    expect(planRows([row({ row: 2 })], lookups({ devicesByImei: new Map([[stockDev.uniqueId, stockDev]]) }))[0].result.action).toBe('STOCK');

    const mine = { ...stockDev, companyId: C, objectId: 'o1', objectName: 'TN 02 BM 2227' };
    const skip = planRows([row({ row: 2 })], lookups({ devicesByImei: new Map([[mine.uniqueId, mine]]), vehiclesByPlate: new Map([[`${C}|TN02BM2227`, { ...vehicle, deviceId: 'd1', deviceUniqueId: mine.uniqueId }]]) }));
    expect(skip[0].result.action).toBe('SKIP');

    const other = { ...stockDev, companyId: 'c2', companyName: 'Other Co' };
    const err = planRows([row({ row: 2 })], lookups({ devicesByImei: new Map([[other.uniqueId, other]]) }));
    expect(err[0].result.errors[0]).toMatch(/belongs to Other Co/);

    const busy = planRows([row({ row: 2 })], lookups({ vehiclesByPlate: new Map([[`${C}|TN02BM2227`, { ...vehicle, deviceId: 'dX', deviceUniqueId: '999' }]]) }));
    expect(busy[0].result.errors[0]).toMatch(/already has device 999/);
  });

  it('reports a company / branch problem from the service', () => {
    const [p] = planRows([row({ row: 2, companyId: null, scopeError: 'Company "Foo" not found' })], lookups());
    expect(p.result.action).toBe('ERROR');
    expect(p.result.errors).toContain('Company "Foo" not found');
  });
});
