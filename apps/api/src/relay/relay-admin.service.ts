import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval, Timeout } from '@nestjs/schedule';
import { Prisma, RelayTarget } from '@prisma/client';
import {
  ProcessHeartbeat,
  RELAY_MAX_SCOPE_DEVICES,
  RELAY_PROTOCOLS,
  RelayAuthType,
  RelayRuleSet,
  RelayRuleSpec,
  RelayTargetDto,
  RelayTargetInput,
  RelayTargetStats,
  RelayTestResult,
} from '@veetracer/shared';
import { lookup } from 'node:dns/promises';
import { isIP, Socket } from 'node:net';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { APP_ENV } from '../config/config.module';
import { AppEnv } from '../config/env';
import { iso } from '../common/dto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { postJson } from '../webhooks/http-post';
import { generateWebhookSecret, secretPreview } from '../webhooks/signing';
import { isPrivateAddress } from '../webhooks/url-guard';
import { checkHttpTarget, checkTcpTarget, RELAY_LIMITS, RelayPolicy, relayPolicy } from './guard';
import { authorizationHeader, batchHeaders, RelayBatchBody } from './http-forwarder';
import { parseRuleSet } from './rules';
import { relayStatsFromHeartbeats } from './stats';

const REPUBLISH_EVERY_MS = 5 * 60_000;
const TEST_TIMEOUT_MS = 8000;

/** Audit snapshot without secrets. */
const auditView = (t: RelayTarget) => ({
  name: t.name,
  type: t.type,
  enabled: t.enabled,
  host: t.host,
  port: t.port,
  passDownstream: t.passDownstream,
  url: t.url,
  authType: t.authType,
  hasAuth: !!t.authValue,
  includeAlerts: t.includeAlerts,
  scope: t.scope,
  companyId: t.companyId,
  deviceIds: t.deviceIds,
  protocol: t.protocol,
  liveOnly: t.liveOnly,
  validOnly: t.validOnly,
});

/**
 * Data forwarding admin (Super Admin): targets CRUD, connection tests, status from heartbeats, and the resolved rule
 * set published to Valkey for the gateways (RAW_TCP) and notifiers (HTTP_JSON), which never query the database.
 */
@Injectable()
export class RelayAdminService {
  private readonly logger = new Logger('Relay');
  readonly policy: RelayPolicy;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    @Inject(APP_ENV) env: AppEnv,
  ) {
    this.policy = relayPolicy(env);
  }

  // ── list ─────────────────────────────────────────────────────────────────

  async list(): Promise<RelayTargetDto[]> {
    const [rows, stats] = await Promise.all([
      this.prisma.relayTarget.findMany({ orderBy: { createdAt: 'asc' } }),
      this.liveStats().catch(() => new Map<string, RelayTargetStats>()),
    ]);
    const companyIds = [...new Set(rows.map((r) => r.companyId).filter((id): id is string => !!id))];
    const companies = companyIds.length ? await this.prisma.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true } }) : [];
    const names = new Map(companies.map((c) => [c.id, c.name]));
    return rows.map((r) => this.toDto(r, stats.get(r.id) ?? null, r.companyId ? (names.get(r.companyId) ?? null) : null));
  }

  async liveStats(): Promise<Map<string, RelayTargetStats>> {
    const client = this.redis.client;
    const keys = await client.zrange(RedisKeys.healthProcessIndex, 0, -1);
    const relevant = keys.filter((k) => k.includes(':gateway:') || k.includes(':notifier:'));
    if (!relevant.length) return new Map();
    const values = await client.mget(relevant);
    const heartbeats: ProcessHeartbeat[] = [];
    for (const v of values) {
      if (!v) continue;
      try {
        heartbeats.push(JSON.parse(v) as ProcessHeartbeat);
      } catch {
        // ignore
      }
    }
    return relayStatsFromHeartbeats(heartbeats);
  }

  toDto(r: RelayTarget, stats: RelayTargetStats | null, companyName: string | null): RelayTargetDto {
    const status: RelayTargetDto['status'] = !r.enabled ? 'DISABLED' : stats?.failingSince ? 'FAILING' : stats?.lastSuccessAt ? 'OK' : 'IDLE';
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      enabled: r.enabled,
      host: r.host,
      port: r.port,
      passDownstream: r.passDownstream,
      url: r.url,
      authType: r.authType as RelayAuthType,
      hasAuth: !!r.authValue,
      secretPreview: secretPreview(r.secret),
      includeAlerts: r.includeAlerts,
      scope: r.scope,
      companyId: r.companyId,
      companyName,
      deviceIds: r.deviceIds,
      protocol: r.protocol,
      liveOnly: r.liveOnly,
      validOnly: r.validOnly,
      createdAt: iso(r.createdAt),
      updatedAt: iso(r.updatedAt),
      stats: r.enabled ? stats : null,
      status,
    };
  }

  private async get(id: string): Promise<RelayTarget> {
    const row = await this.prisma.relayTarget.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Forwarding target not found');
    return row;
  }

  async secret(id: string): Promise<{ secret: string }> {
    return { secret: (await this.get(id)).secret };
  }

  // ── create / update / delete ───────────────────────────────────────────────

  /** Normalises and checks one target (merged with the stored row on update). */
  private async validate(input: RelayTargetInput, existing: RelayTarget | null): Promise<Prisma.RelayTargetUncheckedCreateInput> {
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('Enter a name');
    const authType = input.authType ?? (existing?.authType as RelayAuthType | undefined) ?? 'NONE';
    const authValue = input.authValue === undefined ? (existing?.authValue ?? null) : input.authValue?.trim() || null;
    const data: Prisma.RelayTargetUncheckedCreateInput = {
      name: name.slice(0, 80),
      type: input.type,
      enabled: input.enabled,
      host: null,
      port: null,
      passDownstream: false,
      url: null,
      authType: 'NONE',
      authValue: null,
      includeAlerts: false,
      scope: input.scope,
      companyId: null,
      deviceIds: [],
      protocol: null,
      liveOnly: !!input.liveOnly,
      validOnly: !!input.validOnly,
      secret: existing?.secret ?? generateWebhookSecret(),
    };
    if (input.type === 'RAW_TCP') {
      const host = input.host?.trim() ?? '';
      const port = Number(input.port);
      const problem = await checkTcpTarget(host, port, this.policy);
      if (problem) throw new BadRequestException(problem);
      data.host = host;
      data.port = port;
      data.passDownstream = !!input.passDownstream;
      // Raw bytes are copied as they are: per-position filters do not apply.
      data.liveOnly = false;
      data.validOnly = false;
    } else {
      const url = input.url?.trim() ?? '';
      const problem = checkHttpTarget(url, this.policy) ?? (await this.resolvesPublic(url));
      if (problem) throw new BadRequestException(problem);
      data.url = url;
      data.includeAlerts = !!input.includeAlerts;
      if (authType !== 'NONE') {
        if (!authValue) throw new BadRequestException(authType === 'BASIC' ? 'Enter user:password for Basic authentication' : 'Enter the bearer token');
        if (authType === 'BASIC' && !authValue.includes(':')) throw new BadRequestException('Basic authentication needs user:password');
        data.authType = authType;
        data.authValue = authValue.slice(0, 2000);
      }
    }
    if (input.scope === 'COMPANY') {
      if (!input.companyId) throw new BadRequestException('Choose the company');
      const company = await this.prisma.company.findUnique({ where: { id: input.companyId }, select: { id: true } });
      if (!company) throw new BadRequestException('Company not found');
      data.companyId = company.id;
    } else if (input.scope === 'DEVICES') {
      const ids = [...new Set(input.deviceIds ?? [])];
      if (!ids.length) throw new BadRequestException('Choose at least one device');
      if (ids.length > RELAY_MAX_SCOPE_DEVICES) throw new BadRequestException(`At most ${RELAY_MAX_SCOPE_DEVICES} devices per target`);
      const found = await this.prisma.device.count({ where: { id: { in: ids } } });
      if (found !== ids.length) throw new BadRequestException('Some devices were not found');
      data.deviceIds = ids;
    } else if (input.scope === 'PROTOCOL') {
      if (!input.protocol || !(RELAY_PROTOCOLS as readonly string[]).includes(input.protocol)) throw new BadRequestException('Choose the protocol');
      data.protocol = input.protocol;
    }
    if (data.passDownstream && data.scope === 'PROTOCOL' && data.protocol !== 'ais140') {
      throw new BadRequestException('Passing replies to the device is only possible for AIS-140');
    }
    return data;
  }

  /** In production a host name must not resolve to a private address (checked again at connect time). */
  private async resolvesPublic(url: string): Promise<string | null> {
    if (this.policy.allowPrivate) return null;
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) return null;
    try {
      const addresses = await lookup(host, { all: true });
      return addresses.some((a) => isPrivateAddress(a.address)) ? 'The URL must point to a public internet address' : null;
    } catch {
      return `Cannot resolve ${host}`;
    }
  }

  async create(ctx: AuthContext, input: RelayTargetInput): Promise<RelayTargetDto> {
    const count = await this.prisma.relayTarget.count();
    const max = RELAY_LIMITS.maxTargets();
    if (count >= max) throw new BadRequestException(`At most ${max} forwarding targets`);
    const data = await this.validate(input, null);
    const row = await this.prisma.relayTarget.create({ data: { ...data, createdById: ctx.userId } });
    await this.audit.record(ctx, { action: 'CREATE', entity: 'RelayTarget', entityId: row.id, after: auditView(row) });
    await this.publishSafe();
    return this.toDto(row, null, null);
  }

  async update(ctx: AuthContext, id: string, input: Partial<RelayTargetInput>): Promise<RelayTargetDto> {
    const before = await this.get(id);
    const merged: RelayTargetInput = {
      name: input.name ?? before.name,
      type: input.type ?? before.type,
      enabled: input.enabled ?? before.enabled,
      host: input.host !== undefined ? input.host : before.host,
      port: input.port !== undefined ? input.port : before.port,
      passDownstream: input.passDownstream ?? before.passDownstream,
      url: input.url !== undefined ? input.url : before.url,
      authType: input.authType ?? (before.authType as RelayAuthType),
      authValue: input.authValue,
      includeAlerts: input.includeAlerts ?? before.includeAlerts,
      scope: input.scope ?? before.scope,
      companyId: input.companyId !== undefined ? input.companyId : before.companyId,
      deviceIds: input.deviceIds ?? before.deviceIds,
      protocol: input.protocol !== undefined ? input.protocol : before.protocol,
      liveOnly: input.liveOnly ?? before.liveOnly,
      validOnly: input.validOnly ?? before.validOnly,
    };
    // Only switching on/off: skip the (DNS) checks so a target can be disabled while its host is unreachable.
    const toggleOnly = Object.keys(input).every((k) => k === 'enabled');
    const data = toggleOnly ? { enabled: merged.enabled } : await this.validate(merged, before);
    const row = await this.prisma.relayTarget.update({ where: { id }, data });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'RelayTarget', entityId: id, before: auditView(before), after: auditView(row) });
    await this.publishSafe();
    return this.toDto(row, null, null);
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const before = await this.get(id);
    await this.prisma.relayTarget.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: 'RelayTarget', entityId: id, before: auditView(before) });
    await this.publishSafe();
  }

  async rotateSecret(ctx: AuthContext, id: string): Promise<{ secret: string }> {
    await this.get(id);
    const secret = generateWebhookSecret();
    await this.prisma.relayTarget.update({ where: { id }, data: { secret } });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'RelayTarget', entityId: id, details: { secret: 'rotated' } });
    await this.publishSafe();
    return { secret };
  }

  // ── test ─────────────────────────────────────────────────────────────────

  /** RAW_TCP: opens (and closes) a TCP connection. HTTP_JSON: POSTs a signed sample batch. */
  async test(id: string): Promise<RelayTestResult> {
    const t = await this.get(id);
    const started = Date.now();
    const result = (ok: boolean, message: string, status: number | null = null): RelayTestResult => ({ ok, message, status, durationMs: Date.now() - started });
    if (t.type === 'RAW_TCP') {
      const problem = await checkTcpTarget(t.host ?? '', t.port ?? 0, this.policy);
      if (problem) return result(false, problem);
      try {
        await tcpProbe(t.host!, t.port!, TEST_TIMEOUT_MS);
        return result(true, `Connected to ${t.host}:${t.port}`);
      } catch (error) {
        return result(false, (error as Error).message);
      }
    }
    const problem = checkHttpTarget(t.url ?? '', this.policy) ?? (await this.resolvesPublic(t.url ?? ''));
    if (problem) return result(false, problem);
    const now = new Date().toISOString();
    const body: RelayBatchBody & { test: true } = {
      test: true,
      target: { id: t.id, name: t.name },
      sentAt: now,
      positions: [
        { protocol: 'test', uniqueId: '000000000000000', fixTime: now, receivedAt: now, lat: 13.0827, lng: 80.2707, speedKph: 0, course: 0, altitude: null, satellites: 8, valid: true, ignition: false, attributes: {} },
      ],
      alerts: [],
    };
    const json = JSON.stringify(body);
    try {
      const res = await postJson(t.url!, json, batchHeaders({ id: t.id, secret: t.secret, authorization: authorizationHeader(t.authType, t.authValue) }, json), {
        timeoutMs: TEST_TIMEOUT_MS,
        allowPrivate: this.policy.allowPrivate,
      });
      const ok = res.status >= 200 && res.status < 300;
      return result(ok, ok ? `HTTP ${res.status}` : `HTTP ${res.status}${res.body ? `: ${res.body.slice(0, 200)}` : ''}`, res.status);
    } catch (error) {
      return result(false, (error as Error).message);
    }
  }

  // ── rule set for gateways / notifiers ──────────────────────────────────────

  /** Enabled targets with COMPANY / DEVICES scopes resolved to device unique ids (and assigned objects). */
  async buildRuleSet(): Promise<RelayRuleSet> {
    const rows = await this.prisma.relayTarget.findMany({ where: { enabled: true }, orderBy: { createdAt: 'asc' } });
    const rules: RelayRuleSpec[] = [];
    for (const r of rows) {
      let uniqueIds: string[] | null = null;
      let objectIds: string[] | null = null;
      if (r.scope === 'COMPANY' && r.companyId) {
        const devices = await this.prisma.device.findMany({ where: { companyId: r.companyId }, select: { uniqueId: true } });
        uniqueIds = devices.map((d) => d.uniqueId);
      } else if (r.scope === 'DEVICES') {
        const devices = await this.prisma.device.findMany({
          where: { id: { in: r.deviceIds } },
          select: { uniqueId: true, assignments: { where: { toTime: null }, select: { objectId: true } } },
        });
        uniqueIds = devices.map((d) => d.uniqueId);
        objectIds = devices.flatMap((d) => d.assignments.map((a) => a.objectId));
      } else if (r.scope === 'COMPANY') {
        uniqueIds = [];
      }
      rules.push({
        id: r.id,
        name: r.name,
        type: r.type,
        host: r.host,
        port: r.port,
        passDownstream: r.passDownstream,
        url: r.url,
        authorization: authorizationHeader(r.authType, r.authValue),
        secret: r.secret,
        includeAlerts: r.includeAlerts,
        scope: r.scope,
        protocol: r.protocol,
        companyId: r.companyId,
        uniqueIds,
        objectIds,
        liveOnly: r.liveOnly,
        validOnly: r.validOnly,
      });
    }
    return { at: new Date().toISOString(), rules };
  }

  async publish(): Promise<RelayRuleSet> {
    const set = await this.buildRuleSet();
    // Unchanged rules are not rewritten (gateways reload only when the value changes).
    const current = parseRuleSet(await this.redis.client.get(RedisKeys.relayRules));
    if (current && JSON.stringify(current.rules) === JSON.stringify(set.rules)) return current;
    await this.redis.client.multi().set(RedisKeys.relayRules, JSON.stringify(set)).publish(RedisKeys.relayInvalidate, '1').exec();
    return set;
  }

  private async publishSafe(): Promise<void> {
    try {
      await this.publish();
    } catch (error) {
      this.logger.error(`Publishing forwarding rules failed: ${(error as Error).message}`);
    }
  }

  /** On start and every 5 minutes, so device moves between companies reach the gateways. */
  @Timeout(10_000)
  @Interval(REPUBLISH_EVERY_MS)
  async republish(): Promise<void> {
    if (process.env.RELAY === 'off') return;
    await this.publishSafe();
  }
}

/** Opens a TCP connection to host:port and closes it again. */
function tcpProbe(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = new Socket();
    const done = (error?: Error) => {
      s.destroy();
      if (error) reject(error);
      else resolve();
    };
    s.setTimeout(timeoutMs, () => done(new Error(`No answer from ${host}:${port} within ${timeoutMs / 1000} s`)));
    s.once('connect', () => done());
    s.once('error', (error) => done(error));
    s.connect(port, host);
  });
}
