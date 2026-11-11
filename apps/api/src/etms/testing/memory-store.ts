/**
 * In-memory stand-in for the Prisma client used by the ETMS isolation matrix (isolation-matrix.spec.ts) for the E2
 * people routes. It evaluates the services' real where-clauses (AND / OR / NOT, in / notIn / not / contains, relation
 * is / isNot, JSON path equals) and hydrates the relations the services include, so tenant and branch scoping is
 * tested on the actual queries. Test-only; deliberately small: unknown filter shapes match (the services re-check
 * visibility in code), unknown relations hydrate to null.
 */
import { randomUUID } from 'crypto';

export type Obj = Record<string, unknown>;

/** Realm-safe (structuredClone in a jest vm context returns Dates of another realm). */
const isDate = (v: unknown): v is Date => v instanceof Date || Object.prototype.toString.call(v) === '[object Date]';
const isPlain = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !isDate(v) && !Array.isArray(v);

export function matches(row: Obj, where: Obj | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (cond === undefined) return true;
    if (k === 'AND') return (Array.isArray(cond) ? cond : [cond]).every((w) => matches(row, w as Obj));
    if (k === 'OR') return (cond as Obj[]).some((w) => matches(row, w));
    if (k === 'NOT') return !(Array.isArray(cond) ? cond : [cond]).some((w) => matches(row, w as Obj));
    const v = row[k];
    if (isDate(cond)) return isDate(v) && v.getTime() === cond.getTime();
    if (isPlain(cond)) {
      const c = cond;
      if ('in' in c) return (c.in as unknown[]).includes(v);
      if ('notIn' in c) return !(c.notIn as unknown[]).includes(v);
      if ('not' in c) return (v ?? null) !== c.not;
      if ('contains' in c) return typeof v === 'string' && v.toLowerCase().includes(String(c.contains).toLowerCase());
      if ('equals' in c && 'path' in c) return (c.path as string[]).reduce<unknown>((x, p) => (isPlain(x) ? x[p] : undefined), v) === c.equals;
      if ('is' in c) return c.is === null ? v === null || v === undefined : true;
      if ('isNot' in c) return c.isNot === null ? v !== null && v !== undefined : true;
      if ('lt' in c || 'lte' in c || 'gt' in c || 'gte' in c) {
        // Ranges on dates / numbers (E3 overlap and window queries).
        const n = (x: unknown) => (isDate(x) ? x.getTime() : typeof x === 'number' ? x : NaN);
        const val = n(v);
        if (Number.isNaN(val)) return false;
        return (!('lt' in c) || val < n(c.lt)) && (!('lte' in c) || val <= n(c.lte)) && (!('gt' in c) || val > n(c.gt)) && (!('gte' in c) || val >= n(c.gte));
      }
      return true; // JSON paths, array_contains, …: re-checked by the services in code
    }
    return (v ?? null) === cond;
  });
}

/** Relation name → how to hydrate it, per model. */
type Rel = { model: string; fk?: string; many?: { by: string } ; back?: string };
const RELATIONS: Record<string, Record<string, Rel>> = {
  employeeTransportProfile: {
    branch: { model: 'branch', fk: 'branchId' },
    officePoi: { model: 'poi', fk: 'officePoiId' },
    defaultStop: { model: 'poi', fk: 'defaultStopPoiId' },
    user: { model: 'user', fk: 'userId' },
  },
  user: { roles: { model: 'userRole', many: { by: 'userId' } } },
  userRole: { role: { model: 'role', fk: 'roleId' } },
  transportVehicleProfile: { object: { model: 'trackedObject', fk: 'objectId' } },
  trackedObject: { transportProfile: { model: 'transportVehicleProfile', back: 'objectId' } },
  // E3
  transportShift: { sitePoi: { model: 'poi', fk: 'sitePoiId' } },
  transportSchedule: { profile: { model: 'employeeTransportProfile', fk: 'profileId' }, shift: { model: 'transportShift', fk: 'shiftId' }, stopPoi: { model: 'poi', fk: 'stopPoiId' } },
  transportBooking: { profile: { model: 'employeeTransportProfile', fk: 'profileId' }, shift: { model: 'transportShift', fk: 'shiftId' }, passengers: { model: 'transportTripPassenger', many: { by: 'bookingId' } } },
  transportTrip: { plannedTrip: { model: 'plannedTrip', fk: 'plannedTripId' }, shift: { model: 'transportShift', fk: 'shiftId' }, passengers: { model: 'transportTripPassenger', many: { by: 'tripId' } } },
  transportTripPassenger: { booking: { model: 'transportBooking', fk: 'bookingId' }, trip: { model: 'transportTrip', fk: 'tripId' } },
  plannedTrip: { stops: { model: 'plannedTripStop', many: { by: 'tripId' } }, events: { model: 'plannedTripEvent', many: { by: 'tripId' } } },
};

/** Nested `create` written to a child table (model → relation → [child model, back-reference column]). */
const NESTED: Record<string, Record<string, [string, string]>> = { plannedTrip: { stops: ['plannedTripStop', 'tripId'] } };

const DEFAULTS: Record<string, () => Obj> = {
  user: () => ({ isActive: true, isSuperAdmin: false, passwordHash: null, lastLoginAt: null, email: null, mobile: null }),
  employeeTransportProfile: () => ({ isActive: true, branchId: null, userId: null, officePoiId: null, defaultStopPoiId: null, email: null, mobile: null, homeAddress: null, homeLat: null, homeLng: null, homeGeocodeSource: null, homeGeocodeConfidence: null, accessibility: {}, emergencyContacts: [] }),
  employeeTransportConsent: () => ({ occurredAt: new Date(), locale: null }),
  // E3 column defaults (as the migration sets them).
  transportShift: () => ({ isActive: true, sitePoiId: null, createdById: null }),
  transportSchedule: () => ({ isActive: true, version: 1, stopPoiId: null, validTo: null }),
  transportScheduleException: () => ({ override: null, reason: null }),
  transportBooking: () => ({ status: 'REQUESTED', version: 1, providerCompanyId: null, agreementId: null, scheduleId: null, shiftId: null, statusReason: null, cutoffAt: null, idempotencyKey: null, idempotencyHash: null, note: null, passengerCount: 1, pickupPoiId: null, dropPoiId: null, pickupLabel: null, dropLabel: null }),
  transportTrip: () => ({ occupiedSeats: 0, version: 1, publishedAt: null, acknowledgedAt: null, cancelledAt: null, cancelReason: null, interruptedAt: null, shiftId: null, sitePoiId: null, agreementId: null }),
  transportTripPassenger: () => ({ status: 'PENDING', seats: 1, boardedAt: null, droppedAt: null, noShowAt: null, noShowReason: null, cancelReason: null, outcomeSource: null, outcomeAt: null }),
  transportTripEvent: () => ({ outcome: 'ACCEPTED', receivedAt: new Date(), data: {} }),
  transportChangeSet: () => ({ idempotencyKey: null, requestHash: null, draft: null, result: null, publishedAt: null }),
  plannedTrip: () => ({ status: 'SCHEDULED', origin: 'ROUTE', actualStart: null, actualEnd: null, closedBy: null, cancelReason: null, notes: null, nextStopSeq: 0, etaNextStop: null, delaySec: null, deviationCount: 0, maxDeviationM: null, distanceKm: null, driverId: null, scheduleId: null, path: null }),
  plannedTripStop: () => ({ status: 'PENDING', actualArrival: null, actualDeparture: null, delaySec: null }),
};

export class MemoryStore {
  readonly tables: Record<string, Obj[]> = {};

  table(name: string): Obj[] {
    return (this.tables[name] ??= []);
  }

  insert(model: string, row: Obj): Obj {
    const now = new Date();
    // Prisma ignores undefined fields (e.g. `id: undefined` keeps the generated id).
    const given = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
    const r: Obj = { id: randomUUID(), createdAt: now, updatedAt: now, ...(DEFAULTS[model]?.() ?? {}), ...given };
    this.table(model).push(r);
    return r;
  }

  private hydrate(model: string, row: Obj | undefined | null, shape: Obj | undefined): Obj | null {
    if (!row) return null;
    const out: Obj = { ...row };
    const spec = shape && (isPlain(shape.include) ? shape.include : isPlain(shape.select) ? shape.select : undefined);
    if (!spec) return out;
    for (const [name, sub] of Object.entries(spec)) {
      if (name === '_count' && isPlain(sub) && isPlain(sub.select)) {
        // _count: { select: { stops: true } } on a to-many relation.
        out._count = Object.fromEntries(Object.keys(sub.select).map((r) => { const m = RELATIONS[model]?.[r]; return [r, m?.many ? this.table(m.model).filter((x) => x[m.many!.by] === row.id).length : 0]; }));
        continue;
      }
      const rel = RELATIONS[model]?.[name];
      if (!rel || !sub) continue;
      const subShape = isPlain(sub) ? sub : undefined;
      if (rel.many) out[name] = this.table(rel.model).filter((x) => x[rel.many!.by] === row.id).map((x) => this.hydrate(rel.model, x, subShape));
      else if (rel.back) out[name] = this.hydrate(rel.model, this.table(rel.model).find((x) => x[rel.back!] === row.id), subShape);
      else out[name] = this.hydrate(rel.model, this.table(rel.model).find((x) => x.id === row[rel.fk!]), subShape);
    }
    return out;
  }

  /** Unique where: `{ id }`, `{ objectId }`, or a compound key such as `{ companyId_name: { … } }`. */
  private unique(where: Obj): Obj {
    const flat: Obj = {};
    for (const [k, v] of Object.entries(where)) Object.assign(flat, k.includes('_') && isPlain(v) ? v : { [k]: v });
    return flat;
  }

  /** Nested writes: `roles: { create: [...] }` on a user goes to userRole; other nested creates stay inline. */
  private split(model: string, data: Obj): { scalars: Obj; userRoles: Obj[]; nested: [string, string, Obj[]][] } {
    const scalars: Obj = {};
    let userRoles: Obj[] = [];
    const nested: [string, string, Obj[]][] = [];
    for (const [k, v] of Object.entries(data)) {
      if (isPlain(v) && 'create' in v) {
        const rows = (Array.isArray(v.create) ? v.create : [v.create]) as Obj[];
        if (model === 'user' && k === 'roles') userRoles = rows;
        else if (NESTED[model]?.[k]) nested.push([...NESTED[model][k], rows]);
        else scalars[k] = rows;
      } else if (isPlain(v) && 'increment' in v) {
        scalars[k] = { __inc: v.increment };
      } else if (isPlain(v) && 'decrement' in v) {
        scalars[k] = { __inc: -(v.decrement as number) };
      } else scalars[k] = v;
    }
    return { scalars, userRoles, nested };
  }

  private apply(model: string, row: Obj, data: Obj): void {
    const { scalars, userRoles } = this.split(model, data);
    for (const [k, v] of Object.entries(scalars)) {
      if (v === undefined) continue; // Prisma ignores undefined fields
      row[k] = isPlain(v) && '__inc' in v ? (row[k] as number) + (v.__inc as number) : v;
    }
    row.updatedAt = new Date();
    for (const ur of userRoles) this.table('userRole').push({ userId: row.id, ...ur });
  }

  model(model: string): Obj {
    const rows = () => this.table(model);
    const create = ({ data, ...shape }: Obj) => {
      const { scalars, userRoles, nested } = this.split(model, data as Obj);
      const r = this.insert(model, scalars);
      for (const ur of userRoles) this.table('userRole').push({ userId: r.id, ...ur });
      for (const [child, back, rows] of nested) for (const row of rows) this.insert(child, { ...row, [back]: r.id });
      return this.hydrate(model, r, shape);
    };
    return {
      findMany: async ({ where, skip, take, ...shape }: Obj = {}) =>
        rows()
          .filter((r) => matches(r, where as Obj))
          .slice((skip as number) ?? 0, take === undefined ? undefined : ((skip as number) ?? 0) + (take as number))
          .map((r) => this.hydrate(model, r, shape)),
      findFirst: async ({ where, ...shape }: Obj = {}) => this.hydrate(model, rows().find((r) => matches(r, where as Obj)), shape),
      findUnique: async ({ where, ...shape }: Obj) => this.hydrate(model, rows().find((r) => matches(r, this.unique(where as Obj))), shape),
      findUniqueOrThrow: async ({ where, ...shape }: Obj) => {
        const r = rows().find((x) => matches(x, this.unique(where as Obj)));
        if (!r) throw new Error(`${model} not found`);
        return this.hydrate(model, r, shape);
      },
      count: async ({ where }: Obj = {}) => rows().filter((r) => matches(r, where as Obj)).length,
      // groupBy on one column with _count._all (the v1.8 planned-trips list counts skipped stops per trip).
      groupBy: async ({ by, where }: Obj) => {
        const key = (by as string[])[0];
        const groups = new Map<unknown, number>();
        for (const r of rows().filter((x) => matches(x, where as Obj))) groups.set(r[key], (groups.get(r[key]) ?? 0) + 1);
        return [...groups].map(([k, n]) => ({ [key]: k, _count: { _all: n } }));
      },
      create: async (args: Obj) => create(args),
      createMany: async ({ data }: Obj) => {
        for (const d of data as Obj[]) this.insert(model, d);
        return { count: (data as Obj[]).length };
      },
      update: async ({ where, data, ...shape }: Obj) => {
        const r = rows().find((x) => matches(x, this.unique(where as Obj)));
        if (!r) throw new Error(`${model} not found`);
        this.apply(model, r, data as Obj);
        return this.hydrate(model, r, shape);
      },
      updateMany: async ({ where, data }: Obj) => {
        const hit = rows().filter((x) => matches(x, where as Obj));
        for (const r of hit) this.apply(model, r, data as Obj);
        return { count: hit.length };
      },
      upsert: async ({ where, create: c, update: u, ...shape }: Obj) => {
        const r = rows().find((x) => matches(x, this.unique(where as Obj)));
        if (!r) return create({ data: c, ...shape });
        this.apply(model, r, u as Obj);
        return this.hydrate(model, r, shape);
      },
      delete: async ({ where }: Obj) => {
        const r = rows().find((x) => matches(x, this.unique(where as Obj)));
        if (!r) throw new Error(`${model} not found`);
        this.tables[model] = rows().filter((x) => x !== r);
        return r;
      },
      deleteMany: async ({ where }: Obj = {}) => {
        const keep = rows().filter((x) => !matches(x, where as Obj));
        const n = rows().length - keep.length;
        this.tables[model] = keep;
        return { count: n };
      },
    };
  }

  /**
   * A Prisma-like client: every model is backed by the store; `$queryRaw` answers the latest-consent query of
   * people.service (DISTINCT ON profile, purpose) and returns [] for anything else.
   */
  client(overrides: Obj = {}): Obj {
    const models: Obj = {};
    const prisma: Obj = new Proxy(models, {
      get: (target, prop: string) => {
        if (prop in overrides) return overrides[prop];
        if (prop === '$transaction')
          return async (arg: unknown) => {
            if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
            // All-or-nothing like PostgreSQL: a throwing transaction leaves the tables as they were.
            const snapshot = structuredClone(this.tables);
            try {
              return await (arg as (tx: unknown) => unknown)(prisma);
            } catch (e) {
              for (const k of Object.keys(this.tables)) delete this.tables[k];
              Object.assign(this.tables, snapshot);
              throw e;
            }
          };
        if (prop === '$queryRaw') return async (strings: TemplateStringsArray, ...values: unknown[]) => this.queryRaw(strings.join('?'), values);
        if (prop === '$executeRaw') return async () => 1;
        if (prop === 'then') return undefined;
        return (target[prop] ??= this.model(prop));
      },
    });
    return prisma;
  }

  private queryRaw(sql: string, values: unknown[]): Obj[] {
    if (!sql.includes('DISTINCT ON ("profileId", "purpose")')) return [];
    const ids = values[0] as string[];
    const latest = new Map<string, Obj>();
    for (const c of this.table('employeeTransportConsent')) {
      if (!ids.includes(c.profileId as string)) continue;
      const key = `${c.profileId as string}|${c.purpose as string}`;
      const cur = latest.get(key);
      if (!cur || (c.occurredAt as Date) >= (cur.occurredAt as Date)) latest.set(key, c);
    }
    return [...latest.values()];
  }
}
