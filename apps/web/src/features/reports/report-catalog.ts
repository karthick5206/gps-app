/**
 * Report catalogue search, favourites and recents (RP-1). Pure so node --test can run it; the page passes the
 * catalogue entries (label / group / description from report-columns) and keeps the lists in localStorage.
 */

export interface CatalogEntry {
  type: string;
  label: string;
  category: string;
  description: string;
}

/** Extra words people search with (vocabulary the labels don't use). */
export const REPORT_KEYWORDS: Record<string, string[]> = {
  SUMMARY: ['daily', 'weekly', 'monthly', 'utilisation', 'utilization', 'km', 'kilometres', 'running', 'idle', 'overview'],
  CONSOLIDATED: ['per vehicle', 'fleet', 'compare', 'whole period', 'alerts', 'geofence', 'overview'],
  DISTANCE: ['km', 'kilometres', 'mileage', 'odometer', 'travelled', 'offline'],
  ENGINE_HOURS: ['engine', 'hours', 'idle', 'idling', 'usage', 'runtime', 'utilisation'],
  TRIPS: ['journey', 'route', 'start', 'end', 'from', 'to', 'drive'],
  STOPS: ['parked', 'parking', 'stoppage', 'idle', 'stand'],
  HALT: ['halt', 'parked', 'parking', 'stoppage', 'engine off', 'long stop'],
  POSITIONS: ['raw', 'gps', 'points', 'track', 'log', 'packets', 'voltage', 'battery'],
  IDLE: ['idling', 'engine on', 'fuel waste', 'stationary'],
  OVERSPEED: ['speed', 'speeding', 'over speed', 'fast', 'limit', 'violation', 'safety'],
  CONTINUOUS_DRIVING: ['fatigue', 'break', 'rest', 'driving hours', 'speed', 'safety', 'long drive'],
  DRIVERS: ['driver', 'rfid', 'card', 'ibutton', 'assignment', 'performance'],
  IGNITION: ['ignition', 'acc', 'engine', 'on off', 'start stop'],
  ALERTS: ['alarm', 'events', 'notifications', 'sos', 'violations', 'severity'],
  EVENT_SUMMARY: ['alarm', 'events', 'count', 'heatmap', 'violations', 'by type'],
  GEOFENCE_VISITS: ['zone', 'fence', 'area', 'entry', 'exit', 'site'],
  GEOFENCE_SUMMARY: ['zone', 'fence', 'area', 'visits', 'time inside', 'site'],
  GEOFENCE_DISTANCE: ['zone', 'fence', 'km between', 'travel', 'out to in', 'site to site'],
  POI_VISITS: ['poi', 'place', 'customer', 'landmark', 'arrival', 'departure', 'site'],
  FUEL: ['fuel', 'diesel', 'petrol', 'sensor', 'level', 'consumption', 'km/l', 'mileage'],
  FUEL_EVENTS: ['fuel', 'theft', 'pilferage', 'refill', 'drain', 'diesel'],
  MILEAGE: ['fuel', 'km/l', 'kmpl', 'efficiency', 'cost per km', 'fill-up', 'expenses'],
  AC_DOOR: ['ac', 'air conditioner', 'door', 'sensor', 'digital input', 'io'],
  AC_DOOR_DAILY: ['ac', 'air conditioner', 'door', 'sensor', 'daily', 'io'],
  DEVICE_STATUS: ['device', 'tracker', 'offline', 'inactive', 'not working', 'gps', 'health', 'imei'],
  DOCUMENTS: ['documents', 'insurance', 'permit', 'fitness', 'pollution', 'puc', 'rc', 'service', 'renewal', 'expiry', 'compliance'],
  ATTENDANCE_DAILY: ['attendance', 'staff', 'employee', 'check in', 'punch', 'selfie', 'late'],
  ATTENDANCE_SUMMARY: ['attendance', 'staff', 'employee', 'present', 'absent', 'monthly'],
  ATTENDANCE_PAYROLL: ['attendance', 'salary', 'payroll', 'lop', 'payable days', 'overtime'],
  ATTENDANCE_OUTINGS: ['attendance', 'outside', 'outing', 'left site', 'personal'],
  ATTENDANCE_CORRECTIONS: ['attendance', 'corrections', 'manual', 'changed', 'audit'],
  TRIP_PERFORMANCE: ['route', 'planned trip', 'schedule', 'on time', 'punctuality', 'delay', 'late', 'skipped stop', 'deviation', 'bus', 'driver', 'performance'],
  PLANNED_TRIPS: ['route', 'planned trip', 'schedule', 'timetable', 'delay', 'late', 'stops', 'skipped', 'deviation', 'bus', 'trip log'],
};

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Entries matching every word of `query` (in label, group, description or keywords; English and translated text),
 * best first: label starts with the query, label contains it, keyword, group, description. Empty query = all.
 */
export function searchCatalog<T extends CatalogEntry>(entries: readonly T[], query: string, translate: (s: string) => string = (s) => s): T[] {
  const q = normalizeText(query);
  if (!q) return [...entries];
  const words = q.split(' ');
  const scored: { e: T; score: number; i: number }[] = [];
  entries.forEach((e, i) => {
    const label = normalizeText(`${e.label} ${translate(e.label)}`);
    const category = normalizeText(`${e.category} ${translate(e.category)}`);
    const description = normalizeText(`${e.description} ${translate(e.description)}`);
    const keywords = normalizeText((REPORT_KEYWORDS[e.type] ?? []).join(' | '));
    const haystack = `${label} | ${category} | ${description} | ${keywords} | ${e.type.toLowerCase().replace(/_/g, ' ')}`;
    if (!words.every((w) => haystack.includes(w))) return;
    const score =
      (label.startsWith(q) || normalizeText(translate(e.label)).startsWith(q) ? 100 : 0) +
      (label.includes(q) ? 50 : 0) +
      (keywords.includes(q) ? 30 : 0) +
      (category.includes(q) ? 20 : 0) +
      (description.includes(q) ? 10 : 0);
    scored.push({ e, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((s) => s.e);
}

export function toggleFavourite(list: readonly string[], type: string): string[] {
  return list.includes(type) ? list.filter((t) => t !== type) : [...list, type];
}

export interface RecentReport {
  type: string;
  from: string;
  to: string;
}

export const MAX_RECENTS = 5;

/** Most recent first, one entry per report type, at most MAX_RECENTS. */
export function pushRecent(list: readonly RecentReport[], entry: RecentReport, max = MAX_RECENTS): RecentReport[] {
  return [entry, ...list.filter((r) => r.type !== entry.type)].slice(0, max);
}

/** Drops unknown types and malformed entries read back from storage. */
export function cleanRecents(raw: unknown, known: readonly string[]): RecentReport[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is RecentReport => !!r && typeof r === 'object' && known.includes((r as RecentReport).type) && /^\d{4}-\d{2}-\d{2}$/.test(String((r as RecentReport).from)) && /^\d{4}-\d{2}-\d{2}$/.test(String((r as RecentReport).to)))
    .slice(0, MAX_RECENTS);
}

export function cleanFavourites(raw: unknown, known: readonly string[]): string[] {
  return Array.isArray(raw) ? [...new Set(raw.filter((t): t is string => typeof t === 'string' && known.includes(t)))] : [];
}
