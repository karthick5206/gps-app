import { LiveObject, MovementStatus, WebhookEvent } from '@veetracer/shared';
import type Redis from 'ioredis';
import { RedisKeys } from '../redis/keys';

/** Approximate cap of the `vt:webhooks` stream. */
export const WEBHOOKS_STREAM_MAXLEN = 100_000;
const COMPANIES_TTL_MS = 30_000;

/** Coarse state for `vehicle.status_changed`: overspeed counts as moving; NO_DATA is never reported. */
export type VehicleState = 'moving' | 'idle' | 'stopped' | 'offline';

export function vehicleState(status: MovementStatus | null | undefined): VehicleState | null {
  switch (status) {
    case 'RUNNING':
    case 'OVERSPEED':
      return 'moving';
    case 'IDLE':
      return 'idle';
    case 'OFF':
      return 'stopped';
    case 'OFFLINE':
      return 'offline';
    default:
      return null;
  }
}

/** Webhook events an alert of this type triggers (besides always `alert.created`). */
export function alertEvents(type: string): WebhookEvent[] {
  const events: WebhookEvent[] = ['alert.created'];
  if (type === 'GEOFENCE_ENTER') events.push('geofence.enter');
  else if (type === 'GEOFENCE_EXIT') events.push('geofence.exit');
  else if (type === 'FUEL_DRAIN' || type === 'FUEL_REFILL') events.push('fuel.event');
  return events;
}

export interface WebhookEventMessage {
  /** Stable id: the same event is never queued twice for an endpoint. */
  id: string;
  type: WebhookEvent;
  companyId: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

type Xadder = Pick<Redis, 'xadd'>;

/** `vehicle.status_changed` payload from the new live state and the previous movement status. */
export function statusChangedEvent(live: LiveObject, previousStatus: MovementStatus): WebhookEventMessage {
  const at = live.statusSince ?? live.serverTime ?? new Date().toISOString();
  return {
    id: `status_${live.objectId}_${Date.parse(at)}_${live.status}`,
    type: 'vehicle.status_changed',
    companyId: live.companyId,
    occurredAt: at,
    data: {
      vehicleId: live.objectId,
      vehicleName: live.name,
      plateNumber: live.plateNumber,
      state: vehicleState(live.status),
      previousState: vehicleState(previousStatus),
      status: live.status,
      previousStatus,
      lat: live.lat,
      lng: live.lng,
      speedKph: live.speedKph,
      ignition: live.ignition,
      fixTime: live.fixTime,
    },
  };
}

/**
 * Producer side (processor, summarizer, api offline sweeper): adds events to `vt:webhooks` only for companies that
 * have an active endpoint (set kept by the api, cached here for 30 s), so fleets without webhooks cost nothing.
 */
export class WebhookEventPublisher {
  private companies: Set<string> = new Set();
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(private readonly redis: Pick<Redis, 'smembers' | 'xadd'>) {}

  async enabledFor(companyId: string): Promise<boolean> {
    if (Date.now() - this.loadedAt > COMPANIES_TTL_MS) {
      this.loading ??= this.redis
        .smembers(RedisKeys.webhookCompanies)
        .then((ids) => {
          this.companies = new Set(ids);
          this.loadedAt = Date.now();
        })
        .catch(() => {
          this.loadedAt = Date.now();
        })
        .finally(() => {
          this.loading = null;
        });
      await this.loading;
    }
    return this.companies.has(companyId);
  }

  async publish(events: WebhookEventMessage[], target: Xadder = this.redis): Promise<number> {
    let n = 0;
    for (const e of events) {
      if (!(await this.enabledFor(e.companyId))) continue;
      await target.xadd(RedisKeys.webhooksStream, 'MAXLEN', '~', WEBHOOKS_STREAM_MAXLEN, '*', 'event', JSON.stringify(e));
      n++;
    }
    return n;
  }
}

/** Ask the worker to send one delivery now (tests, redeliveries). */
export async function enqueueDelivery(redis: Xadder, deliveryId: string): Promise<void> {
  await redis.xadd(RedisKeys.webhooksStream, 'MAXLEN', '~', WEBHOOKS_STREAM_MAXLEN, '*', 'deliveryId', deliveryId);
}
