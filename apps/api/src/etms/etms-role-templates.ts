import { Prisma, PrismaClient } from '@prisma/client';
import { ETMS_E2_TEMPLATE_PERMISSIONS, ETMS_E3_TEMPLATE_PERMISSIONS, ETMS_E4_TEMPLATE_PERMISSIONS, ETMS_E5_TEMPLATE_PERMISSIONS, ETMS_ROLE_TEMPLATES, type PermissionMap } from '@veetracer/shared';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * P6 / WP 1a.2: create the ETMS role templates in a company when its `etms` add-on is switched on. Never part of the
 * global SYSTEM_ROLES, no change to existing roles. Idempotent: a role with the same name (an earlier seed, or the
 * company's own role) is left exactly as it is. Templates are ordinary editable roles (isSystem = false).
 * Returns the names of the roles created now.
 */
export async function ensureEtmsRoleTemplates(db: Db, companyId: string): Promise<string[]> {
  const created: string[] = [];
  for (const def of ETMS_ROLE_TEMPLATES) {
    const existing = await db.role.findUnique({ where: { companyId_name: { companyId, name: def.name } }, select: { id: true } });
    if (existing) continue;
    await db.role.create({
      data: {
        companyId,
        name: def.name,
        description: def.description,
        isSystem: false,
        dataScope: def.dataScope,
        permissions: { create: Object.entries(templatePermissions(def.name, def.permissions)).map(([menu, actions]) => ({ menu, actions: actions ?? [] })) },
      },
    });
    created.push(def.name);
  }
  return created;
}

/** A template's permissions plus the menus later phases add to it (E2: etms_passengers; E3: schedules, bookings, dispatch; E4: etms_planning; E5: etms_driver edit). */
export function templatePermissions(name: string, base: PermissionMap): PermissionMap {
  const out: PermissionMap = { ...base };
  for (const extra of [ETMS_E2_TEMPLATE_PERMISSIONS, ETMS_E3_TEMPLATE_PERMISSIONS, ETMS_E4_TEMPLATE_PERMISSIONS, ETMS_E5_TEMPLATE_PERMISSIONS]) {
    for (const [menu, actions] of Object.entries(extra[name] ?? {})) {
      const key = menu as keyof PermissionMap;
      out[key] = [...new Set([...(out[key] ?? []), ...(actions ?? [])])];
    }
  }
  return out;
}
