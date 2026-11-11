import { selfHostedStyles, type BasemapUrls } from '@veetracer/shared';

/** The `VITE_MAP_STYLE_*` build settings (empty or missing = not set). */
export interface StyleEnv {
  standard?: string;
  light?: string;
  dark?: string;
}

/**
 * Basemap style URLs for every web map, the public share page included (G8). Each configured `VITE_MAP_STYLE_*`
 * wins; an unset one falls back to the self-hosted style on the page's own origin (`<origin>/tiles/styles/…`),
 * never to an outside map host. Pure so it can be unit-tested without Vite's `import.meta.env`.
 */
export function resolveStyleUrls(env: StyleEnv, origin: string): BasemapUrls {
  const own = selfHostedStyles(origin);
  return {
    standard: env.standard?.trim() || own.standard,
    light: env.light?.trim() || own.light,
    dark: env.dark?.trim() || own.dark,
  };
}
