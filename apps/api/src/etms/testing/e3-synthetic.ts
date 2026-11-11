import { randomUUID } from 'crypto';

/**
 * ETMS E3 synthetic tenant generator for the WP 3.8 harness (12 WP 3.8; 16 §4.1 data shapes, §4.3 "T3 functional:
 * 2 + control companies, 200 passengers, 1 recurring week IST + 1 US DST week"). Clearly synthetic, never real data:
 * company / passenger names start with the run tag, phones are not stored, plates use the non-issued series
 * `TN 00 TS 0001` / `SYN 0001`, home pins are scattered around a city centre. Deterministic for a seed (ids are random
 * UUIDs so two runs never collide; everything else repeats).
 *
 * `planE3Synthetic()` is pure (unit-tested); `seedE3Synthetic()` writes the plan with plain SQL into a scratch
 * database (the DB guard is the caller's job: `dbDescribe` / the gate script refuse anything but `*_test`).
 */

export type E3CompanyKind = 'CUSTOMER' | 'CONTROL' | 'ETMS_OFF';

export interface E3ShiftSpec {
  key: string;
  name: string;
  startMin: number;
  endMin: number;
  /** Mon = 1 … Sat = 6, Sun = 0. */
  days: number[];
}

export interface E3CompanySpec {
  key: string;
  kind: E3CompanyKind;
  timezone: string;
  passengers: number;
  /** Every n-th passenger has no routing consent (0 = all consented). */
  noConsentEvery?: number;
  /** Passengers that get a User login linked to the profile (the first n). */
  logins?: number;
  branches?: string[];
  vehicles?: (number | null)[];
  drivers?: number;
  shifts?: E3ShiftSpec[];
  centre?: { lat: number; lng: number };
}

export interface E3SyntheticOptions {
  tag: string;
  seed?: number;
  companies: E3CompanySpec[];
}

export interface E3Branch {
  id: string;
  name: string;
}
export interface E3Site {
  id: string;
  name: string;
  lat: number;
  lng: number;
  branchId: string | null;
}
export interface E3Passenger {
  id: string;
  employeeCode: string;
  displayName: string;
  branchId: string | null;
  homeLat: number;
  homeLng: number;
  consent: boolean;
  userId: string | null;
}
export interface E3Vehicle {
  id: string;
  name: string;
  plateNumber: string;
  seats: number | null;
  branchId: string | null;
}
export interface E3Driver {
  id: string;
  name: string;
  branchId: string | null;
}
export interface E3Shift extends E3ShiftSpec {
  id: string;
  overnight: boolean;
  timeZone: string;
  sitePoiId: string;
}
export interface E3Company {
  key: string;
  kind: E3CompanyKind;
  id: string;
  name: string;
  timezone: string;
  features: string[];
  branches: E3Branch[];
  sites: E3Site[];
  passengers: E3Passenger[];
  vehicles: E3Vehicle[];
  drivers: E3Driver[];
  shifts: E3Shift[];
}
export interface E3SyntheticPlan {
  tag: string;
  companies: E3Company[];
}

/** India shifts of 16 §4.1 (IST). */
export const IST_SHIFTS: E3ShiftSpec[] = [
  { key: 'morning', name: 'Morning 06:00-15:00', startMin: 6 * 60, endMin: 15 * 60, days: [1, 2, 3, 4, 5] },
  { key: 'day', name: 'Day 09:00-18:00', startMin: 9 * 60, endMin: 18 * 60, days: [1, 2, 3, 4, 5] },
  { key: 'night', name: 'Night 22:00-07:00', startMin: 22 * 60, endMin: 7 * 60, days: [0, 1, 2, 3, 4, 5, 6] },
];
/** US shifts (America/Chicago, 16 §4.1) plus an every-night overnight shift that crosses the 02:00 DST change. */
export const US_SHIFTS: E3ShiftSpec[] = [
  { key: 'day', name: 'Day 07:00-16:00', startMin: 7 * 60, endMin: 16 * 60, days: [1, 2, 3, 4, 5] },
  { key: 'swing', name: 'Swing 15:00-00:00', startMin: 15 * 60, endMin: 0, days: [1, 2, 3, 4, 5] },
  { key: 'night', name: 'Night 22:00-06:00', startMin: 22 * 60, endMin: 6 * 60, days: [0, 1, 2, 3, 4, 5, 6] },
];
/** Vehicle mix of 16 §4.1 (sedan 4, SUV 6, tempo traveller 12, minibus 26, bus 40) and one without seats set. */
export const VEHICLE_MIX: (number | null)[] = [4, 6, 12, 26, 40, null];

const CHENNAI = { lat: 13.0067, lng: 80.2206 };
const CHICAGO = { lat: 41.8781, lng: -87.6298 };

/** mulberry32: small deterministic PRNG. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number, w = 4) => String(n).padStart(w, '0');
const round5 = (x: number) => Math.round(x * 1e5) / 1e5;

export function planE3Synthetic(opts: E3SyntheticOptions): E3SyntheticPlan {
  if (!/^[a-z0-9-]{3,40}$/.test(opts.tag)) throw new Error('tag: 3-40 chars of a-z, 0-9, -');
  const rnd = prng(opts.seed ?? 3008);
  const companies = opts.companies.map((spec, ci): E3Company => {
    const id = randomUUID();
    const centre = spec.centre ?? (spec.timezone.startsWith('America/') ? CHICAGO : CHENNAI);
    const branches = (spec.branches ?? []).map((name) => ({ id: randomUUID(), name }));
    // One office per branch (or one company-wide office), ~1.5 km apart.
    const sites: E3Site[] = (branches.length ? branches : [null]).map((b, i) => ({
      id: randomUUID(),
      name: `${opts.tag} ${spec.key} Office ${b ? b.name : 'HQ'}`,
      lat: round5(centre.lat + i * 0.015),
      lng: round5(centre.lng + i * 0.01),
      branchId: b?.id ?? null,
    }));
    const passengers = Array.from({ length: spec.passengers }, (_, i): E3Passenger => {
      const branch = branches.length ? branches[i % branches.length] : null;
      // Home pins within ~8 km of the centre.
      const r = 0.07 * Math.sqrt(rnd());
      const a = 2 * Math.PI * rnd();
      return {
        id: randomUUID(),
        employeeCode: `E3H-${spec.key}-${pad(i + 1, 5)}`,
        displayName: `${opts.tag} ${spec.key} Passenger ${pad(i + 1)}`,
        branchId: branch?.id ?? null,
        homeLat: round5(centre.lat + r * Math.sin(a)),
        homeLng: round5(centre.lng + r * Math.cos(a)),
        consent: !(spec.noConsentEvery && (i + 1) % spec.noConsentEvery === 0),
        userId: i < (spec.logins ?? 0) ? randomUUID() : null,
      };
    });
    const country = spec.timezone.startsWith('America/') ? 'US' : 'IN';
    const vehicles = (spec.vehicles ?? []).map((seats, i): E3Vehicle => ({
      id: randomUUID(),
      name: `${opts.tag} ${spec.key} Van ${pad(i + 1, 2)}`,
      plateNumber: country === 'IN' ? `TN 00 TS ${pad(ci * 100 + i + 1)}` : `SYN ${pad(ci * 100 + i + 1)}`,
      seats,
      branchId: branches.length ? branches[i % branches.length].id : null,
    }));
    const drivers = Array.from({ length: spec.drivers ?? 0 }, (_, i): E3Driver => ({ id: randomUUID(), name: `${opts.tag} ${spec.key} Driver ${pad(i + 1, 2)}`, branchId: branches.length ? branches[i % branches.length].id : null }));
    const shifts = (spec.shifts ?? []).map((s): E3Shift => ({ ...s, id: randomUUID(), overnight: s.endMin <= s.startMin, timeZone: spec.timezone, sitePoiId: sites[0].id }));
    return {
      key: spec.key,
      kind: spec.kind,
      id,
      name: `${opts.tag} ${spec.key}`,
      timezone: spec.timezone,
      features: spec.kind === 'ETMS_OFF' ? [] : ['etms'],
      branches,
      sites,
      passengers,
      vehicles,
      drivers,
      shifts,
    };
  });
  return { tag: opts.tag, companies };
}

/** The standard T3 functional shape (16 §4.3): an IST customer (2 branches), a US DST customer, a control tenant, an etms-off tenant. */
export function standardE3Plan(tag: string, passengers = 200, seed?: number): E3SyntheticPlan {
  return planE3Synthetic({
    tag,
    seed,
    companies: [
      { key: 'IST', kind: 'CUSTOMER', timezone: 'Asia/Kolkata', passengers, branches: ['North', 'South'], vehicles: [...VEHICLE_MIX, 3, 4, 6], drivers: 4, shifts: IST_SHIFTS, logins: 4 },
      { key: 'US', kind: 'CUSTOMER', timezone: 'America/Chicago', passengers, vehicles: VEHICLE_MIX, drivers: 2, shifts: US_SHIFTS },
      { key: 'CTRL', kind: 'CONTROL', timezone: 'Asia/Kolkata', passengers: 5, vehicles: [6], drivers: 1, shifts: [IST_SHIFTS[1]] },
      { key: 'OFF', kind: 'ETMS_OFF', timezone: 'Asia/Kolkata', passengers: 0, vehicles: [4] },
    ],
  });
}

type Exec = { $executeRawUnsafe(query: string): Promise<number> };

const s = (v: string | null) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);
const n = (v: number | null) => (v === null ? 'NULL' : String(v));

async function chunked<T>(db: Exec, rows: T[], head: string, row: (r: T) => string): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    if (part.length) await db.$executeRawUnsafe(`${head} VALUES ${part.map(row).join(',')}`);
  }
}

/**
 * Writes the plan (companies, branches, offices, passengers + consents + logins, vehicles + seat profiles, drivers,
 * shifts) with plain SQL. Consent rows use the passenger's own channel (WEB), backdated one day, as the E3 DB tests do.
 */
export async function seedE3Synthetic(db: Exec, plan: E3SyntheticPlan, partnerId: string): Promise<void> {
  for (const c of plan.companies) {
    await db.$executeRawUnsafe(`INSERT INTO "Company" (id, "partnerId", name, timezone, settings, "updatedAt") VALUES ('${c.id}', '${partnerId}', ${s(c.name)}, '${c.timezone}', '${JSON.stringify({ features: c.features })}', now())`);
    await chunked(db, c.branches, `INSERT INTO "Branch" (id, "companyId", name, "updatedAt")`, (b) => `('${b.id}', '${c.id}', ${s(b.name)}, now())`);
    await chunked(db, c.sites, `INSERT INTO "Poi" (id, "companyId", "branchId", name, category, lat, lng, "updatedAt")`, (p) => `('${p.id}', '${c.id}', ${s(p.branchId)}, ${s(p.name)}, 'OFFICE', ${p.lat}, ${p.lng}, now())`);
    const logins = c.passengers.filter((p) => p.userId);
    await chunked(db, logins, `INSERT INTO "User" (id, "companyId", name, "updatedAt")`, (p) => `('${p.userId}', '${c.id}', ${s(p.displayName)}, now())`);
    await chunked(
      db,
      c.passengers,
      `INSERT INTO "EmployeeTransportProfile" (id, "companyId", "branchId", "userId", "employeeCode", "displayName", "homeLat", "homeLng", "updatedAt")`,
      (p) => `('${p.id}', '${c.id}', ${s(p.branchId)}, ${s(p.userId)}, ${s(p.employeeCode)}, ${s(p.displayName)}, ${p.homeLat}, ${p.homeLng}, now())`,
    );
    await chunked(
      db,
      c.passengers.filter((p) => p.consent),
      `INSERT INTO "EmployeeTransportConsent" (id, "companyId", "profileId", purpose, "noticeVersion", granted, channel, "occurredAt")`,
      (p) => `(gen_random_uuid(), '${c.id}', '${p.id}', 'TRANSPORT_PROFILE', 'v1', true, 'WEB', now() - interval '1 day')`,
    );
    await chunked(db, c.vehicles, `INSERT INTO "TrackedObject" (id, "companyId", "branchId", name, "plateNumber", "isActive", "updatedAt")`, (v) => `('${v.id}', '${c.id}', ${s(v.branchId)}, ${s(v.name)}, ${s(v.plateNumber)}, true, now())`);
    await chunked(
      db,
      c.vehicles.filter((v) => v.seats !== null),
      `INSERT INTO "TransportVehicleProfile" ("objectId", "companyId", seats, "updatedAt")`,
      (v) => `('${v.id}', '${c.id}', ${n(v.seats)}, now())`,
    );
    await chunked(db, c.drivers, `INSERT INTO "Driver" (id, "companyId", "branchId", name, "isActive", "updatedAt")`, (d) => `('${d.id}', '${c.id}', ${s(d.branchId)}, ${s(d.name)}, true, now())`);
    await chunked(
      db,
      c.shifts,
      `INSERT INTO "TransportShift" (id, "companyId", "sitePoiId", name, "startMin", "endMin", overnight, days, "timeZone", "updatedAt")`,
      (sh) => `('${sh.id}', '${c.id}', '${sh.sitePoiId}', ${s(sh.name)}, ${sh.startMin}, ${sh.endMin}, ${sh.overnight}, '{${sh.days.join(',')}}', '${sh.timeZone}', now())`,
    );
  }
}

/** Counts per company of a plan (what `seedE3Synthetic` writes), for summaries and assertions. */
export function planCounts(plan: E3SyntheticPlan): Record<string, { passengers: number; consented: number; logins: number; vehicles: number; drivers: number; shifts: number; branches: number; sites: number }> {
  return Object.fromEntries(
    plan.companies.map((c) => [
      c.key,
      {
        passengers: c.passengers.length,
        consented: c.passengers.filter((p) => p.consent).length,
        logins: c.passengers.filter((p) => p.userId).length,
        vehicles: c.vehicles.length,
        drivers: c.drivers.length,
        shifts: c.shifts.length,
        branches: c.branches.length,
        sites: c.sites.length,
      },
    ]),
  );
}
