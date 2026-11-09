import { DEV_SUPER_ADMIN_PASSWORD, superAdminSeedPassword } from './seed-guards';

describe('superAdminSeedPassword (R-04)', () => {
  it('never changes an existing Super Admin', () => {
    expect(superAdminSeedPassword({ NODE_ENV: 'production', SUPER_ADMIN_PASSWORD: 'x'.repeat(20) }, true)).toBeNull();
    expect(superAdminSeedPassword({}, true)).toBeNull();
  });

  it('development: env password if given, otherwise the documented dev password', () => {
    expect(superAdminSeedPassword({}, false)).toBe(DEV_SUPER_ADMIN_PASSWORD);
    expect(superAdminSeedPassword({ SUPER_ADMIN_PASSWORD: 'Local-Pass-1' }, false)).toBe('Local-Pass-1');
  });

  it('production: requires SUPER_ADMIN_PASSWORD, ≥ 12 characters, not the dev password', () => {
    expect(() => superAdminSeedPassword({ NODE_ENV: 'production' }, false)).toThrow(/SUPER_ADMIN_PASSWORD/);
    expect(() => superAdminSeedPassword({ NODE_ENV: 'production', SUPER_ADMIN_PASSWORD: 'short' }, false)).toThrow(/12/);
    expect(() => superAdminSeedPassword({ NODE_ENV: 'production', SUPER_ADMIN_PASSWORD: DEV_SUPER_ADMIN_PASSWORD }, false)).toThrow();
    expect(superAdminSeedPassword({ NODE_ENV: 'production', SUPER_ADMIN_PASSWORD: '  Strong-Secret-2026  ' }, false)).toBe('Strong-Secret-2026');
  });
});
