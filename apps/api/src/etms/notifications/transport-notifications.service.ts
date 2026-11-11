import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DRIVER_LIMITS,
  TRANSPORT_NOTIFICATION_KINDS,
  passengerPushAllowed,
  transportNotificationText,
  type TransportNotificationAudience,
  type TransportNotificationDto,
  type TransportNotificationKind,
  type TransportNotificationPreferences,
} from '@veetracer/shared';
import { randomUUID } from 'crypto';
import { NOTIFY_STREAM_MAXLEN } from '../../alerts/alert-dto';
import { AuthContext } from '../../access/auth-context';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisKeys } from '../../redis/keys';
import { RedisService } from '../../redis/redis.service';
import { NotificationListDto, NotificationPreferencesDto, NotificationReadDto } from '../driver/driver.dto';

/** NotificationLog.refType of a push that belongs to a TransportNotification (the notifier rebuilds the push data from it). */
export const TRANSPORT_NOTIFICATION_REF = 'TRANSPORT_NOTIFICATION';

export interface NotifyItem {
  companyId: string;
  userId: string;
  audience: TransportNotificationAudience;
  kind: TransportNotificationKind;
  tripId: string | null;
  /** Unique per recipient and fact: the relay / scheduler may run again without duplicating. */
  dedupeKey: string;
  /** Push allowed by the recipient's preferences (passengers) — the in-app record is always written. */
  push: boolean;
}

type Db = Pick<PrismaService, 'transportNotification' | 'notificationLog' | 'pushToken'>;

/**
 * Transport notifications (doc 05 §5.4–5.6, 02 §8.3; D7 / L4): one in-app TransportNotification per recipient and fact
 * (the authoritative history the apps fetch), plus — when the recipient's preferences allow it and an app is signed
 * in — one QUEUED PUSH NotificationLog row on the existing notifier pipeline with G2 durable delivery: the row is in
 * PostgreSQL before the `vt:notify` job is added, so a lost job is re-queued by the notifier's sweeper, the notifier
 * leases / retries / dead-letters it, and its status stays truthful (SENT = accepted by Expo). The push carries only
 * the generic text and `{ kind, tripId, notificationId }`; no names, phones, addresses, plates or coordinates.
 */
@Injectable()
export class TransportNotificationsService {
  private readonly logger = new Logger('EtmsNotifications');

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Write the notifications that do not exist yet (dedupeKey) and their PUSH log rows, then hand the log ids to the
   * notifier. Idempotent and safe to run concurrently (skipDuplicates on both unique keys). Returns the new
   * notification ids.
   */
  async notify(items: NotifyItem[]): Promise<string[]> {
    const uniq = [...new Map(items.map((i) => [i.dedupeKey, i])).values()];
    if (!uniq.length) return [];
    const existing = new Set((await this.prisma.transportNotification.findMany({ where: { dedupeKey: { in: uniq.map((i) => i.dedupeKey) } }, select: { dedupeKey: true } })).map((r) => r.dedupeKey));
    const fresh = uniq.filter((i) => !existing.has(i.dedupeKey)).map((i) => ({ ...i, id: randomUUID() }));
    if (!fresh.length) return [];
    // QA B7: title / body in the recipient's language (profile preference; English otherwise).
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(fresh.map((i) => i.userId))] } }, select: { id: true, preferences: true } });
    const language = new Map(users.map((u) => [u.id, (u.preferences as { language?: unknown } | null)?.language]));
    const text = (i: NotifyItem) => transportNotificationText(i.kind, typeof language.get(i.userId) === 'string' ? (language.get(i.userId) as string) : null);
    const now = new Date();
    // QA B6: the inbox rows, their PUSH log rows and pushQueued in ONE transaction: a crash can no longer leave an inbox
    // row whose push was never logged (a re-run skips the existing dedupeKey). The job is added after the commit; a
    // lost job is re-queued by the notifier's sweeper from the QUEUED row.
    const { mine, push } = await this.prisma.$transaction(async (tx) => {
      const db: Db = tx as unknown as Db;
      await db.transportNotification.createMany({
        data: fresh.map((i) => ({ id: i.id, companyId: i.companyId, userId: i.userId, audience: i.audience, kind: i.kind, tripId: i.tripId, title: text(i).title, body: text(i).body, dedupeKey: i.dedupeKey })),
        skipDuplicates: true,
      });
      // Only the rows this call inserted (a concurrent run may have won a dedupeKey).
      const inserted = new Set((await db.transportNotification.findMany({ where: { id: { in: fresh.map((i) => i.id) } }, select: { id: true } })).map((r) => r.id));
      const mine = fresh.filter((i) => inserted.has(i.id));
      const wantPush = mine.filter((i) => i.push);
      if (!wantPush.length) return { mine, push: [] };
      const tokens = await db.pushToken.findMany({ where: { userId: { in: [...new Set(wantPush.map((i) => i.userId))] }, OR: [{ sessionId: null }, { session: { revokedAt: null, expiresAt: { gt: now } } }] }, select: { userId: true } });
      const signedIn = new Set(tokens.map((t) => t.userId));
      const push = wantPush.filter((i) => signedIn.has(i.userId)).map((i) => ({ ...i, logId: randomUUID() }));
      if (push.length) {
        await db.notificationLog.createMany({
          data: push.map((i) => ({
            id: i.logId,
            companyId: i.companyId,
            channel: 'PUSH' as const,
            recipient: `user:${i.userId}`,
            subject: text(i).title,
            body: text(i).body,
            status: 'QUEUED' as const,
            refType: TRANSPORT_NOTIFICATION_REF,
            refId: i.id,
            dedupeKey: `etms:${i.id}:PUSH`,
          })),
          skipDuplicates: true,
        });
        await db.transportNotification.updateMany({ where: { id: { in: push.map((i) => i.id) } }, data: { pushQueued: true } });
      }
      return { mine, push };
    });
    if (push.length) await this.enqueue(push.map((i) => ({ companyId: i.companyId, logId: i.logId })));
    return mine.map((i) => i.id);
  }

  /** XADD per company (the notifier job shape `{ logIds }`). A failure is only logged: the sweeper re-queues QUEUED rows. */
  private async enqueue(rows: { companyId: string; logId: string }[]): Promise<void> {
    const byCompany = new Map<string, string[]>();
    for (const r of rows) (byCompany.get(r.companyId) ?? byCompany.set(r.companyId, []).get(r.companyId)!).push(r.logId);
    for (const [companyId, ids] of byCompany) {
      try {
        await this.redis.client.xadd(RedisKeys.notifyStream, 'MAXLEN', '~', NOTIFY_STREAM_MAXLEN, '*', 'logIds', JSON.stringify(ids), 'companyId', companyId);
      } catch (error) {
        this.logger.warn(`Push job not queued (the notifier sweeper will retry): ${(error as Error).message}`);
      }
    }
  }

  // ───────────────────────────── Inbox (the signed-in user's own rows only) ─────────────────────────────

  async list(ctx: Pick<AuthContext, 'userId' | 'companyId'>, audience: TransportNotificationAudience, q: NotificationListDto): Promise<TransportNotificationDto[]> {
    const where: Prisma.TransportNotificationWhereInput = { userId: ctx.userId, companyId: ctx.companyId, audience };
    if (q.unread === 'true') where.readAt = null;
    if (q.before) where.createdAt = { lt: new Date(q.before) };
    const rows = await this.prisma.transportNotification.findMany({ where, orderBy: { createdAt: 'desc' }, take: DRIVER_LIMITS.notificationsPage });
    return rows
      .filter((r) => r.userId === ctx.userId && r.companyId === ctx.companyId && r.audience === audience)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({ id: r.id, kind: r.kind as TransportNotificationKind, title: r.title, body: r.body, tripId: r.tripId, createdAt: r.createdAt.toISOString(), readAt: r.readAt?.toISOString() ?? null, pushQueued: r.pushQueued }));
  }

  unread(ctx: Pick<AuthContext, 'userId' | 'companyId'>, audience: TransportNotificationAudience): Promise<number> {
    return this.prisma.transportNotification.count({ where: { userId: ctx.userId, companyId: ctx.companyId, audience, readAt: null } });
  }

  async markRead(ctx: Pick<AuthContext, 'userId' | 'companyId'>, audience: TransportNotificationAudience, dto: NotificationReadDto): Promise<{ updated: number }> {
    if (!dto.all && !dto.ids?.length) throw new BadRequestException({ message: 'Send ids or all: true', code: 'VALIDATION_FAILED' });
    const where: Prisma.TransportNotificationWhereInput = { userId: ctx.userId, companyId: ctx.companyId, audience, readAt: null };
    if (!dto.all) where.id = { in: dto.ids };
    const r = await this.prisma.transportNotification.updateMany({ where, data: { readAt: new Date() } });
    return { updated: r.count };
  }
}

/** Validated passenger preferences (booleans only, known kinds only). */
export function cleanPreferences(dto: NotificationPreferencesDto): TransportNotificationPreferences {
  const kinds: Partial<Record<TransportNotificationKind, boolean>> = {};
  const raw = dto.kinds ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException({ message: 'kinds must be an object', code: 'VALIDATION_FAILED' });
  for (const [k, v] of Object.entries(raw)) {
    if (!(TRANSPORT_NOTIFICATION_KINDS as readonly string[]).includes(k) || typeof v !== 'boolean') throw new BadRequestException({ message: `Unknown notification setting ${k}`, code: 'VALIDATION_FAILED' });
    kinds[k as TransportNotificationKind] = v;
  }
  return { push: dto.push, kinds };
}

export function preferencesOf(raw: unknown): TransportNotificationPreferences {
  const n = (raw as { notifications?: { push?: unknown; kinds?: Record<string, unknown> } } | null)?.notifications;
  const kinds: Partial<Record<TransportNotificationKind, boolean>> = {};
  for (const k of TRANSPORT_NOTIFICATION_KINDS) if (typeof n?.kinds?.[k] === 'boolean') kinds[k] = n.kinds[k] as boolean;
  return { push: n?.push !== false, kinds };
}

export { passengerPushAllowed };
