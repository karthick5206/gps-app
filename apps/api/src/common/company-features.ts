import { COMPANY_FEATURES, type CompanyFeature } from '@veetracer/shared';

/** Add-ons switched on for a company (`settings.features`); the platform company has all of them. */
export function companyFeatures(company: { settings: unknown; isPlatform?: boolean }): CompanyFeature[] {
  if (company.isPlatform) return [...COMPANY_FEATURES];
  const s = company.settings;
  const raw = typeof s === 'object' && s !== null && !Array.isArray(s) ? (s as Record<string, unknown>).features : undefined;
  return Array.isArray(raw) ? COMPANY_FEATURES.filter((f) => raw.includes(f)) : [];
}

/** `settings` with the add-ons replaced (other settings kept). */
export function withFeatures(settings: unknown, features: readonly string[]): Record<string, unknown> {
  const base = typeof settings === 'object' && settings !== null && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {};
  return { ...base, features: COMPANY_FEATURES.filter((f) => features.includes(f)) };
}
