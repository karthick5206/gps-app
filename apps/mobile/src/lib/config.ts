/** Server the app talks to. Override per build with EXPO_PUBLIC_SERVER_URL (e.g. in .env.local). */
export const SERVER_URL = (process.env.EXPO_PUBLIC_SERVER_URL || 'https://gps.mintplus.co.in').replace(/\/+$/, '');

export const API_URL = `${SERVER_URL}/api`;

/** Basemaps: the same OpenFreeMap styles as the web map. */
export const MAP_STYLE = {
  standard: process.env.EXPO_PUBLIC_MAP_STYLE_STANDARD || 'https://tiles.openfreemap.org/styles/liberty',
  light: process.env.EXPO_PUBLIC_MAP_STYLE_LIGHT || 'https://tiles.openfreemap.org/styles/positron',
  dark: process.env.EXPO_PUBLIC_MAP_STYLE_DARK || 'https://tiles.openfreemap.org/styles/dark',
} as const;

/**
 * Self-hosted basemap styles ONLY ("nothing leaves the server", gate G8): the build's EXPO_PUBLIC_MAP_STYLE_* values
 * with no third-party fallback. Employee-transport screens (passenger and driver) use these; when a build does not set
 * them, those screens show text instead of a map rather than loading OpenFreeMap tiles. Each variable is read by its
 * full name so Expo inlines it at build time.
 */
export const SELF_HOSTED_MAP_STYLE = {
  standard: process.env.EXPO_PUBLIC_MAP_STYLE_STANDARD || null,
  light: process.env.EXPO_PUBLIC_MAP_STYLE_LIGHT || null,
  dark: process.env.EXPO_PUBLIC_MAP_STYLE_DARK || null,
} as const;
