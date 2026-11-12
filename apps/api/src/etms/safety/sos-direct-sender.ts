import { Injectable, Logger } from '@nestjs/common';
import { NotificationLedger } from '../../notifier/notification-ledger';
import { TRANSPORT_PUSH_CHANNEL } from '@veetracer/shared';
import { createPushProvider, pushStyle, transportPushData, type PushProvider } from '../../notifier/push';
import { PrismaService } from '../../prisma/prisma.service';

/** NotificationLog.refType of a dispatcher push that belongs to a TransportIncident (refId = incident id). */
export const TRANSPORT_INCIDENT_REF = 'TRANSPORT_INCIDENT';
/** Security review M2: the quiet (no siren) push of an SOS relayed late and still OPEN ("still open since HH:MM"). */
export const TRANSPORT_INCIDENT_LATE_REF = 'TRANSPORT_INCIDENT_LATE';

/** Push data of a dispatcher SOS push: the ETMS shape { kind, tripId, notificationId = incident id } (D7 / L4). */
export function sosPushData(incident: { id: string; tripId: string | null }, late = false): Record<string, unknown> {
  return { transport: true, sos: !late, kind: 'SOS', tripId: incident.tripId, notificationId: incident.id };
}

/**
 * Direct-send fallback of the SAFETY outbox relay when Valkey is down (doc 10 §6.2): sends the incident's QUEUED PUSH
 * rows itself, with the notifier's lease ledger (a row is never sent twice; a later notifier job finds it final) and
 * the same truthful statuses (SENT = provider accepted, SKIPPED when push is off / no app signed in). The provider is
 * injectable (tests use a fake; no outbound sends from tests).
 */
@Injectable()
export class SosDirectSender {
  private readonly logger = new Logger('EtmsSosDirect');
  private provider: PushProvider = createPushProvider();

  constructor(private readonly prisma: PrismaService) {}

  /** Tests: replace the push provider. */
  useProvider(p: PushProvider): void {
    this.provider = p;
  }

  /** Sends the QUEUED rows; returns how many were accepted by the provider. */
  async sendRows(logIds: string[]): Promise<number> {
    if (!logIds.length) return 0;
    const ledger = new NotificationLedger(this.prisma);
    const rows = await this.prisma.notificationLog.findMany({ where: { id: { in: logIds }, status: 'QUEUED', channel: 'PUSH' } });
    let sent = 0;
    for (const log of rows) {
      const claimed = await ledger.claimQueued(log.id);
      if (claimed === null) continue;
      const userId = log.recipient.startsWith('user:') ? log.recipient.slice(5) : null;
      if (!this.provider.enabled || !userId) {
        await ledger.finish(log.id, claimed, { status: 'SKIPPED', error: this.provider.enabled ? 'Not a user recipient' : 'Push not configured', provider: this.provider.name, sendAttempts: 0 });
        continue;
      }
      const now = new Date();
      const tokens = await this.prisma.pushToken.findMany({ where: { userId, OR: [{ sessionId: null }, { session: { revokedAt: null, expiresAt: { gt: now } } }] }, select: { token: true } });
      if (!tokens.length) {
        await ledger.finish(log.id, claimed, { status: 'SKIPPED', error: 'Mobile app not signed in', provider: this.provider.name, sendAttempts: 0 });
        continue;
      }
      const incident = log.refId ? await this.prisma.transportIncident.findUnique({ where: { id: log.refId }, select: { id: true, tripId: true } }) : null;
      const late = log.refType === TRANSPORT_INCIDENT_LATE_REF;
      try {
        const res = await this.provider.send(
          tokens.map((t) => t.token),
          { title: log.subject ?? 'Transport SOS', body: log.body, data: transportPushData(incident ? sosPushData(incident, late) : {}), ...(late ? { channelId: TRANSPORT_PUSH_CHANNEL, sound: 'default' } : pushStyle('SOS')) },
        );
        if (res.invalidTokens.length) await this.prisma.pushToken.deleteMany({ where: { token: { in: res.invalidTokens } } });
        const ok = res.sent > 0;
        if (ok) sent++;
        await ledger.finish(log.id, claimed, {
          status: ok ? 'SENT' : 'FAILED',
          error: ok ? res.error : (res.error ?? 'No device accepted the push'),
          provider: this.provider.name,
          providerMessageId: res.ticketIds?.length ? res.ticketIds.join(',').slice(0, 1000) : null,
          sendAttempts: 1,
        });
      } catch (error) {
        // Left QUEUED under its lease: the notifier (or the next relay pass) takes it over when the lease expires.
        this.logger.warn(`Direct SOS push failed, left queued: ${(error as Error).message}`);
      }
    }
    return sent;
  }
}
