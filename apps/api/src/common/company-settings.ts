import { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Replace ONE top-level key of `Company.settings` atomically (F9). The JSON is changed by PostgreSQL (`jsonb_set`) in a
 * single UPDATE instead of read → change → write the whole object, so two writers of different keys (a company admin
 * saving thresholds while the Super Admin switches the `etms` add-on off) can no longer undo each other. Writers of the
 * same key still follow last-write-wins, which is the expected behaviour of a settings form.
 * A non-object `settings` (never written by the app) is replaced by an object holding only this key.
 */
export async function setCompanySetting(db: Db, companyId: string, key: string, value: unknown): Promise<void> {
  await db.$executeRaw`UPDATE "Company"
    SET "settings" = jsonb_set(CASE WHEN jsonb_typeof("settings") = 'object' THEN "settings" ELSE '{}'::jsonb END, ARRAY[${key}]::text[], ${JSON.stringify(value ?? null)}::jsonb, true),
        "updatedAt" = now()
    WHERE "id" = ${companyId}::uuid`;
}
