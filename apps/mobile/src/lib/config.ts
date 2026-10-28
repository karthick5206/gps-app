/** Server the app talks to. Override per build with EXPO_PUBLIC_SERVER_URL (e.g. in .env.local). */
export const SERVER_URL = (process.env.EXPO_PUBLIC_SERVER_URL || 'https://gps.mintplus.co.in').replace(/\/+$/, '');

export const API_URL = `${SERVER_URL}/api`;

/** Basemaps: the same OpenFreeMap styles as the web map. */
export const MAP_STYLE = {
  standard: process.env.EXPO_PUBLIC_MAP_STYLE_STANDARD || 'https://tiles.openfreemap.org/styles/liberty',
  light: process.env.EXPO_PUBLIC_MAP_STYLE_LIGHT || 'https://tiles.openfreemap.org/styles/positron',
  dark: process.env.EXPO_PUBLIC_MAP_STYLE_DARK || 'https://tiles.openfreemap.org/styles/dark',
} as const;
