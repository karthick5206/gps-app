import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, UnauthorizedException } from '@nestjs/common';
import { ApiKey, Prisma } from '@prisma/client';
import {
  API_KEY_DEFAULT_PER_DAY,
  API_KEY_DEFAULT_PER_MINUTE,
  API_KEY_MAX_PER_DAY,
  API_KEY_MAX_PER_MINUTE,
  ApiKeyDto,
  ApiScope,
  CreateApiKeyRequest,
  CreatedApiKey,
} from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { isoOrNull } from '../common/dto';
import { PrismaService } from '../prisma/prisma.service';
import { generateApiKey, hashApiKey, ipAllowed, isWellFormedApiKey, normaliseScopes, parseIpEntry } from './api-key-crypto';

const FLUSH_EVERY_MS = 30_000;
const MAX_KEYS_PER_COMPANY = 50;

type KeyRow = ApiKey & { company: { status: string } };

/** API keys: admin CRUD and request authentication for the public API. */
@Injectable()
export class ApiKeysService implements OnModuleDestroy {
  private readonly logger = new Logger('ApiKeys');
  /** Usage not yet written to the database (lastUsedAt / requestCount are flushed every 30 s, not per request). */
  private readonly usage = new Map<string, { count: number; at: Date; ip: string | null }>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {
    this.timer = setInterval(() => void this.flushUsage(), FLUSH_EVERY_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.flushUsage();
  }

  // ───────────── authentication ─────────────

  /** Resolves a presented key to its row; throws 401 for unknown, revoked or expired keys and 403 for blocked IPs. */
  async verify(secret: string, ip: string | null, now = new Date()): Promise<KeyRow> {
    if (!isWellFormedApiKey(secret)) throw new UnauthorizedException('Invalid API key');
    const key = await this.prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(secret) }, include: { company: { select: { status: true } } } });
    if (!key) throw new UnauthorizedException('Invalid API key');
    if (key.revokedAt) throw new UnauthorizedException('API key revoked');
    if (key.expiresAt && key.expiresAt <= now) throw new UnauthorizedException('API key expired');
    if (key.company.status !== 'ACTIVE') throw new ForbiddenException('Company suspended');
    if (!ipAllowed(key.ipAllowList, ip)) throw new ForbiddenException('Requests from this IP address are not allowed for this API key');
    return key;
  }

  /** The context services see for a key: company-wide data (or one branch), no user permissions. */
  contextFor(key: ApiKey, ip: string | null): AuthContext {
    return {
      userId: key.createdById ?? key.id,
      homeCompanyId: key.companyId,
      companyId: key.companyId,
      isSuperAdmin: false,
      permissions: {},
      dataScope: key.branchId ? 'ASSIGNED' : 'COMPANY',
      branchIds: key.branchId ? [key.branchId] : [],
      objectIds: [],
      ip,
      sessionId: null,
      apiKey: { id: key.id, name: key.name, scopes: normaliseScopes(key.scopes) },
    };
  }

  recordUse(keyId: string, ip: string | null, at = new Date()): void {
    const u = this.usage.get(keyId);
    if (u) {
      u.count++;
      u.at = at;
      u.ip = ip;
    } else this.usage.set(keyId, { count: 1, at, ip });
  }

  async flushUsage(): Promise<void> {
    if (!this.usage.size) return;
    const batch = [...this.usage.entries()];
    this.usage.clear();
    for (const [id, u] of batch) {
      try {
        await this.prisma.apiKey.update({ where: { id }, data: { lastUsedAt: u.at, lastUsedIp: u.ip, requestCount: { increment: u.count } } });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025')) {
          this.logger.warn(`Usage update for key ${id} failed: ${(error as Error).message}`);
        }
      }
    }
  }

  // ───────────── admin ─────────────

  async list(ctx: AuthContext): Promise<ApiKeyDto[]> {
    const rows = await this.prisma.apiKey.findMany({ where: { companyId: ctx.companyId }, orderBy: [{ revokedAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }] });
    return this.toDtos(rows);
  }

  async create(ctx: AuthContext, req: CreateApiKeyRequest): Promise<CreatedApiKey> {
    const scopes = normaliseScopes(req.scopes);
    if (!scopes.length) throw new BadRequestException('Choose at least one scope');
    const ipAllowList: string[] = [];
    for (const raw of req.ipAllowList ?? []) {
      const entry = parseIpEntry(raw);
      if (!entry) throw new BadRequestException(`"${raw}" is not an IP address or CIDR range`);
      if (!ipAllowList.includes(entry)) ipAllowList.push(entry);
    }
    let expiresAt: Date | null = null;
    if (req.expiresAt) {
      expiresAt = new Date(req.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) throw new BadRequestException('expiresAt must be an ISO date-time');
      if (expiresAt.getTime() <= Date.now()) throw new BadRequestException('The expiry must be in the future');
    }
    if (req.branchId) {
      const branch = await this.prisma.branch.count({ where: { id: req.branchId, companyId: ctx.companyId } });
      if (!branch) throw new BadRequestException('Unknown branch');
    }
    const active = await this.prisma.apiKey.count({ where: { companyId: ctx.companyId, revokedAt: null } });
    if (active >= MAX_KEYS_PER_COMPANY) throw new BadRequestException(`A company can have at most ${MAX_KEYS_PER_COMPANY} active API keys`);

    const { secret, hash, prefix } = generateApiKey();
    const row = await this.prisma.apiKey.create({
      data: {
        companyId: ctx.companyId,
        branchId: req.branchId ?? null,
        name: req.name.trim(),
        prefix,
        keyHash: hash,
        scopes,
        ipAllowList,
        ratePerMinute: clamp(req.ratePerMinute ?? API_KEY_DEFAULT_PER_MINUTE, 1, API_KEY_MAX_PER_MINUTE),
        ratePerDay: clamp(req.ratePerDay ?? API_KEY_DEFAULT_PER_DAY, 1, API_KEY_MAX_PER_DAY),
        expiresAt,
        createdById: ctx.apiKey ? null : ctx.userId,
      },
    });
    await this.audit.record(ctx, {
      action: 'CREATE',
      entity: 'ApiKey',
      entityId: row.id,
      after: { name: row.name, prefix: row.prefix, scopes: row.scopes, branchId: row.branchId, ipAllowList: row.ipAllowList, expiresAt: row.expiresAt },
    });
    return { key: (await this.toDtos([row]))[0], secret };
  }

  async revoke(ctx: AuthContext, id: string): Promise<ApiKeyDto> {
    const row = await this.prisma.apiKey.findFirst({ where: { id, companyId: ctx.companyId } });
    if (!row) throw new NotFoundException('API key not found');
    if (row.revokedAt) return (await this.toDtos([row]))[0];
    const updated = await this.prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    await this.audit.record(ctx, { action: 'DELETE', entity: 'ApiKey', entityId: id, details: { name: row.name, prefix: row.prefix, revoked: true } });
    return (await this.toDtos([updated]))[0];
  }

  private async toDtos(rows: ApiKey[]): Promise<ApiKeyDto[]> {
    const userIds = [...new Set(rows.map((r) => r.createdById).filter((v): v is string => !!v))];
    const branchIds = [...new Set(rows.map((r) => r.branchId).filter((v): v is string => !!v))];
    const [users, branches] = await Promise.all([
      userIds.length ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [],
      branchIds.length ? this.prisma.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, name: true } }) : [],
    ]);
    const userName = new Map(users.map((u) => [u.id, u.name]));
    const branchName = new Map(branches.map((b) => [b.id, b.name]));
    return rows.map((r) => {
      const pending = this.usage.get(r.id);
      return {
        id: r.id,
        name: r.name,
        prefix: r.prefix,
        scopes: normaliseScopes(r.scopes) as ApiScope[],
        branchId: r.branchId,
        branchName: r.branchId ? (branchName.get(r.branchId) ?? null) : null,
        ipAllowList: r.ipAllowList,
        ratePerMinute: r.ratePerMinute,
        ratePerDay: r.ratePerDay,
        expiresAt: isoOrNull(r.expiresAt),
        lastUsedAt: isoOrNull(pending?.at ?? r.lastUsedAt),
        lastUsedIp: pending?.ip ?? r.lastUsedIp,
        requestCount: r.requestCount + (pending?.count ?? 0),
        revokedAt: isoOrNull(r.revokedAt),
        createdByName: r.createdById ? (userName.get(r.createdById) ?? null) : null,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(v)));
