import { POSITION_FLAGS } from '@veetracer/shared';
import type { AuthContext } from '../access/auth-context';
import { PointQualityService } from './point-quality.service';

const OBJ = '1c106195-a934-4466-abee-ed67c3cda415';
const T = Date.UTC(2026, 10, 6, 8, 25, 42);

function setup() {
  const row = { deviceId: 'dev', fixTime: new Date(T), lat: 12.94701, lng: 80.19561, valid: true, flags: POSITION_FLAGS.OUTLIER, attributes: { accuracyM: 77.6 } as Record<string, unknown> };
  const prisma = {
    position: {
      findFirst: jest.fn(async () => ({ ...row, attributes: { ...row.attributes } })),
      update: jest.fn(async ({ data }: { data: Partial<typeof row> }) => Object.assign(row, data)),
    },
    $executeRaw: jest.fn(async () => 1),
  };
  const history = { objectMeta: jest.fn(async () => ({ tz: 'Asia/Kolkata' })) };
  const audit = { record: jest.fn(async () => undefined) };
  const svc = new PointQualityService(prisma as never, history as never, audit as never);
  return { svc, row, prisma, audit };
}

const admin = { userId: 'u1', isSuperAdmin: true } as AuthContext;
const user = { userId: 'u2', isSuperAdmin: false } as AuthContext;

describe('Super Admin: remove / restore one point', () => {
  it('only the Super Admin, and only with a reason', async () => {
    const { svc } = setup();
    await expect(svc.removePoint(user, OBJ, T, 'spike')).rejects.toThrow('Only Super Admin');
    await expect(svc.removePoint(admin, OBJ, T, '  ')).rejects.toThrow('reason');
  });

  it('marks the point invalid (kept, with who / why), recomputes its day and audits; restore puts it back exactly', async () => {
    const { svc, row, prisma, audit } = setup();
    await expect(svc.removePoint(admin, OBJ, T, 'Wi-Fi fix 2.5 km off')).resolves.toEqual({ t: T, removed: true });
    expect(row.valid).toBe(false);
    expect(row.flags & POSITION_FLAGS.INVALID_FIX).toBe(POSITION_FLAGS.INVALID_FIX);
    expect(row.attributes).toMatchObject({ accuracyM: 77.6, removed: { by: 'u1', reason: 'Wi-Fi fix 2.5 km off', valid: true, flags: POSITION_FLAGS.OUTLIER } });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);

    await expect(svc.restorePoint(admin, OBJ, T)).resolves.toEqual({ t: T, removed: false });
    expect(row.valid).toBe(true);
    expect(row.flags).toBe(POSITION_FLAGS.OUTLIER);
    expect(row.attributes).toEqual({ accuracyM: 77.6 });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
  });
});
