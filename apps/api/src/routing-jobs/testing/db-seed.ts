import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type { AuthContext } from '../../access/auth-context';

/**
 * Synthetic scratch data for the routing-jobs DB and process tests (never real people or places). Companies are named
 * "etms-e4e-db-test …" and removed again by cleanupSeeded.
 */
export const TAG = 'etms-e4e-db-test';

export const ctxFor = (companyId: string): AuthContext =>
  ({ userId: randomUUID(), homeCompanyId: companyId, companyId, isSuperAdmin: false, permissions: {}, dataScope: 'COMPANY', branchIds: [], objectIds: [], features: ['etms'], ip: null }) as unknown as AuthContext;

export async function seedPartner(prisma: PrismaClient): Promise<string> {
  const [p] = await prisma.$queryRaw<{ id: string }[]>`INSERT INTO "Partner" (id, name, slug, "updatedAt") VALUES (gen_random_uuid(), ${TAG}, ${`${TAG}-${randomUUID()}`}, now()) RETURNING id`;
  return p.id;
}

/** Company + site + 3 consenting passengers with IN bookings + a DRAFT plan (2 vans, 3 pickups, 3 site drops). */
export async function seedPlan(prisma: PrismaClient, partnerId: string, companies: string[], name: string) {
  const id = () => randomUUID();
  const g = { company: id(), office: id(), shift: id(), plan: id(), vans: [id(), id()], profiles: [id(), id(), id()], bookings: [id(), id(), id()], pickups: [id(), id(), id()], drops: [id(), id(), id()] };
  companies.push(g.company);
  const sql = (s: string) => prisma.$executeRawUnsafe(s);
  await sql(`INSERT INTO "Company" (id, "partnerId", name, settings, "updatedAt") VALUES ('${g.company}', '${partnerId}', '${TAG} ${name}', '{"features":["etms"]}', now())`);
  await sql(`INSERT INTO "Poi" (id, "companyId", name, category, lat, lng, "updatedAt") VALUES ('${g.office}', '${g.company}', 'HQ', 'OFFICE', 13.0827, 80.2707, now())`);
  await sql(`INSERT INTO "TransportShift" (id, "companyId", "sitePoiId", name, "startMin", "endMin", overnight, days, "timeZone", "updatedAt") VALUES ('${g.shift}', '${g.company}', '${g.office}', 'Day', 540, 1080, false, '{1,2,3,4,5}', 'Asia/Kolkata', now())`);
  await sql(`INSERT INTO "RoutePlan" (id, "companyId", name, "planDate", "planStartAt", status, direction, "shiftId", "sitePoiId", depot, "updatedAt") VALUES ('${g.plan}', '${g.company}', 'Login', '2026-12-01', '2026-12-01T02:00:00Z', 'DRAFT', 'IN', '${g.shift}', '${g.office}', '{"lat":13.06,"lng":80.25}', now())`);
  for (const [i, v] of g.vans.entries()) {
    await sql(`INSERT INTO "RouteAssignment" (id, "planId", "companyId", "vehicleLabel", seq, capacity, "updatedAt") VALUES ('${v}', '${g.plan}', '${g.company}', 'Van ${i + 1}', ${i}, 4, now())`);
  }
  for (let i = 0; i < 3; i++) {
    const [lat, lng] = [13 + (i + 1) / 100, 80.2 + (i + 1) / 100];
    await sql(`INSERT INTO "EmployeeTransportProfile" (id, "companyId", "employeeCode", "displayName", "updatedAt") VALUES ('${g.profiles[i]}', '${g.company}', 'E${i}', 'Synthetic ${i}', now())`);
    await sql(`INSERT INTO "EmployeeTransportConsent" (id, "companyId", "profileId", purpose, "noticeVersion", granted, channel) VALUES (gen_random_uuid(), '${g.company}', '${g.profiles[i]}', 'TRANSPORT_PROFILE', 'v1', true, 'WEB')`);
    await sql(`INSERT INTO "TransportBooking" (id, "customerCompanyId", "providerCompanyId", "profileId", "shiftId", source, "serviceDate", direction, "timeZone", "pickupLat", "pickupLng", "dropPoiId", "dropLat", "dropLng", "windowStart", "windowEnd", status, "updatedAt")
      VALUES ('${g.bookings[i]}', '${g.company}', '${g.company}', '${g.profiles[i]}', '${g.shift}', 'ADHOC', '2026-12-01', 'IN', 'Asia/Kolkata', ${lat}, ${lng}, '${g.office}', 13.0827, 80.2707, '2026-12-01T02:00:00Z', '2026-12-01T03:00:00Z', 'ASSIGNED', now())`);
    await sql(`INSERT INTO "RoutePlanStop" (id, "planId", "companyId", ref, name, lat, lng, demand, "serviceS", "stopKind", "customerCompanyId", "bookingId", "profileId", "timeWindows", "updatedAt")
      VALUES ('${g.pickups[i]}', '${g.plan}', '${g.company}', 'p${i}', 'Passenger pickup', ${lat}, ${lng}, 1, 60, 'PICKUP', '${g.company}', '${g.bookings[i]}', '${g.profiles[i]}', NULL, now())`);
    await sql(`INSERT INTO "RoutePlanStop" (id, "planId", "companyId", ref, name, lat, lng, "stopKind", "customerCompanyId", "bookingId", "poiId", "timeWindows", "updatedAt")
      VALUES ('${g.drops[i]}', '${g.plan}', '${g.company}', 'd${i}', 'HQ', 13.0827, 80.2707, 'DROP', '${g.company}', '${g.bookings[i]}', '${g.office}', '[[3000,3600]]', now())`);
  }
  return g;
}

/** Removes everything seedPlan created (purge mode for the append-only consent evidence) and the partner. */
export async function cleanupSeeded(prisma: PrismaClient, companies: string[], partnerId: string): Promise<number> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('veetrax.evidence_write', 'purge', true)`);
    for (const c of companies) {
      for (const t of ['RoutingJob', 'RoutingUsage', 'RoutePlan', 'TransportBooking', 'EmployeeTransportConsent', 'EmployeeTransportProfile', 'TransportShift', 'Poi']) {
        await tx.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "${t === 'TransportBooking' ? 'customerCompanyId' : 'companyId'}" = '${c}'`);
      }
      await tx.$executeRawUnsafe(`DELETE FROM "Company" WHERE id = '${c}'`);
    }
    await tx.$executeRawUnsafe(`DELETE FROM "Partner" WHERE id = '${partnerId}'`);
  });
  const left = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Company" WHERE name LIKE ${`${TAG} %`}`;
  return Number(left[0].n);
}
