/**
 * Idempotent seed: platform + Super Admin, device models, system lookups and the "Demo Logistics" company with
 * users, 20 GT06 devices/objects and 2 vehicle groups. Safe to run repeatedly; existing passwords are never reset.
 */
import { Prisma, PrismaClient, VehicleType } from '@prisma/client';
import { SYSTEM_ROLES, VEHICLE_TYPES } from '@veetracer/shared';
import { ensureSystemRoles } from '../src/access/system-roles';
import { geometryBBox } from '../src/alerts/logic/geofence-geometry';
import { systemTemplates } from '../src/templates/system-templates';
import { hashPassword, randomToken } from '../src/common/secrets';
import { loadEnv } from '../src/config/env';

loadEnv();
const prisma = new PrismaClient();

const GT06_CAPABILITIES = ['ignition', 'sos', 'power_cut', 'engine_cut', 'battery', 'lbs'];
const GT06_FIELDS = [
  { key: 'batteryLevel', label: 'Battery', unit: '%', type: 'number' },
  { key: 'gsmSignal', label: 'GSM signal', type: 'number' },
  { key: 'charging', label: 'Charging', type: 'boolean' },
  { key: 'ignition', label: 'Ignition', type: 'boolean' },
];
const GT06_COMMANDS = [
  { key: 'engine_stop', label: 'Stop engine' },
  { key: 'engine_resume', label: 'Resume engine' },
];

const LOOKUPS: Record<string, string[]> = {
  VEHICLE_TYPE: [...VEHICLE_TYPES],
  FUEL_TYPE: ['PETROL', 'DIESEL', 'CNG', 'LPG', 'ELECTRIC', 'HYBRID'],
  LICENCE_CLASS: ['LMV', 'MCWG', 'HMV', 'HGMV', 'HPMV', 'TRANS'],
  DOCUMENT_TYPE: ['RC', 'INSURANCE', 'PUC', 'FITNESS', 'PERMIT', 'ROAD_TAX', 'DRIVING_LICENCE'],
  GEOFENCE_CATEGORY: ['DEPOT', 'CUSTOMER', 'FUEL_STATION', 'SERVICE_CENTER', 'SCHOOL', 'RESTRICTED'],
  VEHICLE_MAKE: ['TATA', 'ASHOK_LEYLAND', 'MAHINDRA', 'MARUTI_SUZUKI', 'HYUNDAI', 'TOYOTA', 'EICHER', 'BAJAJ', 'HERO', 'TVS', 'HONDA', 'ROYAL_ENFIELD'],
};
const LABEL_OVERRIDES: Record<string, string> = {
  CNG: 'CNG', LPG: 'LPG', LMV: 'LMV', MCWG: 'MCWG', HMV: 'HMV', HGMV: 'HGMV', HPMV: 'HPMV', RC: 'RC', PUC: 'PUC',
  TVS: 'TVS', SCHOOL_BUS: 'School bus', TRANS: 'Transport',
};
const label = (code: string) =>
  LABEL_OVERRIDES[code] ?? code.toLowerCase().replace(/_/g, ' ').replace(/(^|\s)\S/g, (c) => c.toUpperCase());

const DEMO_TYPES: { vehicleType: VehicleType; prefix: string; make: string }[] = [
  { vehicleType: 'CAR', prefix: 'Car', make: 'Hyundai' },
  { vehicleType: 'TRUCK', prefix: 'Truck', make: 'Tata' },
  { vehicleType: 'BUS', prefix: 'Bus', make: 'Ashok Leyland' },
  { vehicleType: 'BIKE', prefix: 'Bike', make: 'TVS' },
];
const LETTERS = ['AB', 'CD', 'EF', 'GH', 'JK', 'LM', 'NP', 'QR', 'ST', 'UV'];

async function upsertUser(data: {
  companyId: string;
  name: string;
  email: string;
  mobile?: string;
  password: string;
  isSuperAdmin?: boolean;
}) {
  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) {
    return prisma.user.update({
      where: { id: existing.id },
      data: { companyId: data.companyId, name: data.name, mobile: data.mobile ?? existing.mobile, isActive: true },
    });
  }
  return prisma.user.create({
    data: {
      companyId: data.companyId,
      name: data.name,
      email: data.email,
      mobile: data.mobile,
      passwordHash: await hashPassword(data.password),
      isSuperAdmin: data.isSuperAdmin ?? false,
    },
  });
}

async function link(userId: string, roleIds: string[], branchIds: string[], objectIds: string[]) {
  await prisma.userRole.createMany({ data: roleIds.map((roleId) => ({ userId, roleId })), skipDuplicates: true });
  await prisma.userBranch.createMany({ data: branchIds.map((branchId) => ({ userId, branchId })), skipDuplicates: true });
  await prisma.userObject.createMany({ data: objectIds.map((objectId) => ({ userId, objectId })), skipDuplicates: true });
}

async function main() {
  const partner = await prisma.partner.upsert({
    where: { slug: 'veetracer' },
    update: {},
    create: { name: 'VeeTracer', slug: 'veetracer' },
  });

  const platform =
    (await prisma.company.findFirst({ where: { isPlatform: true } })) ??
    (await prisma.company.create({ data: { partnerId: partner.id, name: 'VeeTracer Platform', isPlatform: true } }));

  await upsertUser({
    companyId: platform.id,
    name: 'Super Admin',
    email: 'admin@veetracer.local',
    mobile: '+919999900000',
    password: 'Admin@12345',
    isSuperAdmin: true,
  });

  const models = new Map<string, string>();
  for (const [brand, model, protocol] of [
    ['Concox', 'GT06N', 'GT06'],
    ['Concox', 'WeTrack2', 'GT06'],
    ['Concox', 'AT4', 'GT06'],
    ['Generic', 'Phone', 'PHONE'],
  ]) {
    const isGt06 = protocol === 'GT06';
    const data = {
      protocol,
      capabilities: isGt06 ? GT06_CAPABILITIES : ['battery'],
      fields: isGt06 ? GT06_FIELDS : [{ key: 'batteryLevel', label: 'Battery', unit: '%', type: 'number' }],
      commands: isGt06 ? GT06_COMMANDS : [],
    };
    const row = await prisma.deviceModel.upsert({
      where: { brand_model: { brand, model } },
      update: data,
      create: { brand, model, ...data },
    });
    models.set(model, row.id);
  }

  for (const [type, codes] of Object.entries(LOOKUPS)) {
    for (const [index, code] of codes.entries()) {
      const existing = await prisma.lookup.findFirst({ where: { companyId: null, type, code } });
      const data = { label: label(code), sortOrder: (index + 1) * 10 };
      if (existing) await prisma.lookup.update({ where: { id: existing.id }, data });
      else await prisma.lookup.create({ data: { type, code, ...data } });
    }
  }

  const demo =
    (await prisma.company.findFirst({ where: { name: 'Demo Logistics', isPlatform: false } })) ??
    (await prisma.company.create({ data: { partnerId: partner.id, name: 'Demo Logistics', accountType: 'BUSINESS' } }));
  const roles = await ensureSystemRoles(prisma, demo.id);

  const branch = async (name: string, code: string) =>
    prisma.branch.upsert({
      where: { companyId_name: { companyId: demo.id, name } },
      update: {},
      create: { companyId: demo.id, name, code },
    });
  const chennai = await branch('Chennai', 'CHN');
  const coimbatore = await branch('Coimbatore', 'CBE');

  const gt06n = models.get('GT06N')!;
  const objects: { id: string; vehicleType: VehicleType; branchId: string }[] = [];
  for (let i = 1; i <= 20; i++) {
    const uniqueId = `86812000000${String(i).padStart(4, '0')}`;
    const device = await prisma.device.upsert({
      where: { uniqueId },
      update: {},
      create: { uniqueId, modelId: gt06n, companyId: demo.id, ingestToken: randomToken(24), simNumber: `+9190000${String(i).padStart(5, '0')}`, simOperator: 'Airtel' },
    });
    const kind = DEMO_TYPES[(i - 1) % DEMO_TYPES.length];
    const plateNumber = `TN-${String(1 + ((i * 7) % 38)).padStart(2, '0')}-${LETTERS[i % LETTERS.length]}-${1000 + i * 37}`;
    const branchId = i <= 10 ? chennai.id : coimbatore.id;
    const object =
      (await prisma.trackedObject.findFirst({ where: { companyId: demo.id, plateNumber } })) ??
      (await prisma.trackedObject.create({
        data: {
          companyId: demo.id,
          branchId,
          type: 'VEHICLE',
          vehicleType: kind.vehicleType,
          name: `${kind.prefix} ${String(i).padStart(2, '0')}`,
          plateNumber,
          make: kind.make,
        },
      }));
    objects.push({ id: object.id, vehicleType: kind.vehicleType, branchId });

    const open = await prisma.deviceAssignment.count({
      where: { toTime: null, OR: [{ deviceId: device.id }, { objectId: object.id }] },
    });
    if (!open) await prisma.deviceAssignment.create({ data: { deviceId: device.id, objectId: object.id } });
  }

  const demoAdmin = await upsertUser({
    companyId: demo.id,
    name: 'Demo Admin',
    email: 'demo.admin@veetracer.local',
    mobile: '+919999900001',
    password: 'Demo@12345',
  });
  await link(demoAdmin.id, [roles.get('Admin')!], [chennai.id, coimbatore.id], []);

  const manager = await upsertUser({
    companyId: demo.id,
    name: 'Chennai Manager',
    email: 'chennai.manager@veetracer.local',
    password: 'Demo@12345',
  });
  await link(manager.id, [roles.get('Manager')!], [chennai.id], []);

  const viewer = await upsertUser({
    companyId: demo.id,
    name: 'Demo Viewer',
    email: 'viewer@veetracer.local',
    password: 'Demo@12345',
  });
  // Two Chennai vehicles and one Coimbatore vehicle: mapping is per object, independent of branches.
  await link(viewer.id, [roles.get('Viewer')!], [], [objects[0].id, objects[1].id, objects[14].id]);

  const group = async (name: string, description: string, members: string[]) => {
    const row = await prisma.vehicleGroup.upsert({
      where: { companyId_name: { companyId: demo.id, name } },
      update: {},
      create: { companyId: demo.id, name, description },
    });
    await prisma.vehicleGroupMember.createMany({
      data: members.map((objectId) => ({ groupId: row.id, objectId })),
      skipDuplicates: true,
    });
  };
  await group(
    'Heavy Vehicles',
    'Trucks and buses',
    objects.filter((o) => o.vehicleType === 'TRUCK' || o.vehicleType === 'BUS').map((o) => o.id),
  );
  await group(
    'Chennai City',
    'Cars and bikes in Chennai',
    objects.filter((o) => o.branchId === chennai.id && (o.vehicleType === 'CAR' || o.vehicleType === 'BIKE')).map((o) => o.id),
  );

  await seedM2a(demo.id, { chennai: chennai.id }, demoAdmin.email!, demoAdmin.mobile ?? '+919999900001');
  await syncSystemRoleMenus();

  const counts = {
    companies: await prisma.company.count(),
    users: await prisma.user.count(),
    devices: await prisma.device.count(),
    objects: await prisma.trackedObject.count(),
    lookups: await prisma.lookup.count({ where: { companyId: null } }),
    systemTemplates: await prisma.messageTemplate.count({ where: { companyId: null } }),
    systemPacks: await prisma.alertPack.count({ where: { companyId: null } }),
    geofences: await prisma.geofence.count(),
  };
  console.log('Seed complete', counts);
}

// ───────────────────────────── M2a ─────────────────────────────

type PackSetting = {
  alertType: string;
  enabled?: boolean | null;
  params?: Record<string, unknown>;
  severity?: 'INFO' | 'WARNING' | 'CRITICAL' | null;
  cooldownMin?: number | null;
};

const SYSTEM_PACKS: { name: string; description: string; settings: PackSetting[] }[] = [
  {
    name: 'School bus',
    description: 'Strict 40 km/h limit, short idling, entry/exit at stops and SOS',
    settings: [
      { alertType: 'OVERSPEED', enabled: true, params: { limitKph: 40, toleranceKph: 0, minDurationSec: 5, criticalOverKph: 10 } },
      { alertType: 'IDLING', enabled: true, params: { thresholdMin: 5, criticalMin: 15 } },
      { alertType: 'GEOFENCE_ENTER', enabled: true },
      { alertType: 'GEOFENCE_EXIT', enabled: true },
      { alertType: 'IGNITION_ON', enabled: true },
      { alertType: 'SOS', enabled: true, severity: 'CRITICAL' },
    ],
  },
  {
    name: 'Truck',
    description: '60 km/h limit, long-idle and tamper alerts, long stays at sites',
    settings: [
      { alertType: 'OVERSPEED', enabled: true, params: { limitKph: 60, toleranceKph: 5, minDurationSec: 20 } },
      { alertType: 'IDLING', enabled: true, params: { thresholdMin: 15, criticalMin: 45 } },
      { alertType: 'POWER_CUT', enabled: true, severity: 'CRITICAL' },
      { alertType: 'GEOFENCE_STAY', enabled: true },
    ],
  },
  {
    name: 'Two-wheeler',
    description: 'Theft-oriented: ignition on, power cut and low battery',
    settings: [
      { alertType: 'OVERSPEED', enabled: true, params: { limitKph: 60 } },
      { alertType: 'IGNITION_ON', enabled: true },
      { alertType: 'POWER_CUT', enabled: true, severity: 'CRITICAL' },
      { alertType: 'LOW_BATTERY', enabled: true, params: { thresholdPct: 30 } },
      { alertType: 'IDLING', enabled: false },
    ],
  },
  {
    name: 'Pet',
    description: 'Location only: leaving a safe zone is critical, battery warnings',
    settings: [
      { alertType: 'OVERSPEED', enabled: false },
      { alertType: 'IDLING', enabled: false },
      { alertType: 'IGNITION_ON', enabled: false },
      { alertType: 'IGNITION_OFF', enabled: false },
      { alertType: 'GEOFENCE_EXIT', enabled: true, severity: 'CRITICAL' },
      { alertType: 'LOW_BATTERY', enabled: true, params: { thresholdPct: 25 } },
    ],
  },
];

const fullPackSetting = (s: PackSetting) => ({
  alertType: s.alertType,
  enabled: s.enabled ?? null,
  params: s.params ?? {},
  schedule: null,
  cooldownMin: s.cooldownMin ?? null,
  severity: s.severity ?? null,
  channels: null,
});

async function seedM2a(companyId: string, branches: { chennai: string }, adminEmail: string, adminMobile: string) {
  // System message templates (never overwrite later edits).
  for (const t of systemTemplates()) {
    const existing = await prisma.messageTemplate.findFirst({ where: { companyId: null, purpose: t.purpose, channel: t.channel, language: 'en' } });
    if (existing) continue;
    await prisma.messageTemplate.create({
      data: {
        companyId: null,
        purpose: t.purpose,
        channel: t.channel,
        language: 'en',
        name: t.name,
        subject: t.subject,
        body: t.body,
        dltTemplateId: t.dltTemplateId,
        senderId: t.senderId,
        approvalStatus: t.approvalStatus,
        isActive: true,
        version: 1,
        versions: { create: { version: 1, subject: t.subject, body: t.body } },
      },
    });
  }

  for (const pack of SYSTEM_PACKS) {
    const existing = await prisma.alertPack.findFirst({ where: { companyId: null, name: pack.name } });
    if (existing) continue;
    await prisma.alertPack.create({
      data: { companyId: null, name: pack.name, description: pack.description, settings: pack.settings.map(fullPackSetting) as Prisma.InputJsonValue },
    });
  }

  // Demo company: default recipients (all alerts, all severities) and company-level overrides.
  const lists: { channel: 'EMAIL' | 'SMS'; entries: { kind: string; value: string; label: string }[] }[] = [
    { channel: 'EMAIL', entries: [{ kind: 'EMAIL', value: adminEmail, label: 'Demo Admin' }] },
    { channel: 'SMS', entries: [{ kind: 'MOBILE', value: adminMobile, label: 'Demo Admin' }] },
  ];
  for (const l of lists) {
    const key = { companyId, level: 'COMPANY' as const, targetId: companyId, alertType: '*', channel: l.channel, severity: '*' };
    const existing = await prisma.recipientList.findUnique({ where: { companyId_level_targetId_alertType_channel_severity: key } });
    if (!existing) await prisma.recipientList.create({ data: { ...key, mode: 'DEFAULT', entries: l.entries } });
  }
  for (const [alertType, params] of [
    ['OVERSPEED', { toleranceKph: 5 }],
    ['IDLING', { thresholdMin: 10 }],
  ] as const) {
    const key = { companyId, level: 'COMPANY' as const, targetId: companyId, alertType };
    const existing = await prisma.alertSetting.findUnique({ where: { companyId_level_targetId_alertType: key } });
    if (!existing) await prisma.alertSetting.create({ data: { ...key, params } });
  }

  // Three geofences inside the simulator's area (13.00–13.15 N, 80.18–80.30 E).
  const geofences: {
    name: string;
    category: string;
    color: string;
    branchId: string | null;
    mode: 'NORMAL' | 'NO_GO' | 'KEEP_IN';
    maxStayMin?: number;
    speedLimitKph?: number;
    address?: string;
    geometry: { type: 'CIRCLE'; center: { lat: number; lng: number }; radiusM: number } | { type: 'POLYGON'; points: { lat: number; lng: number }[] };
  }[] = [
    {
      name: 'Depot',
      category: 'DEPOT',
      color: '#0f766e',
      branchId: branches.chennai,
      mode: 'NORMAL',
      address: 'Demo Logistics depot, Chennai',
      geometry: { type: 'CIRCLE', center: { lat: 13.0604, lng: 80.2496 }, radiusM: 300 },
    },
    {
      name: 'Industrial Estate',
      category: 'CUSTOMER',
      color: '#2563eb',
      branchId: null,
      mode: 'NORMAL',
      maxStayMin: 60,
      speedLimitKph: 30,
      address: 'Guindy Industrial Estate, Chennai',
      geometry: {
        type: 'POLYGON',
        points: [
          { lat: 13.0035, lng: 80.201 },
          { lat: 13.0035, lng: 80.2185 },
          { lat: 13.0165, lng: 80.2185 },
          { lat: 13.018, lng: 80.206 },
          { lat: 13.011, lng: 80.1995 },
        ],
      },
    },
    {
      name: 'Restricted Zone',
      category: 'RESTRICTED',
      color: '#dc2626',
      branchId: null,
      mode: 'NO_GO',
      geometry: { type: 'CIRCLE', center: { lat: 13.12, lng: 80.28 }, radiusM: 500 },
    },
  ];
  for (const g of geofences) {
    const exists = await prisma.geofence.findUnique({ where: { companyId_name: { companyId, name: g.name } } });
    if (exists) continue;
    await prisma.geofence.create({
      data: {
        companyId,
        name: g.name,
        category: g.category,
        color: g.color,
        branchId: g.branchId,
        mode: g.mode,
        maxStayMin: g.maxStayMin ?? null,
        speedLimitKph: g.speedLimitKph ?? null,
        address: g.address ?? null,
        type: g.geometry.type,
        geometry: g.geometry,
        ...geometryBBox(g.geometry),
      },
    });
  }

  // Group priorities for conflict resolution (only when still at the default).
  await prisma.vehicleGroup.updateMany({ where: { companyId, name: 'Heavy Vehicles', alertPriority: 0 }, data: { alertPriority: 10 } });
  await prisma.vehicleGroup.updateMany({ where: { companyId, name: 'Chennai City', alertPriority: 0 }, data: { alertPriority: 5 } });
}

/** Add menus present in SYSTEM_ROLES that existing system roles don't have yet; never remove or alter grants. */
async function syncSystemRoleMenus() {
  const roles = await prisma.role.findMany({ where: { isSystem: true }, include: { permissions: true } });
  let added = 0;
  for (const role of roles) {
    const def = SYSTEM_ROLES.find((r) => r.name === role.name);
    if (!def) continue;
    const have = new Set(role.permissions.map((p) => p.menu));
    const missing = Object.entries(def.permissions).filter(([menu]) => !have.has(menu));
    if (!missing.length) continue;
    await prisma.rolePermission.createMany({
      data: missing.map(([menu, actions]) => ({ roleId: role.id, menu, actions: actions ?? [] })),
      skipDuplicates: true,
    });
    added += missing.length;
  }
  console.log(`System role menu sync: ${added} grant(s) added`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
