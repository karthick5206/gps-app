/**
 * C3 kit: guard for the TypeScript helpers (run with tsx from apps/api). The bash entry scripts run lib/guard.sh
 * first; a helper started on its own refuses unless that guard passed (C3_GUARD_PASSED) and re-checks every URL it is
 * given against the production list (defence in depth).
 */
const PROD_HOST = /(^|\.)veetrax\.com\.?$/i;
const PROD_IPS = new Set(['103.176.85.69']);

export function hostOf(u: string): string {
  try {
    return new URL(u.includes('://') ? u : `http://${u}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

export function isProduction(u: string): boolean {
  const h = hostOf(u);
  return PROD_HOST.test(h) || PROD_IPS.has(h);
}

/** Exit 3 unless the bash guard passed; refuses production URLs. Returns true in a dry run. */
export function c3Guard(urls: (string | undefined)[]): boolean {
  if (!process.env.C3_GUARD_PASSED) {
    console.error('C3 GUARD REFUSED: run this helper through its ops/benchmarks/c3/*.sh script (lib/guard.sh).');
    process.exit(3);
  }
  for (const u of urls) {
    if (u && isProduction(u)) {
      console.error(`C3 GUARD REFUSED: ${hostOf(u)} is production.`);
      process.exit(3);
    }
  }
  return process.env.C3_DRY === '1' || process.argv.includes('--dry-run');
}

export function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

export function pct(values: number[], p: number): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
