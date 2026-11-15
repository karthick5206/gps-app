/**
 * Coordinate search (pure; used by the API geocoder and by the web search boxes for instant feedback).
 *
 * parseCoordinates turns what a user typed into a point, or null when it does not look like coordinates:
 *   decimal        "12.97, 77.59"  "12.97 77.59"  "-33.86;151.2"  "lat 12.97 lng 77.59"
 *   hemispheres    "12.97N 77.59E"  "N12.97 E77.59"  "33.86 S, 151.2 E"  "77.59E 12.97N" (axis taken from the letter)
 *   DMS            "12°58'17\"N 77°35'40\"E"  "12° 58.3' N, 77° 35.6' E"
 *   lng, lat       "77.59, 12.97" is NOT swapped (both are valid latitudes); "151.2, -33.86" is (first value > 90)
 * Ranges are validated (|lat| ≤ 90, |lng| ≤ 180, minutes / seconds < 60). Two bare numbers without a decimal point,
 * separator, hemisphere or degree sign ("12 77") are not taken as coordinates (more likely a house number search).
 */

export interface ParsedCoordinates {
  lat: number;
  lng: number;
  /** The input was read as "lng, lat" (its first value was out of the latitude range). */
  swapped: boolean;
}

type Token = { k: 'num'; v: number; sign: '' | '+' | '-'; dec: boolean } | { k: 'deg' | 'min' | 'sec' | 'sep' } | { k: 'hemi'; v: 'N' | 'S' | 'E' | 'W' };

interface Component {
  value: number;
  /** 'lat' / 'lng' from a hemisphere letter, else null. */
  axis: 'lat' | 'lng' | null;
  /** Written with a degree sign, minutes or seconds. */
  dms: boolean;
  dec: boolean;
}

function tokenize(input: string): Token[] | null {
  const s = input
    .toUpperCase()
    .replace(/\b(LATITUDE|LONGITUDE|LAT|LNG|LON|LONG)\b\s*[:=]?/g, ' ')
    .replace(/[−–—]/g, '-') // minus sign, en / em dash
    .replace(/[º˚]/g, '°') // masculine ordinal, ring above
    .replace(/[′’‘´`]/g, "'")
    .replace(/[″”“]|''/g, '"');
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^([+-]?)(\d+(?:\.\d+)?|\.\d+)/.exec(s.slice(i));
    if (num) {
      out.push({ k: 'num', v: Number(num[2]), sign: num[1] as '' | '+' | '-', dec: num[2].includes('.') });
      i += num[0].length;
      continue;
    }
    if (c === '°') out.push({ k: 'deg' });
    else if (c === "'") out.push({ k: 'min' });
    else if (c === '"') out.push({ k: 'sec' });
    else if (c === ',' || c === ';' || c === '/') out.push({ k: 'sep' });
    else if (c === 'N' || c === 'S' || c === 'E' || c === 'W') {
      // A hemisphere is a single letter, never part of a word ("NEW DELHI", "SECTOR 5").
      if (/[A-Z]/.test(s[i + 1] ?? '')) return null;
      out.push({ k: 'hemi', v: c });
    } else return null;
    i++;
  }
  return out;
}

/** One component at tokens[pos]: [hemi] [sign]deg [°] [min ' [sec "]] [hemi]. */
function readComponent(t: Token[], pos: number): { c: Component; next: number } | null {
  let i = pos;
  let prefix: 'N' | 'S' | 'E' | 'W' | null = null;
  const first = t[i];
  if (first?.k === 'hemi') {
    prefix = first.v;
    i++;
  }
  const deg = t[i];
  if (deg?.k !== 'num') return null;
  i++;
  let dms = false;
  let value = deg.v;
  let dec = deg.dec;
  if (t[i]?.k === 'deg') {
    dms = true;
    i++;
  }
  const min = t[i];
  if (min?.k === 'num' && t[i + 1]?.k === 'min') {
    if (deg.dec || min.sign || min.v >= 60) return null;
    value += min.v / 60;
    dms = true;
    dec = dec || min.dec;
    i += 2;
    const sec = t[i];
    if (sec?.k === 'num' && t[i + 1]?.k === 'sec') {
      if (min.dec || sec.sign || sec.v >= 60) return null;
      value += sec.v / 3600;
      i += 2;
    }
  }
  let hemi = prefix;
  const suffix = t[i];
  // A component with a prefix letter takes no suffix: in "N12.97 E77.59" the E belongs to the next value.
  if (!prefix && suffix?.k === 'hemi') {
    hemi = suffix.v;
    i++;
  }
  if (hemi && deg.sign === '-') return null; // "-12.9 S": contradictory
  const negative = deg.sign === '-' || hemi === 'S' || hemi === 'W';
  return { c: { value: negative ? -value : value, axis: hemi === 'N' || hemi === 'S' ? 'lat' : hemi ? 'lng' : null, dms, dec }, next: i };
}

export function parseCoordinates(input: string): ParsedCoordinates | null {
  if (typeof input !== 'string' || input.length > 100) return null;
  const t = tokenize(input);
  if (!t || t.length < 2) return null;
  const a = readComponent(t, 0);
  if (!a) return null;
  let i = a.next;
  let separated = false;
  if (t[i]?.k === 'sep') {
    separated = true;
    i++;
  }
  const b = readComponent(t, i);
  if (!b || b.next !== t.length) return null;
  const [p, q] = [a.c, b.c];
  if (!separated && !p.axis && !q.axis && !p.dms && !q.dms && !p.dec && !q.dec) return null;
  let lat: number;
  let lng: number;
  let swapped = false;
  if (p.axis || q.axis) {
    const pAxis = p.axis ?? (q.axis === 'lat' ? 'lng' : 'lat');
    const qAxis = q.axis ?? (pAxis === 'lat' ? 'lng' : 'lat');
    if (pAxis === qAxis) return null;
    [lat, lng] = pAxis === 'lat' ? [p.value, q.value] : [q.value, p.value];
    swapped = pAxis === 'lng';
  } else if (Math.abs(p.value) > 90 && Math.abs(q.value) <= 90) {
    [lat, lng, swapped] = [q.value, p.value, true];
  } else {
    [lat, lng] = [p.value, q.value];
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat: round(lat), lng: round(lng), swapped };
}

const round = (v: number): number => Math.round(v * 1e6) / 1e6 + 0; // + 0 turns -0 into 0

/** "12.970000, 77.590000" (6 decimals, about 0.1 m): the label of a coordinate hit without an address. */
export function formatCoordinates(lat: number, lng: number): string {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

/** Match type of a search hit that is the typed coordinates themselves (GeocodeHit.matchType). */
export const COORDINATES_MATCH_TYPE = 'coordinates';
