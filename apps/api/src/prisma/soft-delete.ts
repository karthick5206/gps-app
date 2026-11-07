import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Soft delete. "Delete" hides a row everywhere and keeps it (restorable by the Super Admin from Deleted items);
 * "Delete permanently" (purge) is the only hard delete. Decided 7 Nov 2026 after a personal account was lost to a
 * one-tap hard delete.
 *
 * - `withSoftDelete` adds `deletedAt: null` to every read of these models, in every process (API, processor,
 *   summarizer). A query that names `deletedAt` itself (e.g. `deletedAt: { not: null }` or `deletedAt: undefined`
 *   for "both") is left as written.
 * - Unique values (e-mail, mobile, IMEI, names) are freed so they can be reused; `deletedInfo` keeps the originals,
 *   the ended device links and the cascade, so Restore puts things back exactly (or says what clashes).
 */
export const SOFT_MODELS: ReadonlySet<string> = new Set(['Company', 'Branch', 'User', 'Device', 'TrackedObject', 'Driver', 'VehicleGroup', 'Geofence', 'Poi']);
const READS: ReadonlySet<string> = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy']);

export function withSoftDelete<T extends PrismaClient>(client: T): T {
  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (SOFT_MODELS.has(model) && READS.has(operation)) {
            const a = (args ?? {}) as { where?: Record<string, unknown> };
            const where = a.where ?? {};
            if (!('deletedAt' in where)) return query({ ...a, where: { ...where, deletedAt: null } } as typeof args);
          }
          return query(args);
        },
      },
    },
  }) as unknown as T;
}

export const SOFT_KINDS = ['company', 'branch', 'user', 'device', 'object', 'driver', 'group', 'geofence', 'poi'] as const;
export type SoftKind = (typeof SOFT_KINDS)[number];

type Db = Prisma.TransactionClient | PrismaClient;
type Info = {
  /** Original unique values, freed at delete. */
  orig?: Record<string, string | null>;
  /** Fields changed at delete (isActive, status) and their values before. */
  prev?: Record<string, unknown>;
  /** Device ↔ vehicle links ended at delete: [deviceId, objectId]. */
  links?: [string, string][];
  /** Rows deleted together with a company (restored with it). */
  cascade?: { kind: SoftKind; id: string }[];
  /** Deleted by the person themselves ("Delete my account"): permanently deleted after SELF_DELETE_DAYS. */
  self?: boolean;
  /** Deleted as part of a company's cascade (restored with the company, not on its own). */
  viaCompany?: string;
};

/** "Delete my account" stays restorable this long, then it is permanently deleted (app-store rule: deletion happens). */
export const SELF_DELETE_DAYS = 90;

const tomb = (value: string, id: string) => `${value} ~deleted~${id.slice(0, 8)}`;
const json = (v: Info) => v as unknown as Prisma.InputJsonValue;

/** Ends a device's open vehicle links; returns them for Restore. */
async function endLinks(db: Db, where: Prisma.DeviceAssignmentWhereInput, now: Date): Promise<[string, string][]> {
  const open = await db.deviceAssignment.findMany({ where: { ...where, toTime: null }, select: { id: true, deviceId: true, objectId: true } });
  if (open.length) await db.deviceAssignment.updateMany({ where: { id: { in: open.map((a) => a.id) } }, data: { toTime: now } });
  return open.map((a) => [a.deviceId, a.objectId]);
}

/** Soft-deletes one row (a company takes its users, devices and vehicles with it). Run inside a transaction. */
export async function softDelete(db: Db, kind: SoftKind, id: string, byUserId: string | null, opts: { self?: boolean; viaCompany?: string } = {}): Promise<void> {
  const now = new Date();
  const base = { deletedAt: now, deletedById: byUserId };
  const flags: Info = { ...(opts.self ? { self: true } : {}), ...(opts.viaCompany ? { viaCompany: opts.viaCompany } : {}) };
  switch (kind) {
    case 'user': {
      const u = await db.user.findUniqueOrThrow({ where: { id, deletedAt: null }, select: { email: true, mobile: true, isActive: true } });
      await db.user.update({ where: { id }, data: { ...base, email: null, mobile: null, isActive: false, deletedInfo: json({ ...flags, orig: { email: u.email, mobile: u.mobile }, prev: { isActive: u.isActive } }) } });
      await db.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now } });
      return;
    }
    case 'device': {
      const d = await db.device.findUniqueOrThrow({ where: { id, deletedAt: null }, select: { uniqueId: true, claimCode: true, isActive: true } });
      const links = await endLinks(db, { deviceId: id }, now);
      await db.device.update({ where: { id }, data: { ...base, uniqueId: tomb(d.uniqueId, id), claimCode: null, isActive: false, deletedInfo: json({ ...flags, orig: { uniqueId: d.uniqueId, claimCode: d.claimCode }, prev: { isActive: d.isActive }, links }) } });
      await db.mobileTrackerSession.updateMany({ where: { deviceId: id, revokedAt: null }, data: { revokedAt: now } });
      return;
    }
    case 'object': {
      const o = await db.trackedObject.findUniqueOrThrow({ where: { id, deletedAt: null }, select: { isActive: true } });
      const links = await endLinks(db, { objectId: id }, now);
      await db.driverAssignment.updateMany({ where: { objectId: id, toTime: null }, data: { toTime: now } });
      await db.trackedObject.update({ where: { id }, data: { ...base, isActive: false, deletedInfo: json({ ...flags, prev: { isActive: o.isActive }, links }) } });
      return;
    }
    case 'company': {
      const c = await db.company.findUniqueOrThrow({ where: { id, deletedAt: null }, select: { status: true } });
      const cascade: Info['cascade'] = [];
      for (const u of await db.user.findMany({ where: { companyId: id }, select: { id: true } })) {
        await softDelete(db, 'user', u.id, byUserId, { self: opts.self, viaCompany: id });
        cascade.push({ kind: 'user', id: u.id });
      }
      for (const d of await db.device.findMany({ where: { companyId: id }, select: { id: true } })) {
        await softDelete(db, 'device', d.id, byUserId, { self: opts.self, viaCompany: id });
        cascade.push({ kind: 'device', id: d.id });
      }
      for (const o of await db.trackedObject.findMany({ where: { companyId: id }, select: { id: true } })) {
        await softDelete(db, 'object', o.id, byUserId, { self: opts.self, viaCompany: id });
        cascade.push({ kind: 'object', id: o.id });
      }
      await db.company.update({ where: { id }, data: { ...base, status: 'SUSPENDED', deletedInfo: json({ ...flags, prev: { status: c.status }, cascade }) } });
      return;
    }
    case 'driver': {
      const d = await db.driver.findUniqueOrThrow({ where: { id, deletedAt: null }, select: { rfidTag: true, employeeId: true, isActive: true } });
      await db.driverAssignment.updateMany({ where: { driverId: id, toTime: null }, data: { toTime: now } });
      await db.driver.update({ where: { id }, data: { ...base, rfidTag: null, employeeId: null, isActive: false, deletedInfo: json({ ...flags, orig: { rfidTag: d.rfidTag, employeeId: d.employeeId }, prev: { isActive: d.isActive } }) } });
      return;
    }
    case 'branch':
    case 'group':
    case 'geofence':
    case 'poi': {
      const m = nameModel(db, kind);
      const r = await m.findUniqueOrThrow({ where: { id, deletedAt: null }, select: { name: true, isActive: true } });
      await m.update({ where: { id }, data: { ...base, name: tomb(r.name, id), isActive: false, deletedInfo: json({ ...flags, orig: { name: r.name }, prev: { isActive: r.isActive } }) } });
      return;
    }
  }
}

/** Branch / group / geofence / POI: same shape (unique name per company, isActive). */
function nameModel(db: Db, kind: 'branch' | 'group' | 'geofence' | 'poi') {
  const m = { branch: db.branch, group: db.vehicleGroup, geofence: db.geofence, poi: db.poi }[kind];
  return m as unknown as {
    findUniqueOrThrow: (a: { where: { id: string; deletedAt: unknown }; select: { name: true; isActive: true } }) => Promise<{ name: string; isActive: boolean }>;
    findFirst: (a: { where: Record<string, unknown>; select: { id: true } }) => Promise<{ id: string } | null>;
    update: (a: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
  };
}

/** Undoes softDelete. Returns what could not be put back (a freed value reused meanwhile, a link now taken). */
export async function restore(db: Db, kind: SoftKind, id: string): Promise<string[]> {
  const warn: string[] = [];
  const back = { deletedAt: null, deletedById: null, deletedInfo: Prisma.DbNull };
  const relink = async (links: [string, string][] | undefined) => {
    for (const [deviceId, objectId] of links ?? []) {
      const busy = await db.deviceAssignment.findFirst({ where: { toTime: null, OR: [{ deviceId }, { objectId }] }, select: { id: true } });
      if (busy) warn.push('A device link was not restored: the device or vehicle is linked to something else now.');
      else await db.deviceAssignment.create({ data: { deviceId, objectId, fromTime: new Date() } });
    }
  };
  switch (kind) {
    case 'user': {
      const u = await db.user.findUniqueOrThrow({ where: { id, deletedAt: { not: null } }, select: { deletedInfo: true } });
      const i = (u.deletedInfo ?? {}) as Info;
      const data: Prisma.UserUpdateInput = { ...back, isActive: (i.prev?.isActive as boolean | undefined) ?? true };
      for (const f of ['email', 'mobile'] as const) {
        const v = i.orig?.[f];
        if (!v) continue;
        if (await db.user.findFirst({ where: { [f]: v, deletedAt: undefined }, select: { id: true } })) warn.push(`The ${f} ${v} is used by another user now, so it was left empty.`);
        else data[f] = v;
      }
      await db.user.update({ where: { id }, data });
      break;
    }
    case 'device': {
      const d = await db.device.findUniqueOrThrow({ where: { id, deletedAt: { not: null } }, select: { deletedInfo: true, uniqueId: true } });
      const i = (d.deletedInfo ?? {}) as Info;
      const orig = i.orig?.uniqueId ?? d.uniqueId;
      if (await db.device.findFirst({ where: { uniqueId: orig, deletedAt: undefined, id: { not: id } }, select: { id: true } })) {
        throw new Error(`The IMEI / number ${orig} belongs to another device now; delete or change that one first.`);
      }
      await db.device.update({ where: { id }, data: { ...back, uniqueId: orig, claimCode: i.orig?.claimCode ?? null, isActive: (i.prev?.isActive as boolean | undefined) ?? true } });
      await relink(i.links);
      break;
    }
    case 'object': {
      const o = await db.trackedObject.findUniqueOrThrow({ where: { id, deletedAt: { not: null } }, select: { deletedInfo: true } });
      const i = (o.deletedInfo ?? {}) as Info;
      await db.trackedObject.update({ where: { id }, data: { ...back, isActive: (i.prev?.isActive as boolean | undefined) ?? true } });
      await relink(i.links);
      break;
    }
    case 'company': {
      const c = await db.company.findUniqueOrThrow({ where: { id, deletedAt: { not: null } }, select: { deletedInfo: true } });
      const i = (c.deletedInfo ?? {}) as Info;
      await db.company.update({ where: { id }, data: { ...back, status: (i.prev?.status as 'ACTIVE' | 'SUSPENDED' | undefined) ?? 'ACTIVE' } });
      // Devices before vehicles so the links come back.
      const order: SoftKind[] = ['user', 'device', 'object'];
      for (const k of order) for (const r of (i.cascade ?? []).filter((x) => x.kind === k)) warn.push(...(await restore(db, r.kind, r.id).catch((e: Error) => [e.message])));
      break;
    }
    case 'driver': {
      const d = await db.driver.findUniqueOrThrow({ where: { id, deletedAt: { not: null } }, select: { deletedInfo: true, companyId: true } });
      const i = (d.deletedInfo ?? {}) as Info;
      const data: Prisma.DriverUpdateInput = { ...back, isActive: (i.prev?.isActive as boolean | undefined) ?? true };
      for (const f of ['rfidTag', 'employeeId'] as const) {
        const v = i.orig?.[f];
        if (!v) continue;
        if (await db.driver.findFirst({ where: { companyId: d.companyId, [f]: v, deletedAt: undefined }, select: { id: true } })) warn.push(`The ${f === 'rfidTag' ? 'RFID tag' : 'employee ID'} ${v} is used by another driver now, so it was left empty.`);
        else data[f] = v;
      }
      await db.driver.update({ where: { id }, data });
      break;
    }
    case 'branch':
    case 'group':
    case 'geofence':
    case 'poi': {
      const m = nameModel(db, kind);
      const r = (await (m as unknown as { findUniqueOrThrow: (a: unknown) => Promise<{ deletedInfo: unknown; companyId: string; name: string }> }).findUniqueOrThrow({
        where: { id, deletedAt: { not: null } },
        select: { deletedInfo: true, companyId: true, name: true },
      })) as { deletedInfo: unknown; companyId: string; name: string };
      const i = (r.deletedInfo ?? {}) as Info;
      let name = i.orig?.name ?? r.name;
      if (await m.findFirst({ where: { companyId: r.companyId, name, deletedAt: undefined, NOT: { id } }, select: { id: true } })) {
        warn.push(`The name "${name}" is used now, so it was restored as "${name} (restored)".`);
        name = `${name} (restored)`;
      }
      await m.update({ where: { id }, data: { ...back, name, isActive: (i.prev?.isActive as boolean | undefined) ?? true } });
      break;
    }
  }
  return warn;
}
