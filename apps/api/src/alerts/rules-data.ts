import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AlertTypeCode, EffectiveAlertSetting, GeofenceGeometry, GeofenceMode, TimeWindow } from '@veetracer/shared';
import { companyThresholds } from '../tracking/thresholds';
import { BBox } from './logic/geofence-geometry';
import {
  ApplicableSnooze,
  GroupOverrides,
  OverrideMap,
  resolveEffectiveSettings,
  SettingsChain,
  toOverride,
} from './logic/settings-resolution';
import { isValidTimeWindow } from './logic/time-window';

export interface GeofenceRuntime {
  id: string;
  name: string;
  branchId: string | null;
  geometry: GeofenceGeometry;
  bbox: BBox;
  mode: GeofenceMode;
  notifyEnter: boolean;
  notifyExit: boolean;
  maxStayMin: number | null;
  speedLimitKph: number | null;
  timeWindows: TimeWindow[];
  appliesToAll: boolean;
  branchTargets: Set<string>;
  groupTargets: Set<string>;
  objectTargets: Set<string>;
}

export interface ObjectRuntime {
  id: string;
  branchId: string | null;
  groupIds: string[];
  capabilities: string[];
}

export interface SnoozeRuntime {
  level: string;
  targetId: string;
  alertTypes: string[];
  until: number;
}

const key = (level: string, targetId: string) => `${level}:${targetId}`;

/** Everything the rules engine needs for one company, with per-object memoisation. */
export class CompanyRules {
  private readonly effectiveCache = new Map<string, Map<AlertTypeCode, EffectiveAlertSetting>>();
  private readonly geofenceCache = new Map<string, GeofenceRuntime[]>();

  constructor(
    readonly companyId: string,
    readonly timezone: string,
    readonly offlineAfterSec: number,
    private readonly settings: Map<string, OverrideMap>,
    readonly groups: Map<string, { name: string; priority: number }>,
    readonly objects: Map<string, ObjectRuntime>,
    readonly geofences: GeofenceRuntime[],
    readonly snoozes: SnoozeRuntime[],
    readonly loadedAt: number,
  ) {}

  object(objectId: string): ObjectRuntime {
    return this.objects.get(objectId) ?? { id: objectId, branchId: null, groupIds: [], capabilities: [] };
  }

  chain(objectId: string): SettingsChain {
    const o = this.object(objectId);
    const groups: GroupOverrides[] = o.groupIds
      .map((groupId) => {
        const g = this.groups.get(groupId);
        if (!g) return null;
        return { groupId, name: g.name, priority: g.priority, rows: this.settings.get(key('GROUP', groupId)) ?? {} };
      })
      .filter((g): g is GroupOverrides => g !== null);
    return {
      company: this.settings.get(key('COMPANY', this.companyId)),
      branch: o.branchId ? this.settings.get(key('BRANCH', o.branchId)) : undefined,
      groups,
      object: this.settings.get(key('OBJECT', objectId)),
    };
  }

  applicableSnoozes(objectId: string): ApplicableSnooze[] {
    const o = this.object(objectId);
    return this.snoozes
      .filter(
        (s) =>
          (s.level === 'COMPANY' && s.targetId === this.companyId) ||
          (s.level === 'BRANCH' && s.targetId === o.branchId) ||
          (s.level === 'GROUP' && o.groupIds.includes(s.targetId)) ||
          (s.level === 'OBJECT' && s.targetId === objectId),
      )
      .map((s) => ({ alertTypes: s.alertTypes, until: s.until }));
  }

  /** Effective settings per alert type (memoised; snooze expiry is checked by the caller via `isSnoozed`). */
  effective(objectId: string): Map<AlertTypeCode, EffectiveAlertSetting> {
    let map = this.effectiveCache.get(objectId);
    if (!map) {
      const list = resolveEffectiveSettings(this.chain(objectId), this.object(objectId).capabilities, this.applicableSnoozes(objectId), Date.now());
      map = new Map(list.map((s) => [s.alertType, s]));
      this.effectiveCache.set(objectId, map);
    }
    return map;
  }

  geofencesFor(objectId: string): GeofenceRuntime[] {
    let list = this.geofenceCache.get(objectId);
    if (!list) {
      const o = this.object(objectId);
      list = this.geofences.filter(
        (g) =>
          g.appliesToAll ||
          g.objectTargets.has(objectId) ||
          (o.branchId !== null && g.branchTargets.has(o.branchId)) ||
          o.groupIds.some((id) => g.groupTargets.has(id)),
      );
      this.geofenceCache.set(objectId, list);
    }
    return list;
  }
}

export function isSnoozed(setting: EffectiveAlertSetting, at: number): boolean {
  return setting.snoozedUntil !== null && Date.parse(setting.snoozedUntil) > at;
}

export interface LoadOptions {
  objectIds?: string[];
  geofences?: boolean;
}

/** Load a company's rules from the database (optionally only some objects, and without geofences). */
export async function loadCompanyRules(prisma: PrismaClient, companyId: string, opts: LoadOptions = {}): Promise<CompanyRules> {
  const now = new Date();
  const [company, settingRows, groupRows, objectRows, geofenceRows, snoozeRows] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true, settings: true } }),
    prisma.alertSetting.findMany({ where: { companyId } }),
    prisma.vehicleGroup.findMany({ where: { companyId, isActive: true }, select: { id: true, name: true, alertPriority: true } }),
    prisma.trackedObject.findMany({
      where: { companyId, ...(opts.objectIds ? { id: { in: opts.objectIds } } : {}) },
      select: {
        id: true,
        branchId: true,
        groups: { select: { groupId: true } },
        assignments: { where: { toTime: null }, select: { device: { select: { model: { select: { capabilities: true } } } } } },
      },
    }),
    opts.geofences === false
      ? Promise.resolve([])
      : prisma.geofence.findMany({ where: { companyId, isActive: true }, include: { targets: true } }),
    prisma.alertSnooze.findMany({ where: { companyId, until: { gt: now } } }),
  ]);

  const settings = new Map<string, OverrideMap>();
  for (const row of settingRows) {
    const k = key(row.level, row.targetId);
    const map = settings.get(k) ?? {};
    map[row.alertType] = toOverride(row);
    settings.set(k, map);
  }
  const groups = new Map(groupRows.map((g) => [g.id, { name: g.name, priority: g.alertPriority }]));
  const objects = new Map<string, ObjectRuntime>(
    objectRows.map((o) => [
      o.id,
      {
        id: o.id,
        branchId: o.branchId,
        groupIds: o.groups.map((g) => g.groupId).filter((id) => groups.has(id)),
        capabilities: o.assignments[0]?.device.model.capabilities ?? [],
      },
    ]),
  );
  const geofences: GeofenceRuntime[] = geofenceRows.map((g) => ({
    id: g.id,
    name: g.name,
    branchId: g.branchId,
    geometry: g.geometry as unknown as GeofenceGeometry,
    bbox: { minLat: g.minLat, minLng: g.minLng, maxLat: g.maxLat, maxLng: g.maxLng },
    mode: g.mode,
    notifyEnter: g.notifyEnter,
    notifyExit: g.notifyExit,
    maxStayMin: g.maxStayMin,
    speedLimitKph: g.speedLimitKph,
    timeWindows: Array.isArray(g.timeWindows) ? (g.timeWindows as unknown[]).filter(isValidTimeWindow) : [],
    appliesToAll: g.appliesToAll,
    branchTargets: new Set(g.targets.filter((t) => t.kind === 'BRANCH').map((t) => t.refId)),
    groupTargets: new Set(g.targets.filter((t) => t.kind === 'GROUP').map((t) => t.refId)),
    objectTargets: new Set(g.targets.filter((t) => t.kind === 'OBJECT').map((t) => t.refId)),
  }));
  const snoozes = snoozeRows.map((s) => ({ level: s.level, targetId: s.targetId, alertTypes: s.alertTypes, until: s.until.getTime() }));
  return new CompanyRules(
    companyId,
    company?.timezone ?? 'Asia/Kolkata',
    companyThresholds(company?.settings).offlineAfterSec,
    settings,
    groups,
    objects,
    geofences,
    snoozes,
    Date.now(),
  );
}

interface Entry {
  rules: CompanyRules | null;
  loading: Promise<CompanyRules> | null;
  stale: boolean;
}

/**
 * Per-company rules cache for long-running processes (processor, notifier). Invalidated companies are reloaded in
 * the background while the previous snapshot keeps serving, so the hot path only waits on a company's very first load.
 * Entries also refresh after `ttlMs` as a safety net.
 */
export class RulesRepository {
  private readonly logger = new Logger('RulesRepository');
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ttlMs = 60_000,
  ) {}

  invalidate(companyId?: string | null): void {
    if (!companyId) {
      for (const e of this.entries.values()) e.stale = true;
      return;
    }
    const e = this.entries.get(companyId);
    if (e) e.stale = true;
  }

  async get(companyId: string): Promise<CompanyRules> {
    let e = this.entries.get(companyId);
    if (!e) {
      e = { rules: null, loading: null, stale: true };
      this.entries.set(companyId, e);
    }
    if (e.rules && Date.now() - e.rules.loadedAt > this.ttlMs) e.stale = true;
    if (e.stale && !e.loading) this.reload(companyId, e);
    if (e.rules) return e.rules;
    return e.loading!;
  }

  /** Wait for a fresh snapshot (used right after an invalidation when correctness matters more than latency). */
  async fresh(companyId: string): Promise<CompanyRules> {
    const e = this.entries.get(companyId);
    if (e?.loading) await e.loading.catch(() => undefined);
    if (!e || e.stale || !e.rules) {
      this.invalidate(companyId);
      const entry = this.entries.get(companyId);
      if (entry && !entry.loading) this.reload(companyId, entry);
      return entry?.loading ?? this.get(companyId);
    }
    return e.rules;
  }

  private reload(companyId: string, e: Entry): void {
    e.stale = false;
    const started = Date.now();
    e.loading = loadCompanyRules(this.prisma, companyId)
      .then((rules) => {
        e.rules = rules;
        const ms = Date.now() - started;
        if (ms > 200) this.logger.log(`Loaded rules for company ${companyId} in ${ms} ms`);
        return rules;
      })
      .catch((error: Error) => {
        e.stale = true;
        this.logger.error(`Loading rules for ${companyId} failed: ${error.message}`);
        if (e.rules) return e.rules;
        throw error;
      })
      .finally(() => {
        e.loading = null;
      });
  }
}
