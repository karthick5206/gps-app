import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, WebhookDelivery, WebhookEndpoint } from '@prisma/client';
import { WEBHOOK_EVENTS, WebhookDeliveryDto, WebhookDeliveryStatus, WebhookEndpointDto, WebhookEndpointRequest, WebhookEvent } from '@veetracer/shared';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { isoOrNull } from '../common/dto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { enqueueDelivery } from './events';
import { eventBody } from './fanout';
import { generateWebhookSecret, secretPreview } from './signing';
import { refreshWebhookCompany } from './webhook-companies';
import { checkWebhookUrl, isPrivateAddress, webhookUrlPolicy } from './url-guard';

const MAX_ENDPOINTS = 20;
const LOG_PAGE = 50;

/** Admin side of webhooks (Developer API page): endpoints, secrets, test events, delivery log, redelivery. */
@Injectable()
export class WebhooksAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  async list(ctx: AuthContext): Promise<WebhookEndpointDto[]> {
    const rows = await this.prisma.webhookEndpoint.findMany({ where: { companyId: ctx.companyId }, orderBy: { createdAt: 'asc' } });
    return rows.map(toEndpointDto);
  }

  private async get(ctx: AuthContext, id: string): Promise<WebhookEndpoint> {
    const row = await this.prisma.webhookEndpoint.findFirst({ where: { id, companyId: ctx.companyId } });
    if (!row) throw new NotFoundException('Webhook endpoint not found');
    return row;
  }

  /** URL rules plus, where private targets are refused, a DNS check so mistakes show up when saving. */
  async validateUrl(url: string): Promise<void> {
    const policy = webhookUrlPolicy();
    const problem = checkWebhookUrl(url, policy);
    if (problem) throw new BadRequestException(problem);
    if (policy.allowPrivate) return;
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) return;
    let addresses: { address: string }[];
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      throw new BadRequestException(`Cannot resolve ${host}`);
    }
    if (addresses.some((a) => isPrivateAddress(a.address))) throw new BadRequestException('The URL must point to a public internet address');
  }

  private events(raw: string[]): WebhookEvent[] {
    const events = WEBHOOK_EVENTS.filter((e) => raw.includes(e));
    if (!events.length) throw new BadRequestException('Choose at least one event');
    return events;
  }

  async create(ctx: AuthContext, req: WebhookEndpointRequest): Promise<{ endpoint: WebhookEndpointDto; secret: string }> {
    await this.validateUrl(req.url);
    const count = await this.prisma.webhookEndpoint.count({ where: { companyId: ctx.companyId } });
    if (count >= MAX_ENDPOINTS) throw new BadRequestException(`A company can have at most ${MAX_ENDPOINTS} webhook endpoints`);
    const secret = generateWebhookSecret();
    const row = await this.prisma.webhookEndpoint.create({
      data: { companyId: ctx.companyId, name: req.name.trim(), url: req.url.trim(), events: this.events(req.events), secret, isActive: req.isActive ?? true, createdById: ctx.apiKey ? null : ctx.userId },
    });
    await this.audit.record(ctx, { action: 'CREATE', entity: 'WebhookEndpoint', entityId: row.id, after: { name: row.name, url: row.url, events: row.events, isActive: row.isActive } });
    await refreshWebhookCompany(this.prisma, this.redis.client, ctx.companyId);
    return { endpoint: toEndpointDto(row), secret };
  }

  async update(ctx: AuthContext, id: string, req: Partial<WebhookEndpointRequest>): Promise<WebhookEndpointDto> {
    const before = await this.get(ctx, id);
    if (req.url !== undefined && req.url !== before.url) await this.validateUrl(req.url);
    const data: Prisma.WebhookEndpointUpdateInput = {};
    if (req.name !== undefined) data.name = req.name.trim();
    if (req.url !== undefined) data.url = req.url.trim();
    if (req.events !== undefined) data.events = this.events(req.events);
    if (req.isActive !== undefined) {
      data.isActive = req.isActive;
      // Turning an endpoint back on clears the failure streak and the auto-disable note.
      if (req.isActive) Object.assign(data, { consecutiveFailures: 0, disabledAt: null, disabledReason: null });
    }
    const row = await this.prisma.webhookEndpoint.update({ where: { id }, data });
    await this.audit.record(ctx, {
      action: 'UPDATE',
      entity: 'WebhookEndpoint',
      entityId: id,
      before: { name: before.name, url: before.url, events: before.events, isActive: before.isActive },
      after: { name: row.name, url: row.url, events: row.events, isActive: row.isActive },
    });
    await refreshWebhookCompany(this.prisma, this.redis.client, ctx.companyId);
    return toEndpointDto(row);
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const row = await this.get(ctx, id);
    await this.prisma.webhookEndpoint.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: 'WebhookEndpoint', entityId: id, before: { name: row.name, url: row.url, events: row.events } });
    await refreshWebhookCompany(this.prisma, this.redis.client, ctx.companyId);
  }

  async secret(ctx: AuthContext, id: string): Promise<{ secret: string }> {
    return { secret: (await this.get(ctx, id)).secret };
  }

  async rotateSecret(ctx: AuthContext, id: string): Promise<{ endpoint: WebhookEndpointDto; secret: string }> {
    await this.get(ctx, id);
    const secret = generateWebhookSecret();
    const row = await this.prisma.webhookEndpoint.update({ where: { id }, data: { secret } });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'WebhookEndpoint', entityId: id, details: { secretRotated: true } });
    return { endpoint: toEndpointDto(row), secret };
  }

  /** Queues a signed `test` event to the endpoint (sent within seconds by the notifier; one attempt, no retries). */
  async test(ctx: AuthContext, id: string, event?: string): Promise<WebhookDeliveryDto> {
    const ep = await this.get(ctx, id);
    const type = (WEBHOOK_EVENTS as readonly string[]).includes(event ?? '') ? (event as WebhookEvent) : (ep.events[0] as WebhookEvent) ?? 'alert.created';
    const now = new Date().toISOString();
    const eventId = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const payload = eventBody({ id: eventId, type, companyId: ctx.companyId, occurredAt: now, data: sampleData(type, now) }, true);
    const row = await this.prisma.webhookDelivery.create({
      data: { companyId: ctx.companyId, endpointId: ep.id, eventId, event: type, payload, isTest: true, status: 'PENDING' },
    });
    await enqueueDelivery(this.redis.client, row.id);
    return toDeliveryDto(row);
  }

  async deliveries(ctx: AuthContext, id: string, opts: { status?: string; before?: string }): Promise<{ items: WebhookDeliveryDto[]; nextBefore: string | null }> {
    await this.get(ctx, id);
    const before = opts.before ? new Date(opts.before) : null;
    if (before && Number.isNaN(before.getTime())) throw new BadRequestException('before must be an ISO date-time');
    const rows = await this.prisma.webhookDelivery.findMany({
      where: { endpointId: id, ...(opts.status ? { status: opts.status } : {}), ...(before ? { createdAt: { lt: before } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: LOG_PAGE + 1,
    });
    const items = rows.slice(0, LOG_PAGE);
    return { items: items.map(toDeliveryDto), nextBefore: rows.length > LOG_PAGE ? items[items.length - 1].createdAt.toISOString() : null };
  }

  async delivery(ctx: AuthContext, deliveryId: string): Promise<WebhookDelivery> {
    const d = await this.prisma.webhookDelivery.findFirst({ where: { id: deliveryId, companyId: ctx.companyId } });
    if (!d) throw new NotFoundException('Delivery not found');
    return d;
  }

  /** Sends the same event again (same event id and body) as a new delivery with a fresh retry schedule. */
  async redeliver(ctx: AuthContext, deliveryId: string): Promise<WebhookDeliveryDto> {
    const d = await this.delivery(ctx, deliveryId);
    const ep = await this.get(ctx, d.endpointId);
    if (!ep.isActive && !d.isTest) throw new BadRequestException('Turn the endpoint on before redelivering');
    const row = await this.prisma.webhookDelivery.create({
      data: {
        companyId: d.companyId,
        endpointId: d.endpointId,
        eventId: d.eventId,
        event: d.event,
        payload: d.payload as Prisma.InputJsonValue,
        isTest: d.isTest,
        redeliveryOf: d.redeliveryOf ?? d.id,
        status: 'PENDING',
      },
    });
    await enqueueDelivery(this.redis.client, row.id);
    return toDeliveryDto(row);
  }
}

/** Realistic sample payloads for test events. */
function sampleData(type: WebhookEvent, now: string): Record<string, unknown> {
  const vehicle = { vehicleId: '00000000-0000-0000-0000-000000000000', vehicleName: 'Test vehicle', plateNumber: 'TN01AB1234' };
  switch (type) {
    case 'trip.completed':
      return { ...vehicle, startTime: now, endTime: now, start: { lat: 13.0827, lng: 80.2707 }, end: { lat: 13.0674, lng: 80.2376 }, distanceKm: 4.2, durationSec: 900, idleSec: 60, maxSpeedKph: 52, avgSpeedKph: 21 };
    case 'vehicle.status_changed':
      return { ...vehicle, state: 'moving', previousState: 'stopped', status: 'RUNNING', previousStatus: 'OFF', lat: 13.0827, lng: 80.2707, speedKph: 24, ignition: true, fixTime: now };
    default: {
      const alertType = type === 'geofence.enter' ? 'GEOFENCE_ENTER' : type === 'geofence.exit' ? 'GEOFENCE_EXIT' : type === 'fuel.event' ? 'FUEL_REFILL' : 'OVERSPEED';
      return { ...vehicle, alertId: '00000000-0000-0000-0000-000000000000', type: alertType, severity: 'WARNING', message: 'Test event from VeeTrax', occurredAt: now, lat: 13.0827, lng: 80.2707, address: null, geofenceId: null, geofenceName: null, details: {} };
    }
  }
}

export function toEndpointDto(r: WebhookEndpoint): WebhookEndpointDto {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    events: r.events as WebhookEvent[],
    isActive: r.isActive,
    secretPrefix: secretPreview(r.secret),
    consecutiveFailures: r.consecutiveFailures,
    disabledAt: isoOrNull(r.disabledAt),
    disabledReason: r.disabledReason,
    lastDeliveryAt: isoOrNull(r.lastDeliveryAt),
    lastStatusCode: r.lastStatusCode,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toDeliveryDto(d: WebhookDelivery): WebhookDeliveryDto {
  return {
    id: d.id,
    endpointId: d.endpointId,
    eventId: d.eventId,
    event: d.event,
    status: d.status as WebhookDeliveryStatus,
    attempt: d.attempt,
    responseStatus: d.responseStatus,
    durationMs: d.durationMs,
    error: d.error,
    responseBody: d.responseBody,
    nextAttemptAt: isoOrNull(d.nextAttemptAt),
    deliveredAt: isoOrNull(d.deliveredAt),
    isTest: d.isTest,
    isRedelivery: !!d.redeliveryOf,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

