import { ETMS_DRIVER_ROLE_NAME } from '@veetracer/shared';
import type { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { sha256 } from '../../common/secrets';
import { DriversService } from '../../drivers/drivers.service';
import { privateGeocoderProblem } from '../../geocoding/geocoding.service';
import { ensureEtmsRoleTemplates } from '../etms-role-templates';
import { MemoryStore } from '../testing/memory-store';
import { FleetLinksService } from './fleet-links.service';
import { IDENTITY_IN_USE_MESSAGE } from './identity-link';

/**
 * E2 security review, driver side and shared helpers: M1 (driver login password only before the first sign-in, then a
 * reset token; sessions revoked and G5 published on every credential change / disable), L1 (generic IDENTITY_IN_USE),
 * L3 (a deactivated or deleted driver's login stops working), L11 (self-hosted geocoder only). Runs on the in-memory
 * Prisma stand-in used by the isolation matrix.
 */
type Obj = Record<string, unknown>;

const admin = { userId: 'admin', homeCompanyId: 'c1', companyId: 'c1', isSuperAdmin: false, isCompanyAdmin: true, permissions: { drivers: ['view', 'edit', 'delete'] }, dataScope: 'COMPANY', branchIds: [], objectIds: [], ip: '10.0.0.9', agreements: [] } as unknown as AuthContext;

async function setup() {
  const store = new MemoryStore();
  store.insert('company', { id: 'c1', name: 'Corp', timezone: 'Asia/Kolkata', settings: { features: ['etms'] } });
  store.insert('company', { id: 'c2', name: 'Other', timezone: 'Asia/Kolkata', settings: { features: ['etms'] } });
  const prisma = store.client();
  await ensureEtmsRoleTemplates(prisma as never, 'c1');
  const published: Obj[] = [];
  const redis = {
    invalidateCache: async () => undefined,
    client: { publish: async (_c: string, m: string) => published.push(JSON.parse(m) as Obj), get: async () => null, incr: async () => 1, expire: async () => 1 },
  };
  const audit = new AuditService(prisma as never);
  const fleet = new FleetLinksService(prisma as never, audit, redis as never);
  const drivers = new DriversService(prisma as never, audit, redis as never);
  const driver = store.insert('driver', { companyId: 'c1', branchId: null, name: 'Ravi Kumar', mobile: '+919800000011', employeeId: null, licenseNo: null, licenseExpiry: null, rfidTag: null, notes: null, isActive: true, userId: null, assignments: [] });
  const user = () => store.table('user').find((u) => u.id === store.table('driver')[0]?.userId) ?? store.table('user')[0];
  const audits = (what: string) => store.table('auditLog').filter((a) => (a.changes as Obj | null)?.what === what);
  const session = (userId: string) => store.insert('session', { userId, revokedAt: null, expiresAt: new Date(Date.now() + 86_400_000) });
  return { store, fleet, drivers, driverId: driver.id as string, published, user, audits, session };
}

describe('driver login: M1 password only before the first sign-in, then a reset token', () => {
  it('sets a password at creation; once used, 409 PASSWORD_RESET_REQUIRED; the reset token is one-time and audited', async () => {
    const w = await setup();
    expect((await w.fleet.grantDriverLogin(admin, w.driverId, { password: 'first1234' })).outcome).toBe('CREATED');
    const u = w.user();
    u.lastLoginAt = new Date();
    const hash = u.passwordHash;
    await expect(w.fleet.grantDriverLogin(admin, w.driverId, { password: 'takeover1' })).rejects.toMatchObject({ response: { code: 'PASSWORD_RESET_REQUIRED' } });
    expect(u.passwordHash).toBe(hash);
    const reset = await w.fleet.issueDriverLoginReset(admin, w.driverId);
    expect(reset.path).toBe(`/reset-password?token=${encodeURIComponent(reset.token)}`);
    expect(w.store.table('passwordReset')).toEqual([expect.objectContaining({ userId: u.id, tokenHash: sha256(reset.token) })]);
    const again = await w.fleet.issueDriverLoginReset(admin, w.driverId);
    expect(w.store.table('passwordReset').filter((r) => r.usedAt == null).map((r) => r.tokenHash)).toEqual([sha256(again.token)]);
    expect(w.audits('driver-login-reset-issued')).toHaveLength(2);
  });

  it('a password change before the first sign-in and every disable / unlink revoke the sessions and publish G5', async () => {
    const w = await setup();
    await w.fleet.grantDriverLogin(admin, w.driverId, {});
    const userId = w.user().id as string;
    const s1 = w.session(userId);
    await w.fleet.grantDriverLogin(admin, w.driverId, { password: 'chosen123' });
    expect(s1.revokedAt).toBeInstanceOf(Date);
    expect(w.published).toContainEqual(expect.objectContaining({ userId }));
    for (const mode of ['disable', 'unlink'] as const) {
      w.published.length = 0;
      const s = w.session(userId);
      if (mode === 'unlink') await w.fleet.grantDriverLogin(admin, w.driverId, {}); // enable again first (ETMS disabled it)
      await w.fleet.revokeDriverLogin(admin, w.driverId, mode);
      expect(s.revokedAt).toBeInstanceOf(Date);
      expect(w.published).toContainEqual(expect.objectContaining({ userId }));
    }
  });

  it('QA B1 (probe5): a driver with a login is never relinked silently to another email; the password is not replaced', async () => {
    const w = await setup();
    await w.fleet.grantDriverLogin(admin, w.driverId, { email: 'ravi.a@corp.test', password: 'first1234' });
    const u = w.user();
    const hash = u.passwordHash;
    await expect(w.fleet.grantDriverLogin(admin, w.driverId, { email: 'ravi.b@corp.test', password: 'other1234' })).rejects.toMatchObject({ response: { code: 'LOGIN_ALREADY_LINKED' } });
    await expect(w.fleet.grantDriverLogin(admin, w.driverId, { password: 'other1234' })).rejects.toMatchObject({ response: { code: 'PASSWORD_RESET_REQUIRED' } });
    expect(u).toMatchObject({ email: 'ravi.a@corp.test', passwordHash: hash });
    expect(w.store.table('user')).toHaveLength(1);
    expect((await w.fleet.grantDriverLogin(admin, w.driverId, {})).outcome).toBe('LINKED');
    expect(w.audits('driver-login').at(-1)).toMatchObject({ changes: expect.objectContaining({ passwordChanged: false }) });
  });

  it('IDENTITY_IN_USE is generic and audited with the contacts masked', async () => {
    const w = await setup();
    w.store.insert('user', { companyId: 'c2', name: 'Elsewhere', email: null, mobile: '+919800000011' });
    await expect(w.fleet.grantDriverLogin(admin, w.driverId, {})).rejects.toMatchObject({ response: { code: 'IDENTITY_IN_USE', message: IDENTITY_IN_USE_MESSAGE } });
    expect(w.audits('driver-login-refused')).toEqual([expect.objectContaining({ companyId: 'c1', entity: 'Driver', changes: expect.objectContaining({ mobile: '+91•••••00011' }) })]);
  });
});

describe('L3: a deactivated or deleted driver’s login stops working', () => {
  it('deactivating the driver disables the login (sessions revoked, G5, audited); reactivating allows enabling it again', async () => {
    const w = await setup();
    await w.fleet.grantDriverLogin(admin, w.driverId, {});
    const u = w.user();
    const s = w.session(u.id as string);
    await w.drivers.update(admin, w.driverId, { isActive: false });
    expect(u.isActive).toBe(false);
    expect(s.revokedAt).toBeInstanceOf(Date);
    expect(w.published).toContainEqual(expect.objectContaining({ userId: u.id }));
    expect(w.audits('driver-deactivated')).toEqual([expect.objectContaining({ changes: expect.objectContaining({ outcome: 'DEACTIVATED', driverId: w.driverId }) })]);
    await w.drivers.update(admin, w.driverId, { isActive: true });
    expect((await w.fleet.grantDriverLogin(admin, w.driverId, {})).outcome).toBe('REACTIVATED');
  });

  it('deleting the driver disables the login first; a dual-role login only loses the driver role', async () => {
    const w = await setup();
    await w.fleet.grantDriverLogin(admin, w.driverId, {});
    const u = w.user();
    await w.drivers.remove(admin, w.driverId);
    expect(w.store.table('driver')).toHaveLength(0);
    expect(u.isActive).toBe(false);
    expect(w.audits('driver-removed')).toHaveLength(1);
    // Dual role: a fleet user who is also a driver keeps the fleet login.
    const role = w.store.table('role').find((r) => r.companyId === 'c1' && r.name === ETMS_DRIVER_ROLE_NAME)!;
    const fleetRole = w.store.insert('role', { companyId: 'c1', name: 'Manager', dataScope: 'COMPANY', permissions: [] });
    const fleetUser = w.store.insert('user', { companyId: 'c1', name: 'Mala', email: 'mala@corp.test' });
    w.store.table('userRole').push({ userId: fleetUser.id, roleId: fleetRole.id }, { userId: fleetUser.id, roleId: role.id });
    const d2 = w.store.insert('driver', { companyId: 'c1', branchId: null, name: 'Mala', mobile: null, isActive: true, userId: fleetUser.id, assignments: [] });
    await w.drivers.remove(admin, d2.id as string);
    expect(fleetUser.isActive).toBe(true);
    expect(w.store.table('userRole').filter((r) => r.userId === fleetUser.id).map((r) => r.roleId)).toEqual([fleetRole.id]);
  });
});

describe('L11: addresses only go to a self-hosted geocoder', () => {
  it.each([
    [{ GEOCODER: 'photon', GEOCODER_URL: 'http://127.0.0.1:2322' }, null],
    [{ GEOCODER: 'photon', GEOCODER_URL: 'http://photon:2322' }, null],
    [{ GEOCODER: 'photon', GEOCODER_URL: 'http://10.0.0.5:2322' }, null],
    [{ GEOCODER: 'none', GEOCODER_URL: 'https://photon.komoot.io' }, null],
    [{ GEOCODER: 'photon', GEOCODER_URL: '' }, null],
    [{ GEOCODER: 'photon', GEOCODER_URL: 'https://photon.komoot.io' }, 'not a loopback or private host'],
    [{ GEOCODER: 'photon', GEOCODER_URL: 'http://8.8.8.8:2322' }, 'not a loopback or private host'],
    [{ GEOCODER: 'photon', GEOCODER_URL: 'not a url' }, 'not a valid URL'],
  ])('%o → %s', (env, problem) => {
    const got = privateGeocoderProblem(env as NodeJS.ProcessEnv);
    if (problem === null) expect(got).toBeNull();
    else expect(got).toContain(problem);
  });
});
