import { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { RedisKeys } from '../redis/keys';

type Db = Pick<PrismaClient, 'webhookEndpoint'>;

/** Keeps `vt:wh:companies` in step with one company's endpoints (called after every endpoint change). */
export async function refreshWebhookCompany(db: Db, redis: Pick<Redis, 'sadd' | 'srem'>, companyId: string): Promise<void> {
  const active = await db.webhookEndpoint.count({ where: { companyId, isActive: true } });
  if (active) await redis.sadd(RedisKeys.webhookCompanies, companyId);
  else await redis.srem(RedisKeys.webhookCompanies, companyId);
}

/** Rebuilds the whole set from the database (worker start-up). */
export async function syncWebhookCompanies(db: Db, redis: Pick<Redis, 'multi'>): Promise<void> {
  const rows = await db.webhookEndpoint.findMany({ where: { isActive: true }, select: { companyId: true }, distinct: ['companyId'] });
  const tx = redis.multi().del(RedisKeys.webhookCompanies);
  if (rows.length) tx.sadd(RedisKeys.webhookCompanies, ...rows.map((r) => r.companyId));
  await tx.exec();
}
