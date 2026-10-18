import type { ThemePreference } from './api';

/**
 * Veetrax mark: a dotted trip line ending in a map pin (64-unit box). Same geometry as the generated assets
 * (scripts/brand/generate.mjs); the apps draw it in the selected theme's colours.
 */
export const BRAND_PIN_PATH =
  'M32 5C20.4 5 11 14.2 11 25.6 11 40.5 32 59 32 59s21-18.5 21-33.4C53 14.2 43.6 5 32 5z M24 25.6a8 8 0 1 0 16 0a8 8 0 1 0-16 0z';
/** Trip dots along the curve M10 54 C26 54 30 46 42 44 (origin dot r=5 at 10,54; these r=2.4). */
export const BRAND_ROUTE_DOTS: readonly (readonly [number, number])[] = [
  [20.06, 52.72],
  [27.5, 49.75],
  [34.19, 46.41],
  [42, 44],
];
/** The pin sits at translate(24 0) scale(0.72) inside the 64 box. */
export const BRAND_PIN_TRANSFORM = 'translate(24 0) scale(0.72)';

export interface BrandColors {
  /** Tile / app-icon background. */
  tile: string;
  /** Pin on the tile. */
  pin: string;
  /** Trip dots. */
  route: string;
  /** Pin and wordmark on a plain light background. */
  ink: string;
  /** Trip dots on a plain light background (darker for contrast). */
  inkRoute: string;
}

/** Logo colours per theme (Teal & Saffron is the brand default). */
export const BRAND_COLORS: Record<ThemePreference, BrandColors> = {
  teal: { tile: '#0E5E57', pin: '#FFFFFF', route: '#FFB443', ink: '#0E5E57', inkRoute: '#E08B00' },
  plum: { tile: '#5B1E78', pin: '#FFFFFF', route: '#FF9ECF', ink: '#5B1E78', inkRoute: '#D9408C' },
  sky: { tile: '#1F4FFF', pin: '#FFFFFF', route: '#FF6B4A', ink: '#1F4FFF', inkRoute: '#E2492A' },
  light: { tile: '#0E5E57', pin: '#FFFFFF', route: '#FFB443', ink: '#0E5E57', inkRoute: '#E08B00' },
  dark: { tile: '#14897E', pin: '#FFFFFF', route: '#FFB443', ink: '#2BB3A3', inkRoute: '#FFB443' },
};

/** The mark on a rounded tile as an SVG string (favicons, image exports). */
export function brandTileSvg(c: BrandColors, size = 64): string {
  const dots = BRAND_ROUTE_DOTS.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.4" fill="${c.route}"/>`).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="15" fill="${c.tile}"/>` +
    `<g transform="translate(5 6) scale(0.84)"><circle cx="10" cy="54" r="5" fill="${c.route}"/>${dots}` +
    `<path transform="${BRAND_PIN_TRANSFORM}" d="${BRAND_PIN_PATH}" fill="${c.pin}" fill-rule="evenodd"/></g></svg>`
  );
}
