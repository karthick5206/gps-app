import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient, WebhookDelivery, WebhookEndpoint } from '@prisma/client';
import { WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMEOUT_MS } from '@veetracer/shared';
import { postJson, PostResult } from './http-post';
import { afterAttempt, isSuccessStatus } from './retry';
import { signatureHeader } from './signing';
import { checkWebhookUrl, UrlPolicy, webhookUrlPolicy } from './url-guard';

/** A claimed delivery is not picked up again by another worker for this long. */
const LEASE_MS = 2 * 60_000;
const ERROR_MAX = 500;

export type Poster = (url: string, body: string, headers: Record<string, string>) => Promise<PostResult>;

export interface SenderHooks {
  /** Called once when an endpoint is switched off after too many failures. */
  onEndpointDisabled?: (endpoint: WebhookEndpoint, reason: string) => Promise<void>;
}

type Db = Pick<PrismaClient, 'webhookDelivery' | 'webhookEndpoint'>;

/** Sends one delivery attempt and records the result (retry schedule, failure streak, auto-disable). */
export class WebhookSender {
  private readonly logger = new Logger('Webhooks');
  private readonly policy: UrlPolicy;
  private readonly post: Poster;

  constructor(
    private readonly db: Db,
    private readonly hooks: SenderHooks = {},
    opts: { policy?: UrlPolicy; post?: Poster } = {},
  ) {
    this.policy = opts.policy ?? webhookUrlPolicy();
    this.post = opts.post ?? ((url, body, headers) => postJson(url, body, headers, { timeoutMs: WEBHOOK_TIMEOUT_MS, allowPrivate: this.policy.allowPrivate }));
  }

  /** Atomically takes a due delivery (PENDING / RETRYING with nextAttemptAt ≤ now). False when someone else has it. */
  async claim(id: string, now = new Date()): Promise<boolean> {
    const r = await this.db.webhookDelivery.updateMany({
      where: { id, status: { in: ['PENDING', 'RETRYING'] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      data: { nextAttemptAt: new Date(now.getTime() + LEASE_MS) },
    });
    return r.count === 1;
  }

  /** Claim + send. Returns the updated delivery, or null when it was not due / already taken. */
  async attempt(id: string, now = new Date()): Promise<WebhookDelivery | null> {
    if (!(await this.claim(id, now))) return null;
    const delivery = await this.db.webhookDelivery.findUnique({ where: { id }, include: { endpoint: true } });
    if (!delivery) return null;
    const endpoint = delivery.endpoint;
    const attempt = delivery.attempt + 1;

    // Disabled endpoints: real events wait as failed; tests are still sent so the admin can check a fix.
    if (!endpoint.isActive && !delivery.isTest) {
      return this.db.webhookDelivery.update({
        where: { id },
        data: { status: 'FAILED', nextAttemptAt: null, error: 'Endpoint is disabled' },
      });
    }

    const body = JSON.stringify(delivery.payload);
    const ts = Math.floor(now.getTime() / 1000);
    const headers: Record<string, string> = {
      'User-Agent': 'VeeTrax-Webhooks/1.0',
      'X-VeeTrax-Event': delivery.event,
      'X-VeeTrax-Event-Id': delivery.eventId,
      'X-VeeTrax-Delivery': delivery.id,
      'X-VeeTrax-Attempt': String(attempt),
      [WEBHOOK_SIGNATURE_HEADER]: signatureHeader(endpoint.secret, ts, body),
    };

    let result: PostResult | null = null;
    let error: string | null = checkWebhookUrl(endpoint.url, this.policy);
    if (!error) {
      try {
        result = await this.post(endpoint.url, body, headers);
        if (!isSuccessStatus(result.status)) error = `HTTP ${result.status}`;
      } catch (e) {
        error = (e as Error).message || String(e);
      }
    }
    const success = !error;
    const done = new Date();
    // Test sends never touch the endpoint's failure streak.
    const outcome = afterAttempt(attempt, success, delivery.isTest ? 0 : endpoint.consecutiveFailures, done);
    const final = delivery.isTest && !success ? { ...outcome, status: 'FAILED' as const, nextAttemptAt: null, disableEndpoint: false } : outcome;

    const updated = await this.db.webhookDelivery.update({
      where: { id },
      data: {
        status: final.status,
        attempt,
        nextAttemptAt: final.nextAttemptAt,
        responseStatus: result?.status ?? null,
        durationMs: result?.durationMs ?? null,
        responseBody: result?.body ?? null,
        error: error ? error.slice(0, ERROR_MAX) : null,
        deliveredAt: success ? done : null,
      },
    });

    if (!delivery.isTest) {
      const data: Prisma.WebhookEndpointUpdateInput = {
        consecutiveFailures: final.consecutiveFailures,
        lastDeliveryAt: done,
        lastStatusCode: result?.status ?? null,
      };
      const reason = `Switched off after ${final.consecutiveFailures} failed deliveries in a row (last error: ${(error ?? '').slice(0, 200)})`;
      if (final.disableEndpoint) Object.assign(data, { isActive: false, disabledAt: done, disabledReason: reason });
      await this.db.webhookEndpoint.update({ where: { id: endpoint.id }, data });
      if (final.disableEndpoint) {
        this.logger.warn(`Endpoint ${endpoint.id} (${endpoint.url}) disabled: ${reason}`);
        // Pending retries of this endpoint will not be sent any more.
        await this.db.webhookDelivery.updateMany({
          where: { endpointId: endpoint.id, status: { in: ['PENDING', 'RETRYING'] }, id: { not: id } },
          data: { status: 'FAILED', nextAttemptAt: null, error: 'Endpoint was disabled' },
        });
        await this.hooks.onEndpointDisabled?.(endpoint, reason).catch((e: Error) => this.logger.error(`Disable notice failed: ${e.message}`));
      }
    }
    return updated;
  }
}
