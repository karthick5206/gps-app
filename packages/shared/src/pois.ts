/** Points of interest (customer sites, depots, fuel stations…) and the KML / KMZ / GPX / GeoJSON / CSV import. */
import type { GeofenceGeometry } from './history';

/** Seeded POI_CATEGORY lookup codes (also the fallback list when the caller can't read lookups). */
export const POI_CATEGORIES = ['CUSTOMER', 'DEPOT', 'FUEL_STATION', 'SERVICE_CENTER', 'HOSPITAL', 'SCHOOL', 'TOLL', 'PARKING', 'OTHER'] as const;

/** Default "visited" radius (a stop within this distance of the POI counts as a visit). */
export const POI_DEFAULT_RADIUS_M = 100;
export const POI_MIN_RADIUS_M = 10;
export const POI_MAX_RADIUS_M = 5000;
export const POI_DEFAULT_COLOR = '#2563eb';

/** Import limits: file size (bytes) and number of items in one file. */
export const POI_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const POI_IMPORT_MAX_ITEMS = 5000;

export interface PoiDto {
  id: string;
  name: string;
  category: string; // POI_CATEGORY lookup code
  lat: number;
  lng: number;
  address: string | null;
  radiusM: number;
  icon: string | null;
  color: string;
  description: string | null;
  branchId: string | null;
  branchName: string | null; // null = company-wide
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PoiImportFormat = 'kml' | 'kmz' | 'gpx' | 'geojson' | 'csv';

/** One parsed item of an import file: a POI (point) or a geofence (area), or an error. */
export interface PoiImportItem {
  /** 1-based position in the file. */
  index: number;
  kind: 'POI' | 'GEOFENCE' | null;
  name: string;
  category?: string;
  description?: string;
  color?: string;
  address?: string;
  /** POI */
  lat?: number;
  lng?: number;
  radiusM?: number;
  /** GEOFENCE */
  geometry?: GeofenceGeometry;
  /** Why the item can't be imported (kind is then null). */
  error: string | null;
  /** Non-blocking note, e.g. "polygon simplified to 500 points". */
  warning?: string;
}

export interface PoiImportPreview {
  format: PoiImportFormat;
  items: PoiImportItem[];
  counts: { pois: number; geofences: number; errors: number };
}

export interface PoiImportResult {
  pois: number;
  geofences: number;
  failed: { index: number; name: string; message: string }[];
}

/** POI_VISITS report: a vehicle stopped within a POI's radius. */
export interface PoiVisitReportRow {
  objectId: string; objectName: string; plateNumber: string | null;
  poiId: string; poiName: string; category: string;
  arrival: string; departure: string; durationSec: number;
  /** Distance from the stop to the POI (m). */
  distanceM: number;
  ignitionOn: boolean;
  address: string | null;
}
