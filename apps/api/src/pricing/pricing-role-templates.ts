import { Prisma, PrismaClient } from '@prisma/client';
import { PRICING_ROLE_TEMPLATES } from '@veetracer/shared';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Doc 19 §7.2: create the billing role templates ("Billing admin", "Billing clerk") when a company's `pricing` add-on is
 * switched on. Same rules as the ETMS templates: idempotent, a role with the same name is left untouched, ordinary
 * editable roles (isSystem = false), no change to existing roles. Returns the names created now.
 */
export async function ensurePricingRoleTemplates(db: Db, companyId: string): Promise<string[]> {
  const created: string[] = [];
  for (const def of PRICING_ROLE_TEMPLATES) {
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
