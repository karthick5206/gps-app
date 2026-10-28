/** Google Play listings of the two Android apps (the /download page keeps the APKs for phones without Play). */
export const PLAY_STORE = {
  veetrax: 'https://play.google.com/store/apps/details?id=com.sasvata.veetrax',
  tracker: 'https://play.google.com/store/apps/details?id=com.sasvata.veetrax.tracker',
} as const;

/** `GET /maps/config`: optional basemaps the server has keys for. */
export interface MapsConfigDto {
  /** Satellite imagery raster tiles ({z}/{x}/{y} template incl. key), or null when not configured. */
  satellite: { tiles: string[]; attribution: string; maxZoom: number } | null;
}

/** Basemap choices of the map type switcher (web and mobile). Satellite needs MapsConfigDto.satellite. */
export const BASEMAP_TYPES = ['standard', 'light', 'satellite'] as const;
export type BasemapType = (typeof BASEMAP_TYPES)[number];
