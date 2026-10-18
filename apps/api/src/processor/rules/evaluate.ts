import { AlertSeverity, AlertTypeCode, EffectiveAlertSetting } from '@veetracer/shared';
import { GeofenceRuntime, isSnoozed } from '../../alerts/rules-data';
import { GEOFENCE_BUFFER_M, inBBox, signedDistanceM, updateMembership } from '../../alerts/logic/geofence-geometry';
import { formatDuration, inAnyTimeWindow, inDailyRange } from '../../alerts/logic/time-window';
import { haversineMeters } from '../../tracking/geo';

/** Episodes end when no point arrived for this long. */
export const EPISODE_GAP_MS = 5 * 60_000;
/** Engine considered running without an ignition wire above this external voltage. */
export const ENGINE_ON_VOLTAGE = 13.2;
const LOW_BATTERY_HYSTERESIS_PCT = 5;
const COOLDOWN_PRUNE_MS = 24 * 3600_000;

export interface GeofenceMembership {
  in: boolean;
  since: number;
  pc: number; // pending count
  ps: number | null; // pending since
  visitId?: string;
  stay?: boolean; // GEOFENCE_STAY already raised for this visit
  os?: boolean; // currently overspeeding inside (GEOFENCE_OVERSPEED raised)
}

export interface OverspeedEpisode {
  start: number;
  last: number;
  max: number;
  limit: number;
  alertId: string | null;
  lastAlertAt: number | null;
  critical: boolean;
}

export interface IdleEpisode {
  start: number;
  last: number;
  lat: number;
  lng: number;
  level: 0 | 1 | 2; // 0 none, 1 warning raised, 2 critical raised
  alertId: string | null;
  lastAlertAt: number | null;
}

/** Persisted per object in `vt:alertstate:<objectId>`. */
export interface AlertState {
  gf: Record<string, GeofenceMembership>;
  os?: OverspeedEpisode;
  idle?: IdleEpisode;
  ign?: boolean | null;
  batLow?: boolean;
  /** Device health episodes: start time (server clock) and whether the alert was raised. */
  gpsLost?: { since: number; alerted: boolean };
  gsmWeak?: { since: number; alerted: boolean };
  powerLow?: { since: number; alerted: boolean };
  /** Last external voltage, to detect a drop to ~0 V (main power removed). */
  extV?: number;
  /** Last alert time per cooldown key (alert type, or type:geofenceId). */
  cd: Record<string, number>;
}

/**
 * Overspeed limit, most specific first: an Alert Settings limit set on this vehicle → the limit set on the vehicle itself
 * (vehicle / device form) → an Alert Settings limit inherited from company, branch or group → the vehicle-type default.
 */
export function overspeedLimit(settingLimit: number | null, settingSource: string | undefined, object: Pick<RuleObject, 'speedLimitKph' | 'ownSpeedLimitKph'>): number | null {
  if (settingLimit !== null && settingSource === 'OBJECT') return settingLimit;
  if (object.ownSpeedLimitKph != null) return object.ownSpeedLimitKph;
  return settingLimit ?? object.speedLimitKph;
}

export const emptyAlertState = (): AlertState => ({ gf: {}, cd: {} });

export interface RuleObject {
  objectId: string;
  companyId: string;
  branchId: string | null;
  name: string;
  plateNumber: string | null;
  deviceId: string | null;
  /** Effective speed limit of the object (own limit or vehicle-type default), null = never overspeeds. */
  speedLimitKph: number | null;
  /** Limit set on the vehicle itself (vehicle / device form); null or absent = not set. */
  ownSpeedLimitKph?: number | null;
}

export interface RuleInput {
  object: RuleObject;
  fixTime: number;
  lat: number;
  lng: number;
  speedKph: number;
  ignition: boolean | null;
  attributes: Record<string, unknown>;
  /**
   * False when the point has no valid GPS fix: only rules that don't depend on location run (ignition, SOS/power-cut
   * alarms, battery); lat/lng are then the last known location, or NaN when there is none. Default true.
   */
  locationValid?: boolean;
  /** When the server received the point (ms). Defaults to fixTime. Used for health durations and for alerts from
   * points without a fix, whose device time can't be trusted. */
  receivedAt?: number;
  /** Only run device-health checks (points that don't update live state, e.g. a clock running ahead). */
  healthOnly?: boolean;
}

export interface PendingAlert {
  id: string;
  type: AlertTypeCode;
  severity: AlertSeverity;
  message: string;
  occurredAt: number;
  lat: number | null;
  lng: number | null;
  geofenceId: string | null;
  geofenceName: string | null;
  data: Record<string, unknown>;
}

export type VisitOp =
  | { kind: 'open'; id: string; geofenceId: string; enterTime: number }
  | { kind: 'close'; id: string; exitTime: number; durationSec: number };

export interface EvalContext {
  settings: Map<AlertTypeCode, EffectiveAlertSetting>;
  geofences: GeofenceRuntime[];
  timezone: string;
  newId: () => string;
}

export interface EvalOutput {
  alerts: PendingAlert[];
  visits: VisitOp[];
  /** Merge into an existing alert's data (end-of-event summaries). */
  dataUpdates: { alertId: string; data: Record<string, unknown> }[];
}

const num = (v: unknown, fallback: number | null = null): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/**
 * Gate shared by every alert: supported by the device, enabled, inside the schedule (company timezone), not snoozed
 * (mandatory types ignore snoozes — resolution never marks them snoozed) and outside the cooldown.
 */
export function canEmit(
  setting: EffectiveAlertSetting | undefined,
  state: AlertState,
  cooldownKey: string,
  at: number,
  timezone: string,
): setting is EffectiveAlertSetting {
  if (!setting || !setting.supported || !setting.enabled) return false;
  if (setting.schedule && !inAnyTimeWindow([setting.schedule], at, timezone)) return false;
  if (isSnoozed(setting, at)) return false;
  const last = state.cd[cooldownKey];
  if (last !== undefined && setting.cooldownMin > 0 && at - last < setting.cooldownMin * 60_000) return false;
  return true;
}

class Evaluator {
  readonly out: EvalOutput = { alerts: [], visits: [], dataUpdates: [] };

  constructor(
    private readonly input: RuleInput,
    private readonly state: AlertState,
    private readonly ctx: EvalContext,
  ) {}

  emit(
    type: AlertTypeCode,
    opts: {
      severity?: AlertSeverity;
      message: string;
      data?: Record<string, unknown>;
      geofence?: GeofenceRuntime;
      at?: number;
      cooldownKey?: string;
    },
  ): string | null {
    const setting = this.ctx.settings.get(type);
    // A point without a GPS fix may carry a default device date (years off): date those alerts by the server clock.
    const at = opts.at ?? (this.input.locationValid === false ? this.now : this.input.fixTime);
    const cdKey = opts.cooldownKey ?? type;
    if (!canEmit(setting, this.state, cdKey, at, this.ctx.timezone)) return null;
    this.state.cd[cdKey] = at;
    const id = this.ctx.newId();
    this.out.alerts.push({
      id,
      type,
      severity: opts.severity ?? setting.severity,
      message: opts.message,
      occurredAt: at,
      lat: Number.isFinite(this.input.lat) ? this.input.lat : null,
      lng: Number.isFinite(this.input.lng) ? this.input.lng : null,
      geofenceId: opts.geofence?.id ?? null,
      geofenceName: opts.geofence?.name ?? null,
      data: { speedKph: Math.round(this.input.speedKph), ...(opts.data ?? {}) },
    });
    return id;
  }

  /** Server time of the point. */
  private get now(): number {
    return this.input.receivedAt ?? this.input.fixTime;
  }

  run(): EvalOutput {
    if (this.input.healthOnly) {
      this.health();
      return this.out;
    }
    if (this.input.locationValid !== false) {
      this.geofences();
      this.overspeed();
      this.idling();
    }
    this.ignition();
    this.alarms();
    this.battery();
    this.health();
    this.pruneCooldowns();
    return this.out;
  }

  // ───────────── geofences ─────────────
  private geofences(): void {
    const { lat, lng, fixTime, speedKph } = this.input;
    const applicable = new Set<string>();
    for (const g of this.ctx.geofences) {
      applicable.add(g.id);
      const m = this.state.gf[g.id];
      const near = inBBox(g.bbox, lat, lng, GEOFENCE_BUFFER_M + 5);
      if (!m && !near) continue; // outside and nothing pending: nothing to track
      const d = near ? signedDistanceM(g.geometry, lat, lng) : Number.POSITIVE_INFINITY;
      const prev = m
        ? { inside: m.in, since: m.since, pendingCount: m.pc, pendingSince: m.ps }
        : { inside: false, since: fixTime, pendingCount: 0, pendingSince: null };
      const { state: next, event, at } = updateMembership(prev, d, fixTime);
      const membership: GeofenceMembership = { ...(m ?? {}), in: next.inside, since: next.since, pc: next.pendingCount, ps: next.pendingSince };
      const windowOk = inAnyTimeWindow(g.timeWindows, at, this.ctx.timezone);

      if (event === 'ENTER') {
        const visitId = this.ctx.newId();
        this.out.visits.push({ kind: 'open', id: visitId, geofenceId: g.id, enterTime: at });
        membership.visitId = visitId;
        membership.stay = false;
        membership.os = false;
        if ((g.notifyEnter || g.mode === 'NO_GO') && windowOk) {
          this.emit('GEOFENCE_ENTER', {
            severity: g.mode === 'NO_GO' ? 'CRITICAL' : undefined,
            message: g.mode === 'NO_GO' ? `Entered no-go zone ${g.name}` : `Entered ${g.name}`,
            data: { geofence: g.name, mode: g.mode },
            geofence: g,
            at,
            cooldownKey: `GEOFENCE_ENTER:${g.id}`,
          });
        }
      } else if (event === 'EXIT') {
        const durationSec = Math.max(0, Math.round((at - (m?.since ?? at)) / 1000));
        if (m?.visitId) this.out.visits.push({ kind: 'close', id: m.visitId, exitTime: at, durationSec });
        delete membership.visitId;
        if ((g.notifyExit || g.mode === 'KEEP_IN') && windowOk) {
          this.emit('GEOFENCE_EXIT', {
            severity: g.mode === 'KEEP_IN' ? 'CRITICAL' : undefined,
            message: g.mode === 'KEEP_IN' ? `Left keep-inside zone ${g.name}` : `Left ${g.name}`,
            data: { geofence: g.name, mode: g.mode, durationSec },
            geofence: g,
            at,
            cooldownKey: `GEOFENCE_EXIT:${g.id}`,
          });
        }
      }

      if (membership.in && event !== 'ENTER') {
        if (g.maxStayMin && !membership.stay && fixTime - membership.since >= g.maxStayMin * 60_000) {
          membership.stay = true;
          if (windowOk) {
            const durationSec = Math.round((fixTime - membership.since) / 1000);
            this.emit('GEOFENCE_STAY', {
              message: `In ${g.name} for ${formatDuration(durationSec)} (max ${g.maxStayMin} min)`,
              data: { geofence: g.name, durationSec, maxStayMin: g.maxStayMin },
              geofence: g,
              cooldownKey: `GEOFENCE_STAY:${g.id}`,
            });
          }
        }
      }
      if (membership.in && g.speedLimitKph) {
        if (speedKph > g.speedLimitKph) {
          if (!membership.os) {
            membership.os = true;
            if (windowOk) {
              this.emit('GEOFENCE_OVERSPEED', {
                message: `${Math.round(speedKph)} km/h inside ${g.name} (limit ${g.speedLimitKph} km/h)`,
                data: { geofence: g.name, limitKph: g.speedLimitKph },
                geofence: g,
                cooldownKey: `GEOFENCE_OVERSPEED:${g.id}`,
              });
            }
          }
        } else membership.os = false;
      }

      if (!membership.in && membership.pc === 0) delete this.state.gf[g.id];
      else this.state.gf[g.id] = membership;
    }
    // Geofences deleted, deactivated or no longer applicable: close open visits silently.
    for (const [id, m] of Object.entries(this.state.gf)) {
      if (applicable.has(id)) continue;
      if (m.in && m.visitId) {
        this.out.visits.push({ kind: 'close', id: m.visitId, exitTime: fixTime, durationSec: Math.max(0, Math.round((fixTime - m.since) / 1000)) });
      }
      delete this.state.gf[id];
    }
  }

  // ───────────── overspeed ─────────────
  private overspeed(): void {
    const setting = this.ctx.settings.get('OVERSPEED');
    const p = setting?.params ?? {};
    const { fixTime, speedKph } = this.input;
    let ep = this.state.os;
    if (ep && fixTime - ep.last > EPISODE_GAP_MS) {
      this.endOverspeed(ep);
      ep = undefined;
    }
    const baseLimit = overspeedLimit(num(p.limitKph), setting?.sources['params.limitKph'], this.input.object);
    const nightLimit = num(p.nightLimitKph);
    const night = nightLimit !== null && inDailyRange(p.nightFrom, p.nightTo, fixTime, this.ctx.timezone);
    const limit = night ? nightLimit : baseLimit;
    if (limit === null) {
      if (ep) this.endOverspeed(ep);
      return;
    }
    const tolerance = num(p.toleranceKph, 5)!;
    const over = speedKph > limit + tolerance;
    if (!over) {
      if (ep) this.endOverspeed(ep);
      return;
    }
    if (!ep) ep = { start: fixTime, last: fixTime, max: speedKph, limit, alertId: null, lastAlertAt: null, critical: false };
    ep.last = fixTime;
    ep.max = Math.max(ep.max, speedKph);
    ep.limit = limit;
    this.state.os = ep;

    const durationSec = Math.round((fixTime - ep.start) / 1000);
    const critical = speedKph > limit + num(p.criticalOverKph, 20)!;
    const data = { limitKph: limit, maxSpeedKph: Math.round(ep.max), toleranceKph: tolerance, night, durationSec };
    const message = `Overspeed: ${Math.round(speedKph)} km/h (limit ${limit} km/h)`;
    if (!ep.alertId) {
      if (durationSec * 1000 < num(p.minDurationSec, 10)! * 1000) return;
      const id = this.emit('OVERSPEED', { severity: critical ? 'CRITICAL' : undefined, message, data });
      if (id) {
        ep.alertId = id;
        ep.lastAlertAt = fixTime;
        ep.critical = critical;
      }
      return;
    }
    if (critical && !ep.critical) {
      const id = this.emit('OVERSPEED', { severity: 'CRITICAL', message, data: { ...data, escalated: true } });
      if (id) {
        ep.alertId = id;
        ep.lastAlertAt = fixTime;
        ep.critical = true;
      }
      return;
    }
    const repeatMin = num(p.repeatEveryMin, 0)!;
    if (repeatMin > 0 && ep.lastAlertAt !== null && fixTime - ep.lastAlertAt >= repeatMin * 60_000) {
      const id = this.emit('OVERSPEED', { severity: ep.critical ? 'CRITICAL' : undefined, message, data: { ...data, repeat: true } });
      if (id) {
        ep.alertId = id;
        ep.lastAlertAt = fixTime;
      }
    }
  }

  private endOverspeed(ep: OverspeedEpisode): void {
    if (ep.alertId) {
      this.out.dataUpdates.push({
        alertId: ep.alertId,
        data: {
          endedAt: new Date(ep.last).toISOString(),
          durationSec: Math.round((ep.last - ep.start) / 1000),
          maxSpeedKph: Math.round(ep.max),
          limitKph: ep.limit,
        },
      });
    }
    delete this.state.os;
  }

  // ───────────── idling ─────────────
  private idling(): void {
    const setting = this.ctx.settings.get('IDLING');
    const p = setting?.params ?? {};
    const { fixTime, speedKph, ignition, lat, lng, attributes } = this.input;
    let ep = this.state.idle;
    if (ep && fixTime - ep.last > EPISODE_GAP_MS) {
      this.endIdle(ep);
      ep = undefined;
    }
    const extVoltage = num(attributes.extVoltage);
    const engineOn = ignition === true || (ignition === null && extVoltage !== null && extVoltage > ENGINE_ON_VOLTAGE);
    const idleNow = engineOn && speedKph < num(p.speedBelowKph, 3)!;
    if (!idleNow) {
      if (ep) this.endIdle(ep);
      return;
    }
    const tolerance = num(p.movementToleranceM, 50)!;
    if (ep && haversineMeters(ep.lat, ep.lng, lat, lng) > tolerance) {
      this.endIdle(ep);
      ep = undefined;
    }
    if (!ep) ep = { start: fixTime, last: fixTime, lat, lng, level: 0, alertId: null, lastAlertAt: null };
    ep.last = fixTime;
    this.state.idle = ep;

    const excluded = Array.isArray(p.excludeGeofenceIds) && (p.excludeGeofenceIds as string[]).some((id) => this.state.gf[id]?.in);
    if (excluded) return;
    const elapsed = fixTime - ep.start;
    const durationSec = Math.round(elapsed / 1000);
    const message = `Idling for ${formatDuration(durationSec)}`;
    const data = { durationSec };
    const criticalMs = num(p.criticalMin, 30)! * 60_000;
    const warnMs = num(p.thresholdMin, 10)! * 60_000;
    let raised: string | null = null;
    if (elapsed >= criticalMs && ep.level < 2) {
      raised = this.emit('IDLING', { severity: 'CRITICAL', message, data });
      if (raised) ep.level = 2;
    } else if (elapsed >= warnMs && ep.level < 1) {
      raised = this.emit('IDLING', { message, data });
      if (raised) ep.level = 1;
    } else if (ep.level > 0) {
      const repeatMin = num(p.repeatEveryMin, 15)!;
      if (repeatMin > 0 && ep.lastAlertAt !== null && fixTime - ep.lastAlertAt >= repeatMin * 60_000) {
        raised = this.emit('IDLING', { severity: ep.level === 2 ? 'CRITICAL' : undefined, message, data: { ...data, repeat: true } });
      }
    }
    if (raised) {
      ep.alertId = raised;
      ep.lastAlertAt = fixTime;
    }
  }

  private endIdle(ep: IdleEpisode): void {
    if (ep.alertId) {
      this.out.dataUpdates.push({
        alertId: ep.alertId,
        data: { endedAt: new Date(ep.last).toISOString(), durationSec: Math.round((ep.last - ep.start) / 1000) },
      });
    }
    delete this.state.idle;
  }

  // ───────────── ignition / alarms / battery ─────────────
  private ignition(): void {
    const { ignition } = this.input;
    const prev = this.state.ign;
    if (ignition !== null && prev !== undefined && prev !== null && prev !== ignition) {
      this.emit(ignition ? 'IGNITION_ON' : 'IGNITION_OFF', { message: ignition ? 'Ignition switched on' : 'Ignition switched off' });
    }
    if (ignition !== null) this.state.ign = ignition;
  }

  private alarms(): void {
    const alarm = this.input.attributes.alarm;
    if (alarm === 'sos') this.emit('SOS', { message: 'SOS / panic button pressed', data: { alarm } });
    else if (alarm === 'powerCut') this.emit('POWER_CUT', { message: 'Tracker main power disconnected', data: { alarm } });
    else if (alarm === 'tamper' || alarm === 'jamming') {
      this.emit('DEVICE_TAMPER', { message: alarm === 'jamming' ? 'Tracker reported GPS/GSM jamming' : 'Tracker reported tampering (case opened or removed)', data: { alarm } });
    }
  }

  private battery(): void {
    const level = num(this.input.attributes.batteryLevel);
    if (level === null) return;
    const threshold = num(this.ctx.settings.get('LOW_BATTERY')?.params.thresholdPct, 20)!;
    if (level < threshold && !this.state.batLow) {
      this.state.batLow = true;
      this.emit('LOW_BATTERY', { message: `Tracker battery at ${Math.round(level)}%`, data: { batteryPct: Math.round(level), thresholdPct: threshold } });
    } else if (level >= threshold + LOW_BATTERY_HYSTERESIS_PCT && this.state.batLow) {
      this.state.batLow = false;
    }
  }

  // ───────────── device health (data-driven) ─────────────
  private param(type: AlertTypeCode, key: string, fallback: number): number {
    return num(this.ctx.settings.get(type)?.params[key], fallback)!;
  }

  /** Starts / continues / clears a health episode and raises its alert once when it lasted long enough. */
  private episode(
    key: 'gpsLost' | 'gsmWeak' | 'powerLow',
    active: boolean,
    afterMin: number,
    raise: (durationSec: number) => void,
  ): void {
    if (!active) {
      delete this.state[key];
      return;
    }
    const ep = (this.state[key] ??= { since: this.now, alerted: false });
    const durationSec = Math.round((this.now - ep.since) / 1000);
    if (!ep.alerted && durationSec >= afterMin * 60) {
      ep.alerted = true;
      raise(durationSec);
    }
  }

  private health(): void {
    const { attributes } = this.input;
    const reupload = attributes.reupload === true;
    const fmt = (sec: number) => (sec >= 3600 ? `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min` : `${Math.round(sec / 60)} min`);

    if (!this.input.healthOnly) {
      // GPS: data keeps arriving without a valid fix.
      this.episode('gpsLost', this.input.locationValid === false, this.param('GPS_LOST', 'afterMin', 30), (durationSec) =>
        this.emit('GPS_LOST', { at: this.now, message: `No GPS fix for ${fmt(durationSec)}`, data: { durationSec } }),
      );

      // GSM: weak mobile signal for a while.
      const gsm = num(attributes.gsmSignal);
      if (gsm !== null) {
        this.episode('gsmWeak', gsm <= this.param('GSM_WEAK', 'maxLevel', 1), this.param('GSM_WEAK', 'afterMin', 30), (durationSec) =>
          this.emit('GSM_WEAK', { at: this.now, message: `Mobile signal ${gsm}/4 for ${fmt(durationSec)}`, data: { durationSec, gsmSignal: gsm } }),
        );
      }

      // Power source: main power removed (voltage drops to ~0) or vehicle battery low.
      const v = num(attributes.extVoltage);
      if (v !== null) {
        const prev = this.state.extV;
        if (prev !== undefined && prev >= 6 && v < 1) {
          this.emit('POWER_CUT', { at: this.now, message: `Main power disconnected (${prev.toFixed(1)} V → ${v.toFixed(1)} V)`, data: { voltage: v, previousVoltage: prev, source: 'voltage' } });
        }
        const threshold = this.param('POWER_LOW', 'thresholdV', 11.5);
        const low = v >= 1 && v < threshold;
        // Small hysteresis so a voltage hovering at the threshold doesn't restart the episode.
        if (low || !this.state.powerLow || v >= threshold + 0.3) {
          this.episode('powerLow', low, this.param('POWER_LOW', 'afterMin', 10), () =>
            this.emit('POWER_LOW', { at: this.now, message: `Vehicle voltage low: ${v.toFixed(1)} V (below ${threshold} V)`, data: { voltage: v, thresholdV: threshold } }),
          );
        }
        this.state.extV = v;
      }

      // GPRS: live data arriving late = the tracker buffered it while the network was down.
      const delaySec = Math.round((this.now - this.input.fixTime) / 1000);
      if (this.input.locationValid !== false && !reupload && delaySec >= this.param('DATA_DELAYED', 'delayMin', 10) * 60 && delaySec < 7 * 86_400) {
        this.emit('DATA_DELAYED', { at: this.now, message: `Data arriving ${fmt(delaySec)} late (network / GPRS)`, data: { durationSec: delaySec } });
      }
    }

    // Clock: device time ahead of the server (wrong time zone on the tracker).
    const aheadSec = Math.round((this.input.fixTime - this.now) / 1000);
    if (this.input.locationValid !== false && aheadSec >= this.param('CLOCK_ERROR', 'thresholdMin', 15) * 60) {
      this.emit('CLOCK_ERROR', { at: this.now, message: `Device clock is ${fmt(aheadSec)} ahead — check the time zone setting`, data: { durationSec: aheadSec } });
    }
  }

  private pruneCooldowns(): void {
    for (const [k, at] of Object.entries(this.state.cd)) if (this.input.fixTime - at > COOLDOWN_PRUNE_MS) delete this.state.cd[k];
  }
}

/** Evaluate one position against all rules; mutates `state` in place and returns the alerts/visit changes. */
export function evaluatePosition(input: RuleInput, state: AlertState, ctx: EvalContext): EvalOutput {
  return new Evaluator(input, state, ctx).run();
}
