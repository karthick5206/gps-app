import { Prisma, PrismaClient } from '@prisma/client';
import { ETMS_ROLE_TEMPLATES } from '@veetracer/shared';

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
        permissions: { create: Object.entries(def.permissions).map(([menu, actions]) => ({ menu, actions: actions ?? [] })) },
      },
    });
    created.push(def.name);
  }
  return created;
}
