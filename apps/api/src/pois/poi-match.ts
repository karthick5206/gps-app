import { haversineMeters } from '../tracking/geo';

export interface MatchPoi {
  id: string;
  name: string;
  category: string;
  lat: number;
  lng: number;
  radiusM: number;
}

export interface MatchStop {
  objectId: string;
  startTime: Date;
  endTime: Date;
  lat: number;
  lng: number;
  durationSec: number;
  ignitionOn: boolean;
  address: string | null;
}

export interface PoiVisit {
  objectId: string;
  poi: MatchPoi;
  arrival: Date;
  departure: Date;
  durationSec: number;
  distanceM: number;
  ignitionOn: boolean;
  address: string | null;
}

const CELL_DEG = 0.05; // ≈ 5.5 km: larger than the largest POI radius
const cellKey = (lat: number, lng: number) => `${Math.floor(lat / CELL_DEG)}:${Math.floor(lng / CELL_DEG)}`;

/** Grid index of POIs for nearest-within-radius lookups (thousands of stops × thousands of POIs). */
export class PoiIndex {
  private readonly cells = new Map<string, MatchPoi[]>();

  constructor(pois: MatchPoi[]) {
    for (const p of pois) {
      const k = cellKey(p.lat, p.lng);
      const list = this.cells.get(k);
      if (list) list.push(p);
      else this.cells.set(k, [p]);
    }
  }

  /** The closest POI whose radius contains the point, with the distance (m). */
  nearest(lat: number, lng: number): { poi: MatchPoi; distanceM: number } | null {
    const cy = Math.floor(lat / CELL_DEG);
    const cx = Math.floor(lng / CELL_DEG);
    let best: { poi: MatchPoi; distanceM: number } | null = null;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const p of this.cells.get(`${cy + dy}:${cx + dx}`) ?? []) {
          const d = haversineMeters(lat, lng, p.lat, p.lng);
          if (d <= p.radiusM && (!best || d < best.distanceM)) best = { poi: p, distanceM: d };
        }
      }
    }
    return best;
  }
}

/** Two stops at the same POI separated by less than this are one visit (e.g. a short move inside a yard). */
export const VISIT_MERGE_GAP_MS = 10 * 60_000;

/**
 * POI visits from stops: each stop within a POI's radius is a visit of the nearest such POI; consecutive stops of the
 * same vehicle at the same POI less than 10 minutes apart are merged. Stops must be sorted by vehicle, then time.
 */
export function matchStopsToPois(stops: MatchStop[], index: PoiIndex): PoiVisit[] {
  const out: PoiVisit[] = [];
  const last = new Map<string, PoiVisit>();
  for (const s of stops) {
    const hit = index.nearest(s.lat, s.lng);
    if (!hit) {
      last.delete(s.objectId);
      continue;
    }
    const prev = last.get(s.objectId);
    if (prev && prev.poi.id === hit.poi.id && s.startTime.getTime() - prev.departure.getTime() < VISIT_MERGE_GAP_MS) {
      prev.departure = s.endTime;
      prev.durationSec = Math.round((prev.departure.getTime() - prev.arrival.getTime()) / 1000);
      prev.distanceM = Math.min(prev.distanceM, Math.round(hit.distanceM));
      prev.ignitionOn = prev.ignitionOn || s.ignitionOn;
      continue;
    }
    const v: PoiVisit = {
      objectId: s.objectId,
      poi: hit.poi,
      arrival: s.startTime,
      departure: s.endTime,
      durationSec: s.durationSec,
      distanceM: Math.round(hit.distanceM),
      ignitionOn: s.ignitionOn,
      address: s.address,
    };
    out.push(v);
    last.set(s.objectId, v);
  }
  return out;
}
