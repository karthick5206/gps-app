import { PASSENGER_IMPORT_COLUMNS, normalisePhone, validHomePoint } from '@veetracer/shared';

/**
 * WP 2.5: synthetic ETMS test data (passengers with home pins, offices, stops and shift windows) for load, UX and
 * routing tests. Clearly synthetic and never real personal data:
 * - names "Synthetic <First> <Last>", employee codes SYN-<city>-00001…, emails @synthetic.example (RFC 2606);
 * - India phones +91 00000 NNNNN (no real Indian mobile starts with 0), US phones +1 555 01NN NNN (the reserved
 *   fictional 555-01xx range); addresses "Synthetic Street N, <area>";
 * - home pins scattered around real office areas of Chennai, Bengaluru and two US cities, so routing is realistic.
 * Deterministic for a seed. Output: the passenger import CSV (PASSENGER_IMPORT_COLUMNS), the offices / stops to create
 * as Places first (office names must exist for the import), and shift windows for E3. CLI:
 * apps/api/scripts/etms-synthetic-people.ts.
 */

export interface SyntheticCity {
  key: string;
  country: 'IN' | 'US';
  offices: { name: string; lat: number; lng: number }[];
  /** Residential areas around which home pins are scattered (radius in km). */
  areas: { name: string; lat: number; lng: number; radiusKm: number }[];
}

export const SYNTHETIC_CITIES: SyntheticCity[] = [
  {
    key: 'CHE',
    country: 'IN',
    offices: [
      { name: 'Synthetic Chennai OMR Tech Park', lat: 12.9516, lng: 80.2405 },
      { name: 'Synthetic Chennai Guindy Office', lat: 13.0067, lng: 80.2206 },
    ],
    areas: [
      { name: 'Velachery', lat: 12.9815, lng: 80.218, radiusKm: 2.5 },
      { name: 'Tambaram', lat: 12.9249, lng: 80.1, radiusKm: 3 },
      { name: 'Anna Nagar', lat: 13.085, lng: 80.2101, radiusKm: 2.5 },
      { name: 'Sholinganallur', lat: 12.901, lng: 80.2279, radiusKm: 2 },
    ],
  },
  {
    key: 'BLR',
    country: 'IN',
    offices: [
      { name: 'Synthetic Bengaluru Whitefield Campus', lat: 12.9698, lng: 77.75 },
      { name: 'Synthetic Bengaluru Electronic City', lat: 12.8452, lng: 77.6602 },
    ],
    areas: [
      { name: 'Marathahalli', lat: 12.9591, lng: 77.6974, radiusKm: 2.5 },
      { name: 'HSR Layout', lat: 12.9116, lng: 77.6474, radiusKm: 2 },
      { name: 'Jayanagar', lat: 12.925, lng: 77.5938, radiusKm: 2.5 },
      { name: 'Hebbal', lat: 13.0358, lng: 77.597, radiusKm: 2.5 },
    ],
  },
  {
    key: 'AUS',
    country: 'US',
    offices: [{ name: 'Synthetic Austin Domain Office', lat: 30.4021, lng: -97.7253 }],
    areas: [
      { name: 'Round Rock', lat: 30.5083, lng: -97.6789, radiusKm: 4 },
      { name: 'Cedar Park', lat: 30.5052, lng: -97.8203, radiusKm: 4 },
    ],
  },
  {
    key: 'CMH',
    country: 'US',
    offices: [{ name: 'Synthetic Columbus Easton Office', lat: 40.0506, lng: -82.9152 }],
    areas: [
      { name: 'Westerville', lat: 40.1262, lng: -82.9291, radiusKm: 4 },
      { name: 'Gahanna', lat: 40.0192, lng: -82.8793, radiusKm: 3 },
    ],
  },
];

export const SYNTHETIC_SHIFTS = [
  { code: 'SYN-MORNING', name: 'Synthetic morning shift', start: '06:00', end: '15:00', days: 'MON-FRI' },
  { code: 'SYN-GENERAL', name: 'Synthetic general shift', start: '09:30', end: '18:30', days: 'MON-FRI' },
  { code: 'SYN-NIGHT', name: 'Synthetic night shift', start: '21:00', end: '06:00', days: 'MON-SAT' },
] as const;

const FIRST = ['Asha', 'Ravi', 'Meena', 'Karthik', 'Divya', 'Arjun', 'Lakshmi', 'Vikram', 'Priya', 'Suresh', 'Anita', 'Rahul', 'Emma', 'Liam', 'Olivia', 'Noah'];
const LAST = ['Iyer', 'Kumar', 'Rao', 'Nair', 'Reddy', 'Shah', 'Menon', 'Pillai', 'Gowda', 'Das', 'Smith', 'Garcia', 'Brown', 'Lee'];

/** mulberry32: small deterministic PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A point uniformly inside a circle of radiusKm around (lat, lng), 6 decimals. */
function scatter(r: () => number, lat: number, lng: number, radiusKm: number): { lat: number; lng: number } {
  const d = (radiusKm * Math.sqrt(r())) / 111.32;
  const a = 2 * Math.PI * r();
  return { lat: Number((lat + d * Math.cos(a)).toFixed(6)), lng: Number((lng + (d * Math.sin(a)) / Math.cos((lat * Math.PI) / 180)).toFixed(6)) };
}

export function syntheticPhone(country: 'IN' | 'US', n: number): string {
  return country === 'IN' ? `+9100000${String(n % 100000).padStart(5, '0')}` : `+1555010${String(n % 10000).padStart(4, '0')}`;
}

export interface SyntheticPassenger {
  employee_code: string;
  name: string;
  mobile: string;
  email: string;
  home_address: string;
  home_lat: string;
  home_lng: string;
  office: string;
  default_stop: string;
  branch: string;
  wheelchair: string;
  accessibility_notes: string;
  active: string;
  /** Not an import column: the shift for E3 tests. */
  shift: string;
}

export function generateSyntheticPassengers(opts: { count: number; seed?: number; cities?: string[] }): SyntheticPassenger[] {
  const r = rng(opts.seed ?? 20261111);
  const cities = SYNTHETIC_CITIES.filter((c) => !opts.cities?.length || opts.cities.includes(c.key));
  if (!cities.length) throw new Error('No such city');
  const out: SyntheticPassenger[] = [];
  for (let i = 0; i < opts.count; i++) {
    const city = cities[i % cities.length];
    const n = Math.floor(i / cities.length) + 1;
    const area = city.areas[Math.floor(r() * city.areas.length)];
    const office = city.offices[Math.floor(r() * city.offices.length)];
    const home = scatter(r, area.lat, area.lng, area.radiusKm);
    const first = FIRST[Math.floor(r() * FIRST.length)];
    const last = LAST[Math.floor(r() * LAST.length)];
    const code = `SYN-${city.key}-${String(n).padStart(5, '0')}`;
    const wheelchair = r() < 0.02;
    out.push({
      employee_code: code,
      name: `Synthetic ${first} ${last}`,
      mobile: syntheticPhone(city.country, i + 1),
      email: `${code.toLowerCase()}@synthetic.example`,
      home_address: `Synthetic Street ${1 + Math.floor(r() * 200)}, ${area.name}`,
      home_lat: String(home.lat),
      home_lng: String(home.lng),
      office: office.name,
      default_stop: '',
      branch: '',
      wheelchair: wheelchair ? 'yes' : 'no',
      accessibility_notes: wheelchair ? 'Synthetic: needs a wheelchair space' : '',
      active: 'yes',
      shift: SYNTHETIC_SHIFTS[Math.floor(r() * SYNTHETIC_SHIFTS.length)].code,
    });
  }
  return out;
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The passenger import CSV (exactly PASSENGER_IMPORT_COLUMNS). */
export function toImportCsv(rows: SyntheticPassenger[]): string {
  const cols = [...PASSENGER_IMPORT_COLUMNS];
  return [cols.join(','), ...rows.map((p) => cols.map((c) => csvCell(p[c])).join(','))].join('\n') + '\n';
}

/** Self-check used by the tests: every row is importable and recognisably synthetic. */
export function isSyntheticRow(p: SyntheticPassenger): boolean {
  const country = p.mobile.startsWith('+91') ? 'IN' : 'US';
  return (
    p.name.startsWith('Synthetic ') &&
    p.email.endsWith('@synthetic.example') &&
    (p.mobile.startsWith('+9100000') || p.mobile.startsWith('+1555010')) &&
    normalisePhone(p.mobile, country) === p.mobile &&
    validHomePoint(Number(p.home_lat), Number(p.home_lng))
  );
}
