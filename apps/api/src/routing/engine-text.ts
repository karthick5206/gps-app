/**
 * E4 security review L4: text from a routing engine (GraphHopper error bodies, fetch errors) may carry a request
 * coordinate ("Point 1 is too far from Point 2: 13.0812,80.2654", 5xx bodies echoing the query). Such text never
 * reaches a job error, an API response or a log: the engine clients map every failure to a fixed message, and the
 * places that store or log a message pass it through `scrubCoordinates` as a second line of defence.
 */

/** A lat/lng-looking pair: two decimals separated by a comma, semicolon, slash or spaces ("13.08,80.26", "13.08 80.26"). */
const PAIR = /[-+]?\d{1,3}\.\d+\s*[,;/ ]\s*[-+]?\d{1,3}\.\d+/g;
/** Any lone decimal with 3+ fraction digits (a coordinate on its own, ~100 m or finer). */
const FINE = /[-+]?\d{1,3}\.\d{3,}/g;

export function scrubCoordinates(text: string): string {
  return text.replace(PAIR, '[point]').replace(FINE, '[number]');
}

/** Fixed text for a thrown fetch error: the error class / system code only (never its message, which may hold the URL). */
export function transportErrorText(error: unknown): string {
  const e = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  const code = typeof e?.cause?.code === 'string' ? e.cause.code : typeof e?.code === 'string' ? e.code : null;
  const name = typeof e?.name === 'string' ? e.name : 'Error';
  return /^[A-Z0-9_]{2,40}$/.test(code ?? '') ? `${name} ${code}` : name;
}
