import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { AuditLogDto } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { PrismaService } from '../prisma/prisma.service';

/** Fields never written to the audit trail. */
const SECRET_FIELDS = new Set(['passwordHash', 'ingestToken', 'refreshTokenHash', 'tokenHash', 'codeHash']);
const IGNORED_FIELDS = new Set(['createdAt', 'updatedAt']);

type Snapshot = Record<string, unknown>;

function normalise(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalise);
  return value;
}

/** Field-level `{ field: { from, to } }` diff of two plain snapshots (null = record absent). */
export function diffSnapshots(before: Snapshot | null, after: Snapshot | null): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) {
    if (IGNORED_FIELDS.has(key) || key.startsWith('_')) continue;
    const from = normalise(before?.[key] ?? null);
    const to = normalise(after?.[key] ?? null);
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    changes[key] = SECRET_FIELDS.has(key) ? { from: from === null ? null : '***', to: to === null ? null : '***' } : { from, to };
  }
  return changes;
}

export interface AuditEntry {
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  before?: Snapshot | null;
  after?: Snapshot | null;
  /** Extra details recorded verbatim (used instead of a diff for non-CRUD events). */
  details?: Prisma.InputJsonValue;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Record a change made by an authenticated caller inside their effective company. */
  async record(ctx: AuthContext, entry: AuditEntry, db: Prisma.TransactionClient = this.prisma): Promise<void> {
    await this.write({ companyId: ctx.companyId, userId: ctx.userId, ip: ctx.ip }, entry, db);
  }

  /** Record an event outside an authenticated request (login attempts, password resets). */
  async recordSystem(
    actor: { companyId: string | null; userId: string | null; ip: string | null },
    entry: AuditEntry,
  ): Promise<void> {
    await this.write(actor, entry, this.prisma);
  }

  private async write(
    actor: { companyId: string | null; userId: string | null; ip: string | null },
    entry: AuditEntry,
    db: Prisma.TransactionClient,
  ): Promise<void> {
    const hasDiff = entry.before !== undefined || entry.after !== undefined;
    const changes = hasDiff ? diffSnapshots(entry.before ?? null, entry.after ?? null) : entry.details;
    if (entry.action === 'UPDATE' && hasDiff && changes && Object.keys(changes).length === 0) return;
    await db.auditLog.create({
      data: {
        companyId: actor.companyId,
        userId: actor.userId,
        ip: actor.ip,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        changes: (changes as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
      },
    });
  }

  async history(ctx: AuthContext, entity: string, entityId: string): Promise<AuditLogDto[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { companyId: ctx.companyId, entity, entityId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return this.toDtos(rows);
  }

  /** History of a platform-level record (device models, inventory, companies) across all companies. */
  async platformHistory(entity: string, entityId: string): Promise<AuditLogDto[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { entity, entityId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return this.toDtos(rows);
  }

  async toDtos(rows: Prisma.AuditLogGetPayload<object>[]): Promise<AuditLogDto[]> {
    const userIds = [...new Set(rows.map((r) => r.userId).filter((id): id is string => id !== null))];
    const users = userIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
      : [];
    const names = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      userName: r.userId ? (names.get(r.userId) ?? null) : null,
      action: r.action,
      entity: r.entity,
      entityId: r.entityId,
      changes: r.changes,
      ip: r.ip,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
