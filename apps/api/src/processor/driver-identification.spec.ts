import type { PrismaClient } from '@prisma/client';
import type { NormalizedPosition } from '@veetracer/shared';
import { endRfidSession, switchDriver } from '../drivers/driver-sessions';
import type { ObjectMeta } from '../tracking/live-object';
import { DriverIdentification } from './driver-identification';

jest.mock('../drivers/driver-sessions', () => ({ switchDriver: jest.fn().mockResolvedValue(true), endRfidSession: jest.fn().mockResolvedValue(true) }));

const meta = (p: Partial<ObjectMeta> = {}): ObjectMeta => ({
  objectId: 'o1', companyId: 'c1', branchId: null, name: 'Truck 01', plateNumber: null, type: 'VEHICLE', vehicleType: 'TRUCK',
  deviceId: 'dev1', uniqueId: '123', speedLimitKph: 80, driverId: null, driverName: null, driverSource: null, ...p,
});
const pos = (attributes: Record<string, unknown>, ignition: boolean | null = true): NormalizedPosition =>
  ({ uniqueId: '123', protocol: 'teltonika', fixTime: '2026-10-18T06:00:00.000Z', receivedAt: '2026-10-18T06:00:01.000Z', lat: 13, lng: 80, speedKph: 0, course: 0, altitude: 0, satellites: 8, valid: true, ignition, attributes }) as NormalizedPosition;

describe('DriverIdentification', () => {
  const findUnique = jest.fn();
  const prisma = { driver: { findUnique } } as unknown as PrismaClient;
  beforeEach(() => jest.clearAllMocks());

  it('starts an RFID session for a known tag and updates the live meta', async () => {
    findUnique.mockResolvedValue({ id: 'd1', name: 'Arun', isActive: true });
    const m = meta();
    const ids = new DriverIdentification(prisma);
    await ids.apply(m, pos({ driverId: '00ab12' }));
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { companyId_rfidTag: { companyId: 'c1', rfidTag: 'AB12' } } }));
    expect(switchDriver).toHaveBeenCalledWith(prisma, expect.objectContaining({ objectId: 'o1', driverId: 'd1', source: 'RFID' }));
    expect(m).toMatchObject({ driverId: 'd1', driverName: 'Arun', driverSource: 'RFID' });

    await ids.apply(m, pos({ driverId: 'AB12' })); // same driver again: cached lookup, no new session
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(switchDriver).toHaveBeenCalledTimes(1);
  });

  it('ignores unknown tags and inactive drivers', async () => {
    findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'd2', name: 'X', isActive: false });
    const ids = new DriverIdentification(prisma);
    await ids.apply(meta(), pos({ driverId: '1' }));
    await ids.apply(meta(), pos({ driverId: '2' }));
    expect(switchDriver).not.toHaveBeenCalled();
  });

  it('ends an RFID session at ignition off but keeps manual assignments', async () => {
    const ids = new DriverIdentification(prisma);
    const rfid = meta({ driverId: 'd1', driverName: 'Arun', driverSource: 'RFID' });
    await ids.apply(rfid, pos({}, false));
    expect(endRfidSession).toHaveBeenCalledWith(prisma, 'o1', new Date('2026-10-18T06:00:00.000Z'));
    expect(rfid.driverId).toBeNull();

    const manual = meta({ driverId: 'd1', driverName: 'Arun', driverSource: 'MANUAL' });
    await ids.apply(manual, pos({}, false));
    expect(endRfidSession).toHaveBeenCalledTimes(1);
    expect(manual.driverId).toBe('d1');
  });
});
