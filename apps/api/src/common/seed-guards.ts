/**
 * Seed safety (risk R-04). The documented development password must never become a production Super Admin password,
 * and re-running the seed must never re-activate a user an administrator disabled.
 */
export const DEV_SUPER_ADMIN_PASSWORD = 'Admin@12345';
const MIN_PRODUCTION_PASSWORD = 12;

/**
 * Password for creating the Super Admin, or null when no account must be created. In production it comes only from
 * SUPER_ADMIN_PASSWORD (≥ 12 characters, not the documented dev password); an existing account is never changed.
 */
export function superAdminSeedPassword(env: NodeJS.ProcessEnv, alreadyExists: boolean): string | null {
  if (alreadyExists) return null;
  const fromEnv = env.SUPER_ADMIN_PASSWORD?.trim();
  if (env.NODE_ENV !== 'production') return fromEnv || DEV_SUPER_ADMIN_PASSWORD;
  if (!fromEnv) throw new Error('NODE_ENV=production: set SUPER_ADMIN_PASSWORD (at least 12 characters) to create the Super Admin');
  if (fromEnv.length < MIN_PRODUCTION_PASSWORD) throw new Error(`SUPER_ADMIN_PASSWORD must be at least ${MIN_PRODUCTION_PASSWORD} characters`);
  if (fromEnv === DEV_SUPER_ADMIN_PASSWORD) throw new Error('SUPER_ADMIN_PASSWORD must not be the documented development password');
  return fromEnv;
}
