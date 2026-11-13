/**
 * UI feature flags: lets visual changes ship dark and be switched on per build or per browser.
 *
 * Sources, applied in order (later wins):
 *  1. Defaults: every flag is ON in development (`vite` dev server) and OFF in production builds.
 *  2. `VITE_UI_FLAGS` at build time: a comma list such as `uiRefresh` (turn on) or `-uiRefresh` (turn off).
 *     Example production build with the refresh enabled: `VITE_UI_FLAGS=uiRefresh npm run build`.
 *  3. `localStorage['vt.flags']` in the browser, same syntax, for testing a build without rebuilding:
 *     `localStorage.setItem('vt.flags', 'uiRefresh')` then reload; `'-uiRefresh'` forces it off; remove the key
 *     to go back to the build's value.
 *
 * Unknown names are ignored. Flags are read once at startup (a reload applies a change).
 * Kept free of Vite-only and DOM-only imports at module level so it runs under `node --test`.
 */

/**
 * uiRefresh: visual refresh. etmsRouting: ETMS route planner (E4 WP 4.5). v1.16: etmsRouting defaults ON in every build;
 * the server decides (ETMS_ROUTING kill switch, the Super Admin's platform switch and the company's own switch), so
 * "if I enable it, it works" without a rebuild. `-etmsRouting` still hides the planner in a build or browser.
 */
export const UI_FLAGS = ['uiRefresh', 'etmsRouting'] as const;

/** Flags that are ON by default in production builds too (server-gated features). */
export const DEFAULT_ON_FLAGS: readonly UiFlag[] = ['etmsRouting'];
export type UiFlag = (typeof UI_FLAGS)[number];
export type UiFlags = Record<UiFlag, boolean>;

export const FLAGS_STORAGE_KEY = 'vt.flags';

/** HTML attribute set on <html> for each flag that is on, e.g. `data-ui-refresh`, so CSS can gate on it. */
export function flagAttribute(flag: UiFlag): string {
  return `data-${flag.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** Applies a comma list (`a,-b, c`) onto `flags`. Returns a new object. */
export function applyFlagList(flags: UiFlags, list: string | null | undefined): UiFlags {
  const next = { ...flags };
  if (!list) return next;
  for (const raw of list.split(',')) {
    const item = raw.trim();
    if (!item) continue;
    const off = item.startsWith('-') || item.startsWith('!');
    const name = (off ? item.slice(1) : item).trim();
    if ((UI_FLAGS as readonly string[]).includes(name)) next[name as UiFlag] = !off;
  }
  return next;
}

/** Resolves flags from the three sources. Pure: everything it needs is passed in. */
export function resolveFlags(input: { dev: boolean; env?: string | null; override?: string | null }): UiFlags {
  const defaults = Object.fromEntries(UI_FLAGS.map((f) => [f, input.dev || DEFAULT_ON_FLAGS.includes(f)])) as UiFlags;
  return applyFlagList(applyFlagList(defaults, input.env), input.override);
}

function readOverride(): string | null {
  try {
    return globalThis.localStorage?.getItem(FLAGS_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

// import.meta.env exists under Vite; under node --test it is undefined, which resolves to production defaults.
const env = (import.meta as { env?: { DEV?: boolean; VITE_UI_FLAGS?: string } }).env;

export const flags: Readonly<UiFlags> = Object.freeze(
  resolveFlags({ dev: env?.DEV === true, env: env?.VITE_UI_FLAGS, override: readOverride() }),
);

export function isEnabled(flag: UiFlag): boolean {
  return flags[flag];
}

/** Mirrors the flags onto <html> as `data-*` attributes (CSS gating). */
export function applyFlagAttributes(root: { toggleAttribute(name: string, force?: boolean): boolean }, values: UiFlags = flags): void {
  for (const f of UI_FLAGS) root.toggleAttribute(flagAttribute(f), values[f]);
}
