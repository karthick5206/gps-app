/**
 * In-memory stand-in for the Prisma client used by the ETMS isolation matrix (isolation-matrix.spec.ts) for the E2
 * people routes. It evaluates the services' real where-clauses (AND / OR / NOT, in / notIn / not / contains, relation
 * is / isNot, JSON path equals) and hydrates the relations the services include, so tenant and branch scoping is
 * tested on the actual queries. Test-only; deliberately small: unknown filter shapes match (the services re-check
 * visibility in code), unknown relations hydrate to null.
 */
import { randomUUID } from 'crypto';

export type Obj = Record<string, unknown>;

const isPlain = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);

export function matches(row: Obj, where: Obj | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (cond === undefined) return true;
    if (k === 'AND') return (Array.isArray(cond) ? cond : [cond]).every((w) => matches(row, w as Obj));
    if (k === 'OR') return (cond as Obj[]).some((w) => matches(row, w));
    if (k === 'NOT') return !(Array.isArray(cond) ? cond : [cond]).some((w) => matches(row, w as Obj));
    const v = row[k];
    if (isPlain(cond)) {
      const c = cond;
      if ('in' in c) return (c.in as unknown[]).includes(v);
      if ('notIn' in c) return !(c.notIn as unknown[]).includes(v);
      if ('not' in c) return (v ?? null) !== c.not;
      if ('contains' in c) return typeof v === 'string' && v.toLowerCase().includes(String(c.contains).toLowerCase());
      if ('equals' in c && 'path' in c) return (c.path as string[]).reduce<unknown>((x, p) => (isPlain(x) ? x[p] : undefined), v) === c.equals;
      if ('is' in c) return c.is === null ? v === null || v === undefined : true;
      if ('isNot' in c) return c.isNot === null ? v !== null && v !== undefined : true;
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
};

const DEFAULTS: Record<string, () => Obj> = {
  user: () => ({ isActive: true, isSuperAdmin: false, passwordHash: null, lastLoginAt: null, email: null, mobile: null }),
  employeeTransportProfile: () => ({ isActive: true, branchId: null, userId: null, officePoiId: null, defaultStopPoiId: null, email: null, mobile: null, homeAddress: null, homeLat: null, homeLng: null, homeGeocodeSource: null, homeGeocodeConfidence: null, accessibility: {}, emergencyContacts: [] }),
  employeeTransportConsent: () => ({ occurredAt: new Date(), locale: null }),
};

export class MemoryStore {
  readonly tables: Record<string, Obj[]> = {};

  table(name: string): Obj[] {
    return (this.tables[name] ??= []);
  }

  insert(model: string, row: Obj): Obj {
    const now = new Date();
    const r: Obj = { id: randomUUID(), createdAt: now, updatedAt: now, ...(DEFAULTS[model]?.() ?? {}), ...row };
    this.table(model).push(r);
    return r;
  }

  private hydrate(model: string, row: Obj | undefined | null, shape: Obj | undefined): Obj | null {
    if (!row) return null;
    const out: Obj = { ...row };
    const spec = shape && (isPlain(shape.include) ? shape.include : isPlain(shape.select) ? shape.select : undefined);
    if (!spec) return out;
    for (const [name, sub] of Object.entries(spec)) {
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
  private split(model: string, data: Obj): { scalars: Obj; userRoles: Obj[] } {
    const scalars: Obj = {};
    let userRoles: Obj[] = [];
    for (const [k, v] of Object.entries(data)) {
      if (isPlain(v) && 'create' in v) {
        const rows = (Array.isArray(v.create) ? v.create : [v.create]) as Obj[];
        if (model === 'user' && k === 'roles') userRoles = rows;
        else scalars[k] = rows;
      } else if (isPlain(v) && 'increment' in v) {
        scalars[k] = { __inc: v.increment };
      } else scalars[k] = v;
    }
    return { scalars, userRoles };
  }

  private apply(model: string, row: Obj, data: Obj): void {
    const { scalars, userRoles } = this.split(model, data);
    for (const [k, v] of Object.entries(scalars)) row[k] = isPlain(v) && '__inc' in v ? (row[k] as number) + (v.__inc as number) : v;
    row.updatedAt = new Date();
    for (const ur of userRoles) this.table('userRole').push({ userId: row.id, ...ur });
  }

  model(model: string): Obj {
    const rows = () => this.table(model);
    const create = ({ data, ...shape }: Obj) => {
      const { scalars, userRoles } = this.split(model, data as Obj);
      const r = this.insert(model, scalars);
      for (const ur of userRoles) this.table('userRole').push({ userId: r.id, ...ur });
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
        if (prop === '$transaction') return async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as Promise<unknown>[]));
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
