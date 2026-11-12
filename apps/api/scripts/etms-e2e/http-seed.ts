/**
 * Accounts for the HTTP stage of the ETMS E3 gate, written straight into the scratch database (synthetic only):
 * - IST customer (branches North / South): Transport admin, North-only Transport dispatcher, a fleet user without any
 *   ETMS menu, a second admin for the rate-limit probe, and passenger logins (Transport passenger) on the first
 *   passengers; GT06 devices (simulator IMEI range 86812000…) fitted to its vehicles;
 * - CTRL (another etms tenant) admin; OFF (etms add-on off) admin with the Transport admin template.
 * Roles come from the real ETMS templates (`ensureEtmsRoleTemplates`), so the permission checks are the product's.
 */
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { ensureEtmsRoleTemplates } from '../../src/etms/etms-role-templates';
import { planE3Synthetic, seedE3Synthetic, type E3Company } from '../../src/etms/testing/e3-synthetic';

export const HTTP_PASSWORD = 'E3hPass2026x';

export interface HttpUser {
  id: string;
  email: string;
}
export interface HttpAccounts {
  tag: string;
  ist: E3Company;
  ctrl: E3Company;
  off: E3Company;
  users: { admin: HttpUser; dispNorth: HttpUser; fleet: HttpUser; heavy: HttpUser; ctrlAdmin: HttpUser; offAdmin: HttpUser; passengers: HttpUser[] };
  devices: Record<string, string>; // objectId → IMEI
}

/** `size` (E5 WP 5.5 scenarios): more IST passengers / logins / drivers than the E3 stage needs; defaults unchanged. */
export async function seedHttpAccounts(prisma: PrismaClient, tag: string, size: { passengers?: number; logins?: number; drivers?: number } = {}): Promise<HttpAccounts> {
  const [existing] = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Partner" LIMIT 1`;
  const partnerId =
    existing?.id ?? (await prisma.$queryRaw<{ id: string }[]>`INSERT INTO "Partner" (id, name, slug, "updatedAt") VALUES (gen_random_uuid(), 'etms-e3-http partner', 'etms-e3-http-' || gen_random_uuid(), now()) RETURNING id`)[0].id;
  const plan = planE3Synthetic({
    tag,
    companies: [
      { key: 'HTTP-IST', kind: 'CUSTOMER', timezone: 'Asia/Kolkata', passengers: size.passengers ?? 12, logins: size.logins ?? 4, branches: ['North', 'South'], vehicles: [6, 6, 4, 4, 6, null], drivers: size.drivers ?? 2, shifts: [{ key: 'day', name: 'Day 09:00-18:00', startMin: 540, endMin: 1080, days: [0, 1, 2, 3, 4, 5, 6] }] },
      { key: 'HTTP-CTRL', kind: 'CONTROL', timezone: 'Asia/Kolkata', passengers: 2, vehicles: [4] },
      { key: 'HTTP-OFF', kind: 'ETMS_OFF', timezone: 'Asia/Kolkata', passengers: 0, vehicles: [4] },
    ],
  });
  await seedE3Synthetic(prisma, plan, partnerId);
  const [ist, ctrl, off] = plan.companies;
  for (const c of plan.companies) await ensureEtmsRoleTemplates(prisma, c.id);
  const role = async (companyId: string, name: string) => (await prisma.role.findUniqueOrThrow({ where: { companyId_name: { companyId, name } } })).id;
  const fleetRole = await prisma.role.create({ data: { companyId: ist.id, name: `${tag} fleet user`, description: 'synthetic: objects only, no ETMS menu', dataScope: 'COMPANY', isSystem: false, permissions: { create: [{ menu: 'objects', actions: ['view'] }] } } });
  const pw = await hash(HTTP_PASSWORD, 4);
  const user = async (companyId: string, key: string, roleId: string, branchIds: string[] = []): Promise<HttpUser> => {
    const id = randomUUID();
    const email = `${tag}.${key}@example.test`;
    await prisma.user.create({ data: { id, companyId, name: `${tag} ${key}`, email, passwordHash: pw, roles: { create: [{ roleId }] }, branches: { create: branchIds.map((branchId) => ({ branchId })) } } });
    return { id, email };
  };
  const users = {
    admin: await user(ist.id, 'admin', await role(ist.id, 'Transport admin')),
    dispNorth: await user(ist.id, 'disp-north', await role(ist.id, 'Transport dispatcher'), [ist.branches[0].id]),
    fleet: await user(ist.id, 'fleet', fleetRole.id),
    heavy: await user(ist.id, 'heavy', await role(ist.id, 'Transport admin')),
    ctrlAdmin: await user(ctrl.id, 'ctrl-admin', await role(ctrl.id, 'Transport admin')),
    offAdmin: await user(off.id, 'off-admin', await role(off.id, 'Transport admin')),
    passengers: [] as HttpUser[],
  };
  // Passenger logins: the seeder created the User rows linked to the profiles; give them a login + the template role.
  const passengerRole = await role(ist.id, 'Transport passenger');
  for (const p of ist.passengers.filter((x) => x.userId)) {
    const email = `${tag}.${p.employeeCode.toLowerCase()}@example.test`;
    await prisma.user.update({ where: { id: p.userId! }, data: { email, passwordHash: pw, roles: { create: [{ roleId: passengerRole }] } } });
    users.passengers.push({ id: p.userId!, email });
  }
  // GT06 devices on the IST vehicles (the processor resolves positions by IMEI → current assignment → object).
  const model = await prisma.deviceModel.create({ data: { brand: 'E3H synthetic', model: `GT06 ${tag}`, protocol: 'gt06', capabilities: [] } });
  const devices: Record<string, string> = {};
  const base = 868120007000000 + (Date.now() % 900_000);
  for (const [i, v] of ist.vehicles.entries()) {
    const imei = String(base + i);
    const d = await prisma.device.create({ data: { companyId: ist.id, modelId: model.id, uniqueId: imei, ingestToken: randomUUID(), firmware: tag } });
    await prisma.deviceAssignment.create({ data: { deviceId: d.id, objectId: v.id } });
    devices[v.id] = imei;
  }
  return { tag, ist, ctrl, off, users, devices };
}
