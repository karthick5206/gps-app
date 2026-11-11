/**
 * Driver navigation hand-off (doc 09 §5.2; owner decision L6, still OPEN). Pure, `node --test`.
 *
 * Under O9 the default is NO external hand-off of passenger or driver location: the setting that enables it is off
 * by default (nav-setting.ts) and this builder is only used when the driver has switched it on. The intent is a
 * coordinate-only `geo:` URI, which lets the driver pick any installed navigation app (Google Maps, OsmAnd, Organic
 * Maps…). The label is a neutral stop label ("Stop 3"): never a passenger name, never an address text.
 */

function coord(n: number): string {
  return (Math.round(n * 1e6) / 1e6).toString();
}

export function validLatLng(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}

/** `geo:<lat>,<lng>?q=<lat>,<lng>(Stop <seq>)`, or null for an invalid point. */
export function geoUri(lat: number, lng: number, stopSeq: number): string | null {
  if (!validLatLng(lat, lng)) return null;
  const p = `${coord(lat)},${coord(lng)}`;
  const label = `Stop ${Math.max(0, Math.floor(stopSeq))}`;
  return `geo:${p}?q=${p}(${encodeURIComponent(label)})`;
}
