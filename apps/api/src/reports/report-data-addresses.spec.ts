import { PositionReportRow } from '@veetracer/shared';
import { GeocodingService } from '../geocoding/geocoding.service';
import { PrismaService } from '../prisma/prisma.service';
import { AddressEnricher } from './address-enricher';
import { columnsFor } from './report-columns';
import { ReportDataService } from './report-data.service';
import { pdfColumnWidths, renderReport } from './report-files';

const ctx = { companyId: 'c1', dataScope: 'COMPANY', branchIds: [], objectIds: [] } as unknown as Parameters<ReportDataService['generate']>[0];

function position(i: number, lat: number, lng: number) {
  const t = new Date(Date.UTC(2026, 9, 18, 4, i));
  return { fixTime: t, serverTime: t, lat, lng, speedKph: 0, course: 0, altitude: null, satellites: 9, valid: true, ignition: false, flags: 0, attributes: {} };
}

describe('ReportDataService addresses', () => {
  it('POSITIONS rows get addresses (one lookup per place) and the downloads show them', async () => {
    const points = [position(0, 13.0827, 80.2707), position(1, 13.0827, 80.2707), position(2, 13.0827, 80.2707), position(3, 13.05, 80.25)];
    const prisma = {
      company: { findUniqueOrThrow: jest.fn(async () => ({ name: 'Acme', timezone: 'Asia/Kolkata' })) },
      trackedObject: {
        findMany: jest.fn(async () => [
          { id: 'v1', name: 'Truck 01', plateNumber: 'TN01', branchId: null, branch: null, groups: [], type: 'VEHICLE', vehicleType: null, speedLimitKph: null },
        ]),
      },
      position: {
        findMany: jest.fn(async () => points),
        count: jest.fn(async () => points.length),
        aggregate: jest.fn(async () => ({ _max: { speedKph: 0 } })),
      },
      addressCache: { findMany: jest.fn(async () => [{ key: '13.0500,80.2500', address: 'Mylapore, Chennai' }]) },
      $executeRaw: jest.fn(),
    };
    const geocoder = { enabled: true, reverse: jest.fn(async () => 'Anna Salai, Teynampet, Chennai') };
    const enricher = new AddressEnricher(prisma as unknown as PrismaService, geocoder as unknown as GeocodingService);
    const service = new ReportDataService(prisma as unknown as PrismaService, enricher);

    const data = await service.generate(ctx, { type: 'POSITIONS', scope: { branchIds: [], groupIds: [], objectIds: ['v1'] }, from: '2026-10-18', to: '2026-10-18' });
    const rows = data.rows as PositionReportRow[];
    expect(rows.map((r) => r.address)).toEqual(['Anna Salai, Teynampet, Chennai', 'Anna Salai, Teynampet, Chennai', 'Anna Salai, Teynampet, Chennai', 'Mylapore, Chennai']);
    expect(geocoder.reverse).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();

    const headers = columnsFor('POSITIONS').map((c) => c.header);
    expect(headers).toEqual(expect.arrayContaining(['Latitude', 'Longitude', 'Address']));
    const csv = (await renderReport([data], 'CSV')).buffer.toString('utf8');
    expect(csv).toContain('Address');
    expect(csv).toContain('Mylapore, Chennai');
    const pdf = await renderReport([data], 'PDF');
    expect(pdf.buffer.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('keeps coordinates when the geocoder is off', async () => {
    const prisma = {
      company: { findUniqueOrThrow: jest.fn(async () => ({ name: 'Acme', timezone: 'Asia/Kolkata' })) },
      trackedObject: { findMany: jest.fn(async () => []) },
      addressCache: { findMany: jest.fn() },
      stop: { findMany: jest.fn(async () => []), aggregate: jest.fn(async () => ({ _count: 0, _sum: { durationSec: 0 } })) },
    };
    const geocoder = { enabled: false, reverse: jest.fn() };
    const service = new ReportDataService(prisma as unknown as PrismaService, new AddressEnricher(prisma as unknown as PrismaService, geocoder as unknown as GeocodingService));
    const data = await service.generate(ctx, { type: 'STOPS', scope: { branchIds: [], groupIds: [], objectIds: [] }, from: '2026-10-18', to: '2026-10-18' });
    expect(data.rows).toEqual([]);
    expect(prisma.addressCache.findMany).not.toHaveBeenCalled();
  });
});

describe('pdfColumnWidths', () => {
  it('keeps short columns wide enough for their headers next to a wide address column', () => {
    const cols = columnsFor('POSITIONS');
    const widths = pdfColumnWidths(cols.map((c) => c.width), cols.map((c) => c.header)).map((w) => parseFloat(w));
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 0);
    const content = 842 - 56 - cols.length * 8;
    cols.forEach((c, i) => {
      const longest = Math.max(...c.header.split(/\s+/).map((w) => w.length));
      expect((widths[i] / 100) * content).toBeGreaterThanOrEqual(longest * 4.4);
    });
    expect(widths[cols.findIndex((c) => c.header === 'Address')]).toBeGreaterThan(widths[cols.findIndex((c) => c.header === 'GSM')] * 3);
  });
});
