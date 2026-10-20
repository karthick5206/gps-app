import { RecentAttributeDto } from '@veetracer/shared';

/** Keys that are never sensor inputs (location / network / bookkeeping): left out of the picker. */
const SKIP = new Set(['mcc', 'mnc', 'lac', 'cellId', 'raw', 'event', 'alarm', 'reupload', 'iccid', 'driverId', 'rfid', 'commandResponse', 'ac', 'doorOpen', 'fuelL', 'fuelPct']);

/** Newest value, last time and count per attribute key over positions sorted newest first. */
export function recentAttributes(rows: { fixTime: Date; attributes: unknown }[]): RecentAttributeDto[] {
  const out = new Map<string, RecentAttributeDto>();
  for (const r of rows) {
    const attrs = r.attributes && typeof r.attributes === 'object' && !Array.isArray(r.attributes) ? (r.attributes as Record<string, unknown>) : {};
    for (const [key, value] of Object.entries(attrs)) {
      if (SKIP.has(key) || !(typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string')) continue;
      const seen = out.get(key);
      if (seen) seen.count++;
      else out.set(key, { key, value, at: r.fixTime.toISOString(), count: 1 });
    }
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}
