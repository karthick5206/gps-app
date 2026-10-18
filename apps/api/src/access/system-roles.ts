import { Prisma, PrismaClient } from '@prisma/client';
import { SYSTEM_ROLES } from '@veetracer/shared';

type Db = PrismaClient | Prisma.TransactionClient;

/** Create (or refresh the description of) the built-in roles of a company. Idempotent. */
export async function ensureSystemRoles(db: Db, companyId: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const def of SYSTEM_ROLES) {
    const existing = await db.role.findUnique({ where: { companyId_name: { companyId, name: def.name } } });
    const role =
      existing ??
      (await db.role.create({
        data: {
          companyId,
          name: def.name,
          description: def.description,
          isSystem: true,
          dataScope: def.dataScope,
          permissions: {
            create: Object.entries(def.permissions).map(([menu, actions]) => ({ menu, actions: actions ?? [] })),
          },
        },
      }));
    ids.set(def.name, role.id);
  }
  return ids;
}
