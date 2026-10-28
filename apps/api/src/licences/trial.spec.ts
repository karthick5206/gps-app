import { grantTrialSeat } from './trial';

/** Minimal transaction double: one company, an in-memory seat list. */
function fakeTx(accountType: string, seats: { source: string; type: string }[] = []) {
  const created: Record<string, unknown>[] = [];
  const tx = {
    company: { findUnique: async () => ({ accountType }) },
    licenceSeat: {
      count: async ({ where }: { where: { type: { in: string[] } } }) => seats.filter((s) => s.source === 'TRIAL' && where.type.in.includes(s.type)).length,
      create: async ({ data }: { data: Record<string, unknown> }) => (created.push(data), { id: 'seat-1', expiresAt: data.expiresAt }),
    },
  };
  return { tx: tx as never, created };
}

describe('grantTrialSeat', () => {
  it('personal account: 30 days for a GPS tracker, 100 days for a phone', async () => {
    const day = 24 * 3600_000;
    const a = fakeTx('INDIVIDUAL');
    const gps = await grantTrialSeat(a.tx, 'c1', 'GPS_DEVICE', 'd1');
    expect(Math.round((gps!.expiresAt.getTime() - Date.now()) / day)).toBe(30);
    expect(a.created[0]).toMatchObject({ type: 'GPS_DEVICE', source: 'TRIAL', deviceId: 'd1' });
    const phone = await grantTrialSeat(fakeTx('FAMILY').tx, 'c1', 'MOBILE_TRACKER', 'd2');
    expect(Math.round((phone!.expiresAt.getTime() - Date.now()) / day)).toBe(100);
  });

  it('no trial for business accounts, or once 5 devices of that kind used it', async () => {
    expect(await grantTrialSeat(fakeTx('BUSINESS').tx, 'c1', 'GPS_DEVICE', 'd1')).toBeNull();
    const five = Array.from({ length: 5 }, () => ({ source: 'TRIAL', type: 'DASHCAM' }));
    expect(await grantTrialSeat(fakeTx('INDIVIDUAL', five).tx, 'c1', 'GPS_DEVICE', 'd1')).toBeNull();
    // Phones have their own count.
    expect(await grantTrialSeat(fakeTx('INDIVIDUAL', five).tx, 'c1', 'MOBILE_TRACKER', 'd1')).not.toBeNull();
  });
});
