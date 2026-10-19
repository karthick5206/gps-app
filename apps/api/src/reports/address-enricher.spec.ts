import { GeocodingService } from '../geocoding/geocoding.service';
import { PrismaService } from '../prisma/prisma.service';
import { AddressEnricher, AddressField } from './address-enricher';

interface R {
  id: string;
  lat: number | null;
  lng: number | null;
  address: string | null;
}
const field: AddressField<R> = { lat: (r) => r.lat, lng: (r) => r.lng, get: (r) => r.address, set: (r, a) => (r.address = a) };
const row = (id: string, lat: number | null, lng: number | null, address: string | null = null): R => ({ id, lat, lng, address });

function setup(opts: { enabled?: boolean; cache?: Record<string, string>; reverse?: (lat: number, lng: number) => Promise<string | null> } = {}) {
  const cache = opts.cache ?? {};
  const prisma = {
    addressCache: {
      findMany: jest.fn(async ({ where }: { where: { key: { in: string[] } } }) =>
        where.key.in.filter((k) => cache[k]).map((k) => ({ key: k, address: cache[k] })),
      ),
    },
    $executeRaw: jest.fn(async () => 1),
  };
  const geocoder = {
    enabled: opts.enabled ?? true,
    reverse: jest.fn(opts.reverse ?? (async (lat: number, lng: number) => `Addr ${lat.toFixed(4)},${lng.toFixed(4)}`)),
  };
  const enricher = new AddressEnricher(prisma as unknown as PrismaService, geocoder as unknown as GeocodingService);
  return { prisma, geocoder, enricher };
}

describe('AddressEnricher', () => {
  it('looks each rounded coordinate up once (parked vehicles repeat the same point)', async () => {
    const { prisma, geocoder, enricher } = setup();
    const rows = [...Array.from({ length: 200 }, (_, i) => row(`p${i}`, 13.08271 + (i % 2) * 0.000001, 80.27071)), row('x', 12.9, 77.6)];
    const stats = await enricher.enrich(rows, [field]);
    expect(geocoder.reverse).toHaveBeenCalledTimes(2);
    expect(prisma.addressCache.findMany).toHaveBeenCalledTimes(1);
    expect(stats).toMatchObject({ pending: 201, unique: 2, cached: 0, lookedUp: 2, filled: 201, skipped: 0 });
    expect(rows[0].address).toBe('Addr 13.0827,80.2707');
    expect(rows[200].address).toBe('Addr 12.9000,77.6000');
  });

  it('reads cached addresses in one bulk query and only geocodes the rest', async () => {
    const { prisma, geocoder, enricher } = setup({ cache: { '13.0827,80.2707': 'Anna Salai, Chennai' } });
    const rows = [row('a', 13.0827, 80.2707), row('b', 13.0827, 80.2707), row('c', 11.0168, 76.9558)];
    const stats = await enricher.enrich(rows, [field]);
    expect(prisma.addressCache.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.addressCache.findMany.mock.calls[0][0].where.key.in).toEqual(['13.0827,80.2707', '11.0168,76.9558']);
    expect(geocoder.reverse).toHaveBeenCalledTimes(1);
    expect(geocoder.reverse).toHaveBeenCalledWith(11.0168, 76.9558);
    expect(rows.map((r) => r.address)).toEqual(['Anna Salai, Chennai', 'Anna Salai, Chennai', 'Addr 11.0168,76.9558']);
    expect(stats.cached).toBe(1);
  });

  it('stops geocoding at the budget and leaves the remaining rows with coordinates', async () => {
    const { geocoder, enricher } = setup();
    const rows = Array.from({ length: 10 }, (_, i) => row(`r${i}`, 13 + i * 0.01, 80));
    const stats = await enricher.enrich(rows, [field], { budget: 3 });
    expect(geocoder.reverse).toHaveBeenCalledTimes(3);
    expect(rows.filter((r) => r.address).length).toBe(3);
    expect(stats).toMatchObject({ lookedUp: 3, skipped: 7, filled: 3 });
  });

  it('keeps at most `concurrency` lookups in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const { enricher } = setup({
      reverse: async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return 'Somewhere';
      },
    });
    const rows = Array.from({ length: 30 }, (_, i) => row(`r${i}`, 10 + i * 0.01, 78));
    await enricher.enrich(rows, [field], { concurrency: 4 });
    expect(peak).toBeLessThanOrEqual(4);
    expect(rows.every((r) => r.address === 'Somewhere')).toBe(true);
  });

  it('never throws: geocoder errors and cache failures leave the coordinates', async () => {
    const { enricher } = setup({ reverse: async (lat) => (lat > 12 ? Promise.reject(new Error('timeout')) : 'Ok') });
    const rows = [row('a', 13, 80), row('b', 11, 77)];
    await expect(enricher.enrich(rows, [field])).resolves.toBeDefined();
    expect(rows.map((r) => r.address)).toEqual([null, 'Ok']);

    const broken = setup();
    broken.prisma.addressCache.findMany.mockRejectedValueOnce(new Error('db down'));
    const rows2 = [row('a', 13, 80)];
    await expect(broken.enricher.enrich(rows2, [field])).resolves.toBeDefined();
    expect(rows2[0].address).toBeNull();
  });

  it('skips everything when the geocoder is disabled', async () => {
    const { prisma, geocoder, enricher } = setup({ enabled: false });
    const rows = [row('a', 13, 80)];
    const stats = await enricher.enrich(rows, [field]);
    expect(stats.pending).toBe(0);
    expect(prisma.addressCache.findMany).not.toHaveBeenCalled();
    expect(geocoder.reverse).not.toHaveBeenCalled();
    expect(await enricher.enrichReport('POSITIONS', rows)).toBeNull();
  });

  it('ignores rows that already have an address or no coordinates', async () => {
    const { geocoder, enricher } = setup();
    const rows = [row('a', 13, 80, 'Known'), row('b', null, null)];
    const stats = await enricher.enrich(rows, [field]);
    expect(stats.pending).toBe(0);
    expect(geocoder.reverse).not.toHaveBeenCalled();
    expect(rows[0].address).toBe('Known');
  });

  it('fills trip start and end and stores the new addresses with one statement', async () => {
    const { prisma, enricher } = setup();
    const trips = [
      { id: 't1', startLat: 13, startLng: 80, endLat: 12, endLng: 79, startAddress: null, endAddress: 'Known end' },
      { id: 't2', startLat: 13, startLng: 80, endLat: 13, endLng: 80, startAddress: 'Depot', endAddress: 'Depot' },
    ];
    const stats = await enricher.enrichReport('TRIPS', trips);
    expect(stats?.filled).toBe(1);
    expect(trips[0].startAddress).toBe('Addr 13.0000,80.0000');
    expect(trips[0].endAddress).toBe('Known end');
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('does not store addresses for report rows that are not trips, stops or alerts', async () => {
    const { prisma, enricher } = setup();
    const rows = [row('p1', 13, 80)];
    await enricher.enrichReport('POSITIONS', rows);
    expect(rows[0].address).toBe('Addr 13.0000,80.0000');
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});
