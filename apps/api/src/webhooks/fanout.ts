import { Prisma, PrismaClient } from '@prisma/client';
import { WebhookEventMessage } from './events';

type Db = Pick<PrismaClient, 'webhookEndpoint' | 'webhookDelivery'>;

/** Body sent to the endpoint for an event. */
export function eventBody(e: WebhookEventMessage, test = false): Prisma.InputJsonObject {
  return {
    id: e.id,
    type: e.type,
    createdAt: e.occurredAt,
    companyId: e.companyId,
    ...(test ? { test: true } : {}),
    data: e.data as Prisma.InputJsonObject,
  };
}

/**
 * Creates one PENDING delivery per active endpoint of the company subscribed to the event type. An event already
 * queued for an endpoint (same id) is skipped. Returns the new delivery ids.
 */
export async function queueEvent(db: Db, e: WebhookEventMessage): Promise<string[]> {
  const endpoints = await db.webhookEndpoint.findMany({
    where: { companyId: e.companyId, isActive: true, events: { has: e.type } },
    select: { id: true },
  });
  if (!endpoints.length) return [];
  const keys = endpoints.map((ep) => `${ep.id}:${e.id}`);
  const payload = eventBody(e);
  await db.webhookDelivery.createMany({
    data: endpoints.map((ep, i) => ({
      companyId: e.companyId,
      endpointId: ep.id,
      eventId: e.id,
      event: e.type,
      payload,
      dedupeKey: keys[i],
      status: 'PENDING',
    })),
    skipDuplicates: true,
  });
  const rows = await db.webhookDelivery.findMany({ where: { dedupeKey: { in: keys }, attempt: 0, status: 'PENDING' }, select: { id: true } });
  return rows.map((r) => r.id);
}
