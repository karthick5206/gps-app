import { BadRequestException } from '@nestjs/common';
import { AuthContext } from '../access/auth-context';
import { LiveStateService } from '../live/live-state.service';
import { PrismaService } from '../prisma/prisma.service';
import { buildOpenApi } from './openapi';
import { PublicApiService } from './public-api.service';
import { decodeCursor, encodeCursor, page, parseRange } from './v1-query';

const ctx = { companyId: 'c1', dataScope: 'COMPANY', branchIds: [], objectIds: [] } as unknown as AuthContext;
const OID = '44444444-4444-4444-4444-444444444444';

/** 12 positions, two of them sharing a fix time (device swap), queried like Prisma would. */
function fakePositions() {
  const base = Date.UTC(2026, 9, 19, 8);
  const rows = Array.from({ length: 12 }, (_, i) => ({
    objectId: OID,
    deviceId: i === 6 ? 'dev-b' : 'dev-a',
    fixTime: new Date(base + (i === 6 ? 5 : i) * 60_000),
    serverTime: new Date(base + i * 60_000),
    lat: 13 + i / 1000,
    lng: 80,
    speedKph: 10,
    course: 0,
    altitude: null,
    satellites: 8,
    valid: true,
    ignition: true,
    attributes: { fuelL: 40 },
  }));
  const sorted = [...rows].sort((a, b) => a.fixTime.getTime() - b.fixTime.getTime() || a.deviceId.localeCompare(b.deviceId));
  const findMany = jest.fn(async (args: { where: { AND: [{ fixTime: { gte: Date; lte: Date } }, { OR?: [{ fixTime: { gt: Date } }, { fixTime: Date; deviceId: { gt: string } }] }] }; take: number }) => {
    const [range, after] = args.where.AND;
    return sorted
      .filter((r) => r.fixTime >= range.fixTime.gte && r.fixTime <= range.fixTime.lte)
      .filter((r) => {
        if (!after.OR) return true;
        const [gt, tie] = after.OR;
        return r.fixTime > gt.fixTime.gt || (r.fixTime.getTime() === tie.fixTime.getTime() && r.deviceId > tie.deviceId.gt);
      })
      .slice(0, args.take);
  });
  const prisma = {
    trackedObject: { findFirst: jest.fn(async () => ({ id: OID, name: 'Truck', company: { retentionDays: 90 } })) },
    position: { findMany },
  };
  return { prisma, sorted, base };
}

describe('public API pagination', () => {
  it('cursor round-trips and rejects garbage', () => {
    const c = { t: 1760860800000, id: 'dev-a' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(undefined)).toBeNull();
    expect(() => decodeCursor('not-a-cursor')).toThrow(BadRequestException);
    expect(() => decodeCursor(Buffer.from('[1,2,3]').toString('base64url'))).toThrow(BadRequestException);
  });

  it('page() returns a next cursor only when more rows exist', () => {
    expect(page([1, 2, 3], 2, (n) => ({ t: n, id: String(n) })).nextCursor).toBe(encodeCursor({ t: 2, id: '2' }));
    expect(page([1, 2], 2, (n) => ({ t: n, id: String(n) })).nextCursor).toBeNull();
  });

  it('validates ranges (positions: max 7 days)', () => {
    expect(() => parseRange(undefined, '2026-10-19T00:00:00Z', 7)).toThrow(/required/);
    expect(() => parseRange('2026-10-19T00:00:00Z', '2026-10-18T00:00:00Z', 7)).toThrow(/after/);
    expect(() => parseRange('2026-10-01T00:00:00Z', '2026-10-09T00:00:00Z', 7)).toThrow(/7 days/);
  });

  it('walks every position exactly once across pages, including equal fix times', async () => {
    const { prisma, sorted, base } = fakePositions();
    const svc = new PublicApiService(prisma as unknown as PrismaService, {} as LiveStateService);
    const q = { from: new Date(base).toISOString(), to: new Date(base + 3600_000).toISOString(), limit: 5 };
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await svc.positions(ctx, OID, { ...q, cursor });
      seen.push(...(r.data as { time: string }[]).map((p) => p.time));
      cursor = r.meta.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(sorted.map((r) => r.fixTime.toISOString()));
    expect(prisma.position.findMany.mock.calls[0][0].take).toBe(6);
  });

  it('caps the page size at 5000', async () => {
    const { prisma, base } = fakePositions();
    const svc = new PublicApiService(prisma as unknown as PrismaService, {} as LiveStateService);
    await svc.positions(ctx, OID, { from: new Date(base).toISOString(), to: new Date(base + 3600_000).toISOString(), limit: 999_999 });
    expect(prisma.position.findMany.mock.calls[0][0].take).toBe(5001);
  });
});

describe('OpenAPI document', () => {
  it('describes every v1 route with bearer auth', () => {
    const doc = buildOpenApi() as { openapi: string; paths: Record<string, Record<string, unknown>> };
    expect(doc.openapi).toBe('3.0.3');
    expect(Object.keys(doc.paths).sort()).toEqual(
      ['/v1/alerts', '/v1/reports/{type}', '/v1/stops', '/v1/trips', '/v1/vehicles', '/v1/vehicles/live', '/v1/vehicles/{id}/commands', '/v1/vehicles/{id}/positions', '/v1/webhooks', '/v1/webhooks/{id}'].sort(),
    );
    expect(JSON.stringify(doc)).toContain('"scheme":"bearer"');
  });
});
