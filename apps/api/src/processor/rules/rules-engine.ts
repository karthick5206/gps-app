import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AlertDto } from '@veetracer/shared';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { NOTIFY_STREAM_MAXLEN } from '../../alerts/alert-dto';
import { CompanyRules, RulesRepository } from '../../alerts/rules-data';
import { RedisKeys } from '../../redis/keys';
import { AlertState, emptyAlertState, evaluatePosition, PendingAlert, RuleInput, RuleObject, VisitOp } from './evaluate';

const STATE_TTL_SEC = 7 * 24 * 3600;
const STATS_EVERY_MS = 10_000;

interface CreatedAlert extends PendingAlert {
  object: RuleObject;
}

function parseState(json: string | null): AlertState | null {
  if (!json) return null;
  try {
    const s = JSON.parse(json) as AlertState;
    return typeof s === 'object' && s && typeof s.gf === 'object' && typeof s.cd === 'object' ? s : null;
  } catch {
    return null;
  }
}

export function pendingToDto(a: CreatedAlert): AlertDto {
  return {
    id: a.id,
    objectId: a.object.objectId,
    objectName: a.object.name,
    plateNumber: a.object.plateNumber,
    branchId: a.object.branchId,
    type: a.type,
    severity: a.severity,
    message: a.message,
    lat: a.lat,
    lng: a.lng,
    address: null,
    geofenceId: a.geofenceId,
    geofenceName: a.geofenceName,
    data: a.data,
    occurredAt: new Date(a.occurredAt).toISOString(),
    status: 'NEW',
    ackByName: null,
    ackAt: null,
    ackNote: null,
    read: false,
    ackRequired: a.ackRequired,
  };
}

/** Result of evaluating one processor batch: DB statements to run with the position insert, then `commit()`. */
export class RulesBatch {
  constructor(
    private readonly redis: Redis,
    readonly alerts: CreatedAlert[],
    readonly visits: { companyId: string; objectId: string; op: VisitOp }[],
    readonly dataUpdates: { alertId: string; data: Record<string, unknown> }[],
    private readonly states: Map<string, string>, // objectId → JSON (only changed ones)
  ) {}

  statements(prisma: PrismaClient): Prisma.PrismaPromise<number>[] {
    const out: Prisma.PrismaPromise<number>[] = [];
    const a = this.alerts;
    if (a.length) {
      out.push(prisma.$executeRaw`
        INSERT INTO "Alert" ("id", "companyId", "objectId", "deviceId", "type", "severity", "message", "lat", "lng",
                             "geofenceId", "data", "occurredAt", "ackRequired")
        SELECT * FROM unnest(
          ${a.map((x) => x.id)}::text[]::uuid[],
          ${a.map((x) => x.object.companyId)}::text[]::uuid[],
          ${a.map((x) => x.object.objectId)}::text[]::uuid[],
          ${a.map((x) => x.object.deviceId)}::text[]::uuid[],
          ${a.map((x) => x.type)}::text[],
          ${a.map((x) => x.severity)}::text[]::"AlertSeverity"[],
          ${a.map((x) => x.message)}::text[],
          ${a.map((x) => (x.lat === null ? null : String(x.lat)))}::text[]::float8[],
          ${a.map((x) => (x.lng === null ? null : String(x.lng)))}::text[]::float8[],
          ${a.map((x) => x.geofenceId)}::text[]::uuid[],
          ${a.map((x) => JSON.stringify(x.data))}::text[]::jsonb[],
          ${a.map((x) => new Date(x.occurredAt).toISOString())}::text[]::timestamptz[],
          ${a.map((x) => x.ackRequired)}::boolean[]
        )`);
    }
    const opens = this.visits.filter((v) => v.op.kind === 'open') as { companyId: string; objectId: string; op: Extract<VisitOp, { kind: 'open' }> }[];
    if (opens.length) {
      out.push(prisma.$executeRaw`
        INSERT INTO "GeofenceVisit" ("id", "companyId", "objectId", "geofenceId", "enterTime")
        SELECT * FROM unnest(
          ${opens.map((v) => v.op.id)}::text[]::uuid[],
          ${opens.map((v) => v.companyId)}::text[]::uuid[],
          ${opens.map((v) => v.objectId)}::text[]::uuid[],
          ${opens.map((v) => v.op.geofenceId)}::text[]::uuid[],
          ${opens.map((v) => new Date(v.op.enterTime).toISOString())}::text[]::timestamptz[]
        )
        ON CONFLICT DO NOTHING`);
    }
    const closes = this.visits.filter((v) => v.op.kind === 'close').map((v) => v.op as Extract<VisitOp, { kind: 'close' }>);
    if (closes.length) {
      out.push(prisma.$executeRaw`
        UPDATE "GeofenceVisit" AS v SET "exitTime" = t.exit_time, "durationSec" = t.duration
        FROM unnest(
          ${closes.map((c) => c.id)}::text[]::uuid[],
          ${closes.map((c) => new Date(c.exitTime).toISOString())}::text[]::timestamptz[],
          ${closes.map((c) => String(c.durationSec))}::text[]::integer[]
        ) AS t(id, exit_time, duration)
        WHERE v.id = t.id`);
    }
    const u = this.dataUpdates;
    if (u.length) {
      out.push(prisma.$executeRaw`
        UPDATE "Alert" AS al SET "data" = al."data" || t.d
        FROM unnest(${u.map((x) => x.alertId)}::text[]::uuid[], ${u.map((x) => JSON.stringify(x.data))}::text[]::jsonb[]) AS t(id, d)
        WHERE al.id = t.id`);
    }
    return out;
  }

  /** After the DB write succeeded: persist rule state, publish alerts for realtime and queue notification jobs. */
  async commit(): Promise<void> {
    if (!this.states.size && !this.alerts.length) return;
    const pipeline = this.redis.pipeline();
    for (const [objectId, json] of this.states) pipeline.set(RedisKeys.alertState(objectId), json, 'EX', STATE_TTL_SEC);
    for (const alert of this.alerts) {
      pipeline.publish(RedisKeys.alertsChannel, JSON.stringify({ companyId: alert.object.companyId, alert: pendingToDto(alert) }));
      pipeline.xadd(RedisKeys.notifyStream, 'MAXLEN', '~', NOTIFY_STREAM_MAXLEN, '*', 'alertId', alert.id, 'companyId', alert.object.companyId);
    }
    const results = await pipeline.exec();
    const failed = results?.find(([error]) => error);
    if (failed?.[0]) throw failed[0];
  }
}

/** Runs the alert rules for the non-LATE, valid positions of a processor batch. */
export class RulesEngine {
  private readonly logger = new Logger('Rules');
  private stats = { batches: 0, positions: 0, alerts: 0, evalMs: 0, commitMs: 0, maxMs: 0 };
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly redis: Redis,
    readonly repo: RulesRepository,
  ) {
    this.timer = setInterval(() => this.logStats(), STATS_EVERY_MS);
    this.timer.unref();
  }

  async evaluate(inputs: RuleInput[]): Promise<RulesBatch | null> {
    if (!inputs.length) return null;
    const started = performance.now();
    const objectIds = [...new Set(inputs.map((i) => i.object.objectId))];
    const companyIds = [...new Set(inputs.map((i) => i.object.companyId))];
    const [rawStates, rulesList] = await Promise.all([
      this.redis.mget(...objectIds.map(RedisKeys.alertState)),
      Promise.all(companyIds.map((id) => this.repo.get(id))),
    ]);
    const rulesByCompany = new Map<string, CompanyRules>(companyIds.map((id, i) => [id, rulesList[i]]));
    const original = new Map<string, string | null>();
    const states = new Map<string, AlertState>();
    objectIds.forEach((id, i) => {
      original.set(id, rawStates[i]);
      states.set(id, parseState(rawStates[i]) ?? emptyAlertState());
    });

    const alerts: CreatedAlert[] = [];
    const visits: { companyId: string; objectId: string; op: VisitOp }[] = [];
    const dataUpdates: { alertId: string; data: Record<string, unknown> }[] = [];
    for (const input of inputs) {
      const rules = rulesByCompany.get(input.object.companyId)!;
      const { objectId, companyId } = input.object;
      const out = evaluatePosition(input, states.get(objectId)!, {
        settings: rules.effective(objectId),
        geofences: rules.geofencesFor(objectId),
        timezone: rules.timezone,
        newId: randomUUID,
        // Armed or not is about now (server clock), not the fix time of a late point.
        parking: rules.parkingWindow(objectId, input.receivedAt ?? Date.now()),
      });
      for (const a of out.alerts) alerts.push({ ...a, object: input.object });
      for (const op of out.visits) visits.push({ companyId, objectId, op });
      dataUpdates.push(...out.dataUpdates);
    }

    const changed = new Map<string, string>();
    for (const [id, state] of states) {
      const json = JSON.stringify(state);
      if (json !== original.get(id)) changed.set(id, json);
    }
    const ms = performance.now() - started;
    this.stats.batches++;
    this.stats.positions += inputs.length;
    this.stats.alerts += alerts.length;
    this.stats.evalMs += ms;
    this.stats.maxMs = Math.max(this.stats.maxMs, ms);
    return new RulesBatch(this.redis, alerts, visits, dataUpdates, changed);
  }

  recordCommit(ms: number): void {
    this.stats.commitMs += ms;
  }

  private logStats(): void {
    const s = this.stats;
    if (!s.batches) return;
    this.stats = { batches: 0, positions: 0, alerts: 0, evalMs: 0, commitMs: 0, maxMs: 0 };
    this.logger.log(
      `rules batches=${s.batches} positions=${s.positions} alerts=${s.alerts} ` +
        `avgEvalMs=${(s.evalMs / s.batches).toFixed(2)} avgCommitMs=${(s.commitMs / s.batches).toFixed(2)} maxEvalMs=${s.maxMs.toFixed(1)}`,
    );
  }
}
