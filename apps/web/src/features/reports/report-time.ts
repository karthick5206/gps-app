/**
 * Report timestamps in the company time zone (D-1). Report periods, exports and schedules already use the company
 * zone; on screen the rows used the browser's zone without saying so. Pure (Intl only) so node --test can run it.
 */

/** Short names browsers don't give for some zones (Intl returns "GMT+5:30" for Asia/Kolkata in most locales). */
const KNOWN_ABBREVIATIONS: Record<string, string> = {
  'Asia/Kolkata': 'IST',
  'Asia/Calcutta': 'IST',
  'Asia/Dubai': 'GST',
  'Asia/Singapore': 'SGT',
  'Asia/Dhaka': 'BST',
  'Asia/Kathmandu': 'NPT',
  'Asia/Colombo': 'IST',
  'Asia/Karachi': 'PKT',
  'Asia/Riyadh': 'AST',
  'Asia/Jakarta': 'WIB',
  'Asia/Kuala_Lumpur': 'MYT',
  'Africa/Nairobi': 'EAT',
  'Africa/Lagos': 'WAT',
  'Africa/Johannesburg': 'SAST',
  UTC: 'UTC',
  'Etc/UTC': 'UTC',
};

let zone: string | undefined;
let locale: string | undefined;

/** The zone report cells are shown in (the company's); undefined = browser zone (before login). */
export function setReportTimeZone(tz: string | undefined | null): void {
  zone = tz && isValidZone(tz) ? tz : undefined;
}

export function getReportTimeZone(): string | undefined {
  return zone;
}

export function setReportLocale(value: string | undefined): void {
  locale = value;
}

export function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Abbreviation for a zone at an instant: "IST", "GST", "EST"/"EDT" (DST-aware via Intl), else "GMT+5:45".
 */
export function zoneAbbreviation(tz: string, at: Date = new Date()): string {
  if (KNOWN_ABBREVIATIONS[tz]) return KNOWN_ABBREVIATIONS[tz];
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(at).find((p) => p.type === 'timeZoneName');
    return part?.value ?? tz;
  } catch {
    return tz;
  }
}

/** Label used in column headers: "IST" for the current report zone, or '' when none is set. */
export function reportZoneLabel(at: Date = new Date()): string {
  return zone ? zoneAbbreviation(zone, at) : '';
}

/** "09 Nov 2026, 04:30:00 pm" in the report zone (or `tz`), same fields as formatDateTime. */
export function formatReportTime(iso: string | null | undefined, tz: string | undefined = zone): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    ...(tz ? { timeZone: tz } : {}),
  });
}

/** Calendar day (YYYY-MM-DD) of an instant in the report zone: groups rows by the company's days. */
export function dayKeyInZone(iso: string | number | Date, tz: string | undefined = zone): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...(tz ? { timeZone: tz } : {}) }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Today's date (YYYY-MM-DD) in `tz` (default: report zone, else browser). */
export function todayInZone(tz: string | undefined = zone, now: Date = new Date()): string {
  return dayKeyInZone(now, tz);
}
