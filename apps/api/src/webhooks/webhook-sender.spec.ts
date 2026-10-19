import { PrismaClient } from '@prisma/client';
import { verifySignature } from './signing';
import { Poster, WebhookSender } from './webhook-sender';

type Row = Record<string, unknown>;

/** In-memory stand-in for the two tables the sender touches. */
function fakeDb(endpoint: Row, delivery: Row) {
  const endpoints = new Map<string, Row>([[endpoint.id as string, endpoint]]);
  const deliveries = new Map<string, Row>([[delivery.id as string, delivery]]);
  const db = {
    webhookEndpoint: {
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(endpoints.get(where.id)!, data)),
    },
    webhookDelivery: {
      updateMany: jest.fn(async ({ where, data }: { where: Row & { id: unknown }; data: Row }) => {
        let count = 0;
        for (const d of deliveries.values()) {
          if (typeof where.id === 'string' && d.id !== where.id) continue;
          if (where.endpointId && d.endpointId !== where.endpointId) continue;
          if (!['PENDING', 'RETRYING'].includes(d.status as string)) continue;
          const next = d.nextAttemptAt as Date | null;
          if (typeof where.id === 'string' && next && next > new Date()) continue;
          Object.assign(d, data);
          count++;
        }
        return { count };
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const d = deliveries.get(where.id);
        return d ? { ...d, endpoint: endpoints.get(d.endpointId as string) } : null;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(deliveries.get(where.id)!, data)),
    },
  };
  return { db: db as unknown as Pick<PrismaClient, 'webhookDelivery' | 'webhookEndpoint'>, endpoints, deliveries };
}

const endpoint = (over: Row = {}): Row => ({ id: 'ep1', companyId: 'c1', name: 'ERP', url: 'https://erp.example.com/hook', secret: 'whsec_abc', isActive: true, consecutiveFailures: 0, ...over });
const delivery = (over: Row = {}): Row => ({ id: 'd1', endpointId: 'ep1', eventId: 'evt_1', event: 'alert.created', payload: { id: 'evt_1' }, status: 'PENDING', attempt: 0, nextAttemptAt: null, isTest: false, ...over });
const policy = { production: true, allowPrivate: false };

describe('WebhookSender', () => {
  it('signs the request and records a success', async () => {
    const { db, deliveries, endpoints } = fakeDb(endpoint({ consecutiveFailures: 7 }), delivery());
    let seen: { body: string; headers: Record<string, string> } | null = null;
    const post: Poster = async (_url, body, headers) => {
      seen = { body, headers };
      return { status: 204, body: '', durationMs: 12 };
    };
    await new WebhookSender(db, {}, { policy, post }).attempt('d1');
    expect(deliveries.get('d1')).toMatchObject({ status: 'SUCCEEDED', attempt: 1, responseStatus: 204, durationMs: 12, nextAttemptAt: null });
    expect(endpoints.get('ep1')).toMatchObject({ consecutiveFailures: 0, lastStatusCode: 204 });
    expect(seen!.headers['X-VeeTrax-Event']).toBe('alert.created');
    expect(verifySignature('whsec_abc', seen!.headers['X-VeeTrax-Signature'], seen!.body)).toBe(true);
  });

  it('schedules a retry after a failure and does not send again before it is due', async () => {
    const { db, deliveries } = fakeDb(endpoint(), delivery());
    const post = jest.fn<ReturnType<Poster>, Parameters<Poster>>(async () => ({ status: 500, body: 'oops', durationMs: 5 }));
    const sender = new WebhookSender(db, {}, { policy, post });
    await sender.attempt('d1');
    const d = deliveries.get('d1')!;
    expect(d).toMatchObject({ status: 'RETRYING', attempt: 1, error: 'HTTP 500', responseBody: 'oops' });
    expect((d.nextAttemptAt as Date).getTime() - Date.now()).toBeGreaterThan(55_000);
    expect(await sender.attempt('d1')).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('marks the delivery failed after the last attempt', async () => {
    const { db, deliveries } = fakeDb(endpoint(), delivery({ attempt: 5, status: 'RETRYING' }));
    await new WebhookSender(db, {}, { policy, post: async () => Promise.reject(new Error('ECONNREFUSED')) }).attempt('d1');
    expect(deliveries.get('d1')).toMatchObject({ status: 'FAILED', attempt: 6, error: 'ECONNREFUSED', nextAttemptAt: null });
  });

  it('switches the endpoint off at 50 failures in a row and notifies', async () => {
    const { db, endpoints, deliveries } = fakeDb(endpoint({ consecutiveFailures: 49 }), delivery());
    deliveries.set('d2', delivery({ id: 'd2', eventId: 'evt_2', status: 'RETRYING', nextAttemptAt: new Date(Date.now() + 60_000) }));
    const onEndpointDisabled = jest.fn(async () => undefined);
    await new WebhookSender(db, { onEndpointDisabled }, { policy, post: async () => ({ status: 503, body: '', durationMs: 1 }) }).attempt('d1');
    expect(endpoints.get('ep1')).toMatchObject({ isActive: false, consecutiveFailures: 50 });
    expect(endpoints.get('ep1')!.disabledReason).toMatch(/50 failed/);
    expect(deliveries.get('d1')!.status).toBe('FAILED');
    expect(deliveries.get('d2')).toMatchObject({ status: 'FAILED', error: 'Endpoint was disabled' });
    expect(onEndpointDisabled).toHaveBeenCalledTimes(1);
  });

  it('refuses private URLs without sending (SSRF)', async () => {
    const { db, deliveries } = fakeDb(endpoint({ url: 'https://169.254.169.254/latest' }), delivery());
    const post = jest.fn();
    await new WebhookSender(db, {}, { policy, post }).attempt('d1');
    expect(post).not.toHaveBeenCalled();
    expect(deliveries.get('d1')!.error).toMatch(/public/);
  });

  it('test deliveries get one attempt and leave the failure streak alone', async () => {
    const { db, deliveries, endpoints } = fakeDb(endpoint({ consecutiveFailures: 3 }), delivery({ isTest: true }));
    await new WebhookSender(db, {}, { policy, post: async () => ({ status: 400, body: '', durationMs: 1 }) }).attempt('d1');
    expect(deliveries.get('d1')!.status).toBe('FAILED');
    expect(endpoints.get('ep1')!.consecutiveFailures).toBe(3);
  });
});
